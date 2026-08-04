import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeviceTier, LAPTOP_IGPU, KNOWN_TIERS, resolveTier,
  UnmeasuredTierError, chooseShardSize,
} from '../src/tiers.js';

// --------------------------------------------------------------------------
// The measured constants must survive contact with the sizing code.
// These assert against docs/BUILD.md section 1 -- if someone edits a constant,
// the mismatch surfaces here rather than silently changing shard sizes.
// --------------------------------------------------------------------------

test('reference tier carries the measured constants from BUILD.md', () => {
  assert.equal(LAPTOP_IGPU.gflops, 107.2, 'sustained OLS figure, not the 92.58 regression fit');
  assert.equal(LAPTOP_IGPU.dispatchOverheadMs, 4.014);
  assert.equal(LAPTOP_IGPU.measured, true);
});

test('reproduces the measured overhead fractions across matrix sizes', () => {
  // From bench/dispatch_analysis.py on the same device. The throughput figure
  // differs (sustained vs regression fit) so these are close, not identical --
  // the point is that the N=256 case is catastrophic and N=1024 is tolerable.
  assert.ok(LAPTOP_IGPU.overheadFraction(256) > 0.85,
    `N=256 should be overhead-dominated, got ${LAPTOP_IGPU.overheadFraction(256)}`);
  assert.ok(LAPTOP_IGPU.overheadFraction(1024) < 0.25,
    `N=1024 should be mostly compute, got ${LAPTOP_IGPU.overheadFraction(1024)}`);
  assert.ok(LAPTOP_IGPU.overheadFraction(256) > LAPTOP_IGPU.overheadFraction(1024));
});

test('minShardN lands near the documented N>=1187 floor', () => {
  const floor = LAPTOP_IGPU.minShardN(0.10);
  // BUILD.md records 1187 from the regression-fit throughput; this uses the
  // sustained figure, so allow a band rather than pinning an exact value.
  assert.ok(floor > 1000 && floor < 1400,
    `expected the 10% floor near ~1200, got ${floor}`);
  assert.ok(LAPTOP_IGPU.overheadFraction(floor) <= 0.10 + 1e-9,
    'the returned floor must actually satisfy the constraint it solves for');
});

test('a stricter overhead target demands a larger shard', () => {
  assert.ok(LAPTOP_IGPU.minShardN(0.05) > LAPTOP_IGPU.minShardN(0.10));
  assert.ok(LAPTOP_IGPU.minShardN(0.10) > LAPTOP_IGPU.minShardN(0.25));
});

test('a device with no dispatch overhead has no amortisation floor', () => {
  const ideal = new DeviceTier({
    name: 'ideal', gflops: 100, dispatchOverheadMs: 0, measured: false,
  });
  assert.equal(ideal.minShardN(0.10), 1);
  assert.equal(ideal.overheadFraction(64), 0);
});

// --------------------------------------------------------------------------
// Refusing to guess
// --------------------------------------------------------------------------

test('resolveTier refuses unmeasured tiers instead of substituting a default', () => {
  assert.throws(
    () => resolveTier('desktop-dgpu'),
    (err) => {
      assert.ok(err instanceof UnmeasuredTierError);
      assert.equal(err.tierName, 'desktop-dgpu');
      // The message must tell the caller how to fix it, not just that it failed.
      assert.match(err.message, /probe\.html/);
      assert.match(err.message, /sustained/);
      return true;
    },
    'sizing for an unmeasured tier must fail loudly -- see docs/device-tiers.md');
});

test('resolveTier returns the measured tier', () => {
  assert.equal(resolveTier('laptop-igpu'), LAPTOP_IGPU);
});

test('only measured tiers are registered', () => {
  for (const [name, tier] of KNOWN_TIERS) {
    assert.equal(tier.measured, true, `${name} is registered but not measured`);
  }
});

test('tier construction rejects impossible values', () => {
  assert.throws(() => new DeviceTier({ name: 'x', gflops: 0, dispatchOverheadMs: 1 }), RangeError);
  assert.throws(() => new DeviceTier({ name: 'x', gflops: -1, dispatchOverheadMs: 1 }), RangeError);
  assert.throws(() => new DeviceTier({ name: 'x', gflops: 1, dispatchOverheadMs: -1 }), RangeError);
});

test('tiers are immutable once constructed', () => {
  assert.throws(() => { LAPTOP_IGPU.gflops = 1; }, TypeError);
});

// --------------------------------------------------------------------------
// Shard sizing: the two constraints, and what happens when they conflict
// --------------------------------------------------------------------------

test('chooseShardSize honours both the overhead floor and the time budget', () => {
  const r = chooseShardSize(LAPTOP_IGPU, { targetWallSeconds: 2, maxOverheadFraction: 0.10 });
  assert.ok(r.n >= r.floorN, 'never returns a size below the amortisation floor');
  assert.ok(r.overheadFraction <= 0.10 + 1e-9);
  assert.ok(r.wallSeconds <= 2.05, `expected ~2s, got ${r.wallSeconds}`);
  assert.equal(r.budgetExceeded, false);
});

test('when the budget is too tight, overhead wins and the caller is told', () => {
  // The two constraints conflict only when the budget is smaller than the
  // overhead can amortise into: overhead / budget > maxOverheadFraction, i.e.
  // budget < overheadMs / maxFraction ~= 4.014ms / 0.10 ~= 40ms. Pick a budget
  // comfortably inside that, or the test asserts a conflict that isn't there.
  const conflictThresholdS = (LAPTOP_IGPU.dispatchOverheadMs / 1000) / 0.10;
  const tightBudget = conflictThresholdS / 2;
  assert.ok(tightBudget < conflictThresholdS, 'sanity: budget must be inside the conflict band');

  const r = chooseShardSize(LAPTOP_IGPU, {
    targetWallSeconds: tightBudget, maxOverheadFraction: 0.10,
  });
  assert.equal(r.budgetExceeded, true, 'the conflict must be reported, not hidden');
  assert.equal(r.n, r.floorN, 'falls back to the floor rather than the budget');
  assert.ok(r.overheadFraction <= 0.10 + 1e-9);
  assert.ok(r.wallSeconds > tightBudget,
    'and the overrun is visible in the returned wall time');
});

test('a budget just above the conflict threshold does not report an overrun', () => {
  // Guards the boundary from the other side: if this also reported
  // budgetExceeded, the flag would be meaningless noise rather than a signal.
  const conflictThresholdS = (LAPTOP_IGPU.dispatchOverheadMs / 1000) / 0.10;
  const r = chooseShardSize(LAPTOP_IGPU, {
    targetWallSeconds: conflictThresholdS * 4, maxOverheadFraction: 0.10,
  });
  assert.equal(r.budgetExceeded, false);
});

test('a longer budget yields a larger shard', () => {
  const short = chooseShardSize(LAPTOP_IGPU, { targetWallSeconds: 2 });
  const long = chooseShardSize(LAPTOP_IGPU, { targetWallSeconds: 8 });
  assert.ok(long.n > short.n);
  assert.ok(long.wallSeconds > short.wallSeconds);
});

test('shard sizes respect the workgroup granularity', () => {
  const r = chooseShardSize(LAPTOP_IGPU, { targetWallSeconds: 4, granularity: 64 });
  // Either an exact multiple, or the floor (which is not rounded, by design).
  assert.ok(r.n % 64 === 0 || r.n === r.floorN,
    `${r.n} is neither a multiple of 64 nor the floor ${r.floorN}`);
});

test('shardNForWallTime returns 0 when overhead alone exceeds the budget', () => {
  // 1ms budget against a 4ms fixed cost: no shard size can fit.
  assert.equal(LAPTOP_IGPU.shardNForWallTime(0.001), 0);
});
