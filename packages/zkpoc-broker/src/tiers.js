/**
 * Device tiers and shard sizing.
 *
 * Shard size is not a tuning knob. Every WebGPU dispatch pays a fixed cost --
 * command encoding, submission, and the `onSubmittedWorkDone()` fence -- that
 * is independent of how much arithmetic the dispatch contains. Measured on the
 * reference device that cost is ~4ms, which at N=256 is 91.6% of the total
 * time: a small shard measures the fence, not the machine. Sizing shards below
 * the amortisation floor means selling latency and calling it compute.
 *
 * See docs/BUILD.md section 1 for the measured constants, and
 * docs/adr/0010-sustained-trend-fit-not-quick-sweep.md for why the throughput
 * figure here is a sustained-run number rather than a quick-sweep one.
 */

/**
 * A device tier the broker knows how to size work for.
 *
 * `measured` is not decoration. The one tier measured so far came in 11x below
 * its literature-anchored placeholder, and the first attempt to correct that
 * was *also* wrong -- so a placeholder is treated as "unknown", not as
 * "approximately right". Sizing decisions must degrade rather than guess.
 */
export class DeviceTier {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {number} o.gflops              sustained throughput, NOT peak
   * @param {number} o.dispatchOverheadMs  fixed per-dispatch cost
   * @param {boolean} [o.measured=false]   true only if both came from hardware
   */
  constructor({ name, gflops, dispatchOverheadMs, measured = false }) {
    if (!(gflops > 0)) throw new RangeError(`${name}: gflops must be > 0`);
    if (!(dispatchOverheadMs >= 0)) {
      throw new RangeError(`${name}: dispatchOverheadMs must be >= 0`);
    }
    this.name = name;
    this.gflops = gflops;
    this.dispatchOverheadMs = dispatchOverheadMs;
    this.measured = measured;
    Object.freeze(this);
  }

  /** FLOPs for one n x n GEMM shard. Matches kernels.js#flopsPerShard. */
  static flops(n) {
    return 2 * n ** 3;
  }

  /** Seconds of pure compute for an n x n shard on this tier. */
  computeSeconds(n) {
    return DeviceTier.flops(n) / (this.gflops * 1e9);
  }

  /** Wall-clock seconds including the fixed dispatch cost. */
  wallSeconds(n) {
    return this.dispatchOverheadMs / 1000 + this.computeSeconds(n);
  }

  /** Fraction of wall time spent on dispatch overhead rather than work. */
  overheadFraction(n) {
    const wall = this.wallSeconds(n);
    return wall > 0 ? this.dispatchOverheadMs / 1000 / wall : 1;
  }

  /**
   * Smallest n whose overhead fraction is at or below `maxFraction`.
   *
   * overhead / (overhead + compute) <= f
   *   => compute >= overhead * (1 - f) / f
   *   => 2n^3 / gflops >= ...
   */
  minShardN(maxFraction = 0.10) {
    if (!(maxFraction > 0 && maxFraction < 1)) {
      throw new RangeError('maxFraction must be in (0, 1)');
    }
    const overheadS = this.dispatchOverheadMs / 1000;
    if (overheadS === 0) return 1;
    const minComputeS = overheadS * (1 - maxFraction) / maxFraction;
    return Math.ceil(Math.cbrt(minComputeS * this.gflops * 1e9 / 2));
  }

  /** Shard size that fills `targetSeconds` of wall clock in one dispatch. */
  shardNForWallTime(targetSeconds) {
    const computeS = targetSeconds - this.dispatchOverheadMs / 1000;
    if (computeS <= 0) return 0;
    return Math.floor(Math.cbrt(computeS * this.gflops * 1e9 / 2));
  }
}

/**
 * The reference tier. Both figures are measured on real hardware --
 * Intel Gen-12LP / Iris Xe, Chrome 150, Windows.
 *
 * gflops is the sustained-steady OLS figure (107.2), NOT the 92.58 regression
 * fit from the same multi-size sweep that produced the overhead constant. The
 * regression's throughput term is warmup-biased low because it was fit from
 * quick-sweep medians; the overhead term is not, because a fixed per-dispatch
 * cost is not thermally sensitive. Taking one number from each is deliberate.
 */
export const LAPTOP_IGPU = new DeviceTier({
  name: 'laptop-igpu',
  gflops: 107.2,
  dispatchOverheadMs: 4.014,
  measured: true,
});

/** Tiers the broker will size work for. Only measured ones belong here. */
export const KNOWN_TIERS = Object.freeze(
  new Map([[LAPTOP_IGPU.name, LAPTOP_IGPU]]));

/**
 * Thrown when sizing is requested for a tier with no measurement.
 *
 * A dedicated error type rather than a null return, because the caller has a
 * real decision to make -- degrade the client, run a probe, or reject the
 * assignment -- and silently substituting a placeholder would reintroduce
 * exactly the failure mode docs/device-tiers.md documents.
 */
export class UnmeasuredTierError extends Error {
  constructor(tierName, known) {
    super(`no measurement for tier '${tierName}'. ` +
          `Known tiers: ${known.join(', ') || '(none)'}. ` +
          `Run bench/device/probe.html in sustained mode and add the result ` +
          `to bench/device/measurements/ before sizing work for this device.`);
    this.name = 'UnmeasuredTierError';
    this.tierName = tierName;
  }
}

/**
 * Resolve a tier by name, refusing to guess.
 *
 * @param {string} name
 * @param {Map<string, DeviceTier>} [tiers]
 * @returns {DeviceTier}
 * @throws {UnmeasuredTierError}
 */
export function resolveTier(name, tiers = KNOWN_TIERS) {
  const tier = tiers.get(name);
  if (!tier) throw new UnmeasuredTierError(name, [...tiers.keys()]);
  return tier;
}

/**
 * Choose a shard size for a tier, honouring both constraints at once.
 *
 * Two pressures act in opposite directions:
 *   - too small, and dispatch overhead dominates (the N=256 failure mode)
 *   - too large, and a single shard overruns the time budget, which for a
 *     challenge means a user waiting and for barter means coarse preemption
 *
 * When they conflict -- the overhead floor needs more time than the budget
 * allows -- overhead wins and the caller is told, rather than quietly
 * returning a size that sells latency. A challenge that takes slightly longer
 * is a UX cost; a challenge that measures the fence is a broken product.
 *
 * @param {DeviceTier} tier
 * @param {object} [o]
 * @param {number} [o.targetWallSeconds=2]  desired wall clock per shard
 * @param {number} [o.maxOverheadFraction=0.10]
 * @param {number} [o.granularity=64]  round down to a multiple of this
 * @returns {{n:number, wallSeconds:number, overheadFraction:number,
 *            budgetExceeded:boolean, floorN:number}}
 */
export function chooseShardSize(tier, o = {}) {
  const {
    targetWallSeconds = 2,
    maxOverheadFraction = 0.10,
    granularity = 64,
  } = o;

  const floorN = tier.minShardN(maxOverheadFraction);
  const budgetN = tier.shardNForWallTime(targetWallSeconds);

  // Round to a workgroup-friendly multiple, but never below the floor.
  const roundDown = (v) => Math.max(granularity, Math.floor(v / granularity) * granularity);

  let n;
  let budgetExceeded = false;
  if (budgetN < floorN) {
    n = floorN;                 // overhead floor wins; report the overrun
    budgetExceeded = true;
  } else {
    n = roundDown(budgetN);
    if (n < floorN) n = floorN;
  }

  return {
    n,
    wallSeconds: tier.wallSeconds(n),
    overheadFraction: tier.overheadFraction(n),
    budgetExceeded,
    floorN,
  };
}
