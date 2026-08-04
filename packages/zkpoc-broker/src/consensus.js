/**
 * Redundancy consensus over a shard's replica results.
 *
 * Two layers, run in order, that check different things and must not be
 * conflated:
 *
 *   1. PER-SUBMISSION GATE -- verifyRowSubmission() (ADR-0011). A submission
 *      that fails this is unambiguous: either the worker never computed the
 *      required rows, or it forged values that don't match ground truth.
 *      Rejected outright, no cross-worker comparison needed.
 *
 *   2. CROSS-WORKER AGREEMENT -- among submissions that passed the gate,
 *      compare committed Merkle roots. Root agreement across >=2
 *      independent workers is strong evidence, not just "looks plausible":
 *      per ADR-0011, forging a root without the full O(n^3) computation is
 *      already probabilistically hard (evasion chance f^k on a single
 *      submission), so two independent workers agreeing on a full root is
 *      correspondingly stronger than two workers agreeing on a handful of
 *      sample points ever was.
 *
 * WHAT THIS DOES NOT DO
 * ----------------------
 * Resolve disagreement when valid-but-different roots are submitted. With
 * two replicas that disagree, consensus alone cannot know which one is
 * honest -- both independently passed the same probabilistic gate. That is
 * an unresolved DISPUTE, surfaced for audit escalation (M2.4's ZK sampler,
 * or M3's proof layer), not something a bigger redundancy factor makes free.
 * Do not read "confirmed" as "proven"; it is "no evidence found against, and
 * at least one other independent party agrees."
 *
 * FREE-RIDER DETECTION
 * ---------------------
 * Two distinct signals, reported separately because they carry different
 * weight:
 *   - GATE FAILURE is unambiguous free-riding (or a broken client).
 *   - MINORITY ROOT (passed the gate, but disagrees with the confirmed
 *     majority) is suspicious but not proven -- could be a partial cheat
 *     that got a lucky challenge draw, could be an honest divergent bug.
 *   - TIMING ANOMALY (elapsedMs implausibly low even for a generous
 *     reference throughput) is advisory metadata only, and is NOT used to
 *     reject a submission that already passed the cryptographic gate. Fast
 *     hardware is not cheating; conflating the two would prejudge the exact
 *     question M2.5's attacker-advantage-ratio measurement exists to answer.
 */

import { verifyRowSubmission } from './shard.js';

export const Verdict = Object.freeze({
  CONFIRMED: 'confirmed',       // passed the gate, root matches the shard's majority
  MINORITY: 'minority',         // passed the gate, root does NOT match the majority
  REJECTED: 'rejected',         // failed the gate outright
  UNCONFIRMED: 'unconfirmed',   // passed the gate, but no second party to cross-check against
});

export const ShardStatus = Object.freeze({
  CONFIRMED: 'confirmed',           // a clear majority root among valid submissions
  DISPUTED: 'disputed',             // >=2 valid roots, no clear majority
  NO_VALID_REPLICAS: 'no_valid_replicas', // every submission failed the gate
  INSUFFICIENT: 'insufficient',     // fewer than 2 submissions -- nothing to cross-check
});

/** Reference throughput used only to flag implausibly fast submissions.
 * Deliberately generous -- above every device tier in bench/breakeven.py's
 * DEFAULT_TIERS (desktop-dgpu tops out at 5000 GFLOPS) -- because this is an
 * anomaly SIGNAL, not a rejection threshold. See the module docstring: being
 * fast is not evidence of cheating, only being faster than physically
 * plausible hardware is. */
export const TIMING_FLOOR_GFLOPS = 10_000;

function impossibleBelowMs(shard) {
  return (shard.flops / (TIMING_FLOOR_GFLOPS * 1e9)) * 1000;
}

/**
 * Verify one replica against the per-submission gate, plus advisory timing.
 *
 * Accepts either a raw ShardResult or the richer entry shape ShardQueue's
 * resultsFor() returns ({result, elapsedMs, ...}), since that is the
 * realistic call site -- timing data lives on the queue's record, not on
 * the result itself.
 *
 * @param {Shard} shard
 * @param {ShardResult|{result:ShardResult, elapsedMs?:number}} entry
 * @param {object} [o]  forwarded to verifyRowSubmission (k, tolerance, ...)
 * @returns {Promise<{workerId:string, root:string, gate:object,
 *                     timingAnomaly:boolean, elapsedMs:number|null}>}
 */
export async function verifyReplica(shard, entry, o = {}) {
  const result = entry.result ?? entry;
  const elapsedMs = entry.elapsedMs ?? result.reportedMs ?? null;
  const gate = await verifyRowSubmission(shard, result, o);
  const floor = impossibleBelowMs(shard);
  return {
    workerId: result.workerId,
    root: result.root,
    gate,
    elapsedMs,
    timingAnomaly: elapsedMs !== null && elapsedMs < floor,
    timingFloorMs: floor,
  };
}

/**
 * Tally already-verified replica records into a shard-level verdict.
 *
 * Pulled out as a pure function, deliberately, so the majority/dispute/tie
 * logic can be tested directly against hand-built `{workerId, root,
 * gate:{ok}}` records -- without needing real Merkle trees or an adversarial
 * search to construct two genuinely-different-but-both-valid roots for a
 * fixed shard, which is expensive to engineer as a test fixture and would
 * make the tally logic's own tests fragile for reasons unrelated to the
 * logic being tested. See test/consensus.test.js.
 *
 * @param {Array<{workerId:string, root:string, gate:{ok:boolean},
 *                 timingAnomaly?:boolean}>} checked
 * @param {object} [o]
 * @param {number} [o.majorityFraction=0.5]  strictly-greater-than threshold
 *   among VALID entries for a root to count as the confirmed majority
 */
export function tallyVerifiedReplicas(checked, o = {}) {
  const majorityFraction = o.majorityFraction ?? 0.5;

  if (checked.length < 2) {
    const only = checked[0] ?? null;
    return {
      status: ShardStatus.INSUFFICIENT,
      confirmedRoot: null,
      replicas: only
        ? [{ ...only, verdict: only.gate.ok ? Verdict.UNCONFIRMED : Verdict.REJECTED }]
        : [],
      rejectedWorkers: only && !only.gate.ok ? [only.workerId] : [],
      minorityWorkers: [],
      timingAnomalies: only?.timingAnomaly ? [only.workerId] : [],
    };
  }

  const valid = checked.filter((c) => c.gate.ok);
  const invalid = checked.filter((c) => !c.gate.ok);

  if (valid.length === 0) {
    return {
      status: ShardStatus.NO_VALID_REPLICAS,
      confirmedRoot: null,
      replicas: checked.map((c) => ({ ...c, verdict: Verdict.REJECTED })),
      rejectedWorkers: checked.map((c) => c.workerId),
      minorityWorkers: [],
      timingAnomalies: checked.filter((c) => c.timingAnomaly).map((c) => c.workerId),
    };
  }

  // Tally valid submissions by root. Ties are not broken arbitrarily -- a
  // root only counts as the majority if it strictly exceeds
  // majorityFraction of the valid pool, e.g. 1-of-2 valid roots that
  // disagree (50/50) is a DISPUTE, not a coin-flip confirmation.
  const counts = new Map();
  for (const c of valid) counts.set(c.root, (counts.get(c.root) ?? 0) + 1);

  let confirmedRoot = null;
  let topCount = 0;
  for (const [root, count] of counts) {
    if (count > topCount) { topCount = count; confirmedRoot = root; }
  }
  const isMajority = topCount / valid.length > majorityFraction;

  const status = isMajority ? ShardStatus.CONFIRMED : ShardStatus.DISPUTED;
  const effectiveRoot = isMajority ? confirmedRoot : null;

  const replicas = checked.map((c) => {
    if (!c.gate.ok) return { ...c, verdict: Verdict.REJECTED };
    if (isMajority && c.root === confirmedRoot) return { ...c, verdict: Verdict.CONFIRMED };
    return { ...c, verdict: Verdict.MINORITY };
  });

  return {
    status,
    confirmedRoot: effectiveRoot,
    replicas,
    rejectedWorkers: invalid.map((c) => c.workerId),
    minorityWorkers: replicas.filter((r) => r.verdict === Verdict.MINORITY).map((r) => r.workerId),
    timingAnomalies: checked.filter((c) => c.timingAnomaly).map((c) => c.workerId),
  };
}

/**
 * Reach consensus over a shard's full replica set: verify every submission
 * against the per-submission gate, then tally.
 *
 * @param {Shard} shard
 * @param {Array<ShardResult|{result:ShardResult, elapsedMs?:number}>} entries
 * @param {object} [o]
 * @param {number} [o.k]                forwarded to verifyRowSubmission
 * @param {number} [o.tolerance]        forwarded to verifyRowSubmission
 * @param {number} [o.majorityFraction] forwarded to tallyVerifiedReplicas
 * @returns {Promise<{status:string, confirmedRoot:string|null,
 *                     replicas:Array<object & {verdict:string}>,
 *                     rejectedWorkers:string[], minorityWorkers:string[],
 *                     timingAnomalies:string[]}>}
 */
export async function reachConsensus(shard, entries, o = {}) {
  const checked = await Promise.all(entries.map((e) => verifyReplica(shard, e, o)));
  return tallyVerifiedReplicas(checked, o);
}
