import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextIdleMs } from '../src/governor.js';

/**
 * Simulate a session under the real control law.
 *
 * The point of these tests is the enforcement claim: the manifest declares a
 * ceiling, and the governor must hold the *session average* at or below it
 * even when individual bursts overshoot their budget. A per-burst controller
 * cannot do this, which is why the law is integral.
 *
 * @param {object} o
 * @param {number} o.target        declared share
 * @param {() => number} o.burstMs actual busy time per burst (may overshoot)
 * @param {number} o.cycles
 */
function simulate({ target, burstMs, cycles = 500 }) {
  let wall = 0, busy = 0;
  let peakShare = 0;
  const trace = [];
  for (let i = 0; i < cycles; i++) {
    const b = burstMs(i);
    busy += b;
    wall += b;
    const idle = nextIdleMs(busy, wall, target);
    wall += idle;
    const share = busy / wall;
    peakShare = Math.max(peakShare, share);
    trace.push({ i, share, idle });
  }
  return { share: busy / wall, peakShare, busy, wall, trace };
}

test('converges to the declared share with well-behaved bursts', () => {
  for (const target of [0.05, 0.25, 0.5]) {
    const r = simulate({ target, burstMs: () => 12 });
    assert.ok(Math.abs(r.share - target) < 1e-3,
      `target ${target}: converged to ${r.share.toFixed(4)}`);
  }
});

test('repays overshoot instead of averaging above the ceiling', () => {
  // Every burst overruns its 12 ms budget by 4x. A per-burst controller would
  // hold the instantaneous share at target and let the average drift up; the
  // integral law must claw it back.
  const target = 0.05;
  const r = simulate({ target, burstMs: () => 48 });
  assert.ok(r.share <= target * 1.02,
    `session share ${r.share.toFixed(4)} exceeded ceiling ${target}`);
});

test('a single pathological burst does not permanently inflate the average', () => {
  const target = 0.05;
  // One burst blocks for 2 full seconds, then behaviour returns to normal.
  const r = simulate({ target, burstMs: (i) => (i === 10 ? 2000 : 12), cycles: 3000 });
  assert.ok(r.share <= target * 1.02,
    `session share ${r.share.toFixed(4)} did not recover`);
});

test('never idles negatively, and respects the idle clamp', () => {
  // Wall already far ahead of what the target requires => no idle owed.
  assert.equal(nextIdleMs(10, 10_000, 0.05), 0);
  // Enormous debt must still be clamped so the session cannot stall for ever.
  assert.equal(nextIdleMs(1e9, 0, 0.05, 2000), 2000);
});

test('share is enforced from below, never overshooting mid-session', () => {
  // The peak instantaneous share over the whole session must not exceed the
  // ceiling by any meaningful margin -- transient spikes are what a user
  // actually notices.
  const target = 0.05;
  const r = simulate({ target, burstMs: (i) => 12 + (i % 7) * 3, cycles: 800 });
  // The first burst is unavoidably 100% share (no wall time has passed yet),
  // so measure the steady state after warm-up.
  const steady = r.trace.slice(20);
  const peak = Math.max(...steady.map((s) => s.share));
  assert.ok(peak <= target * 1.05,
    `peak steady-state share ${peak.toFixed(4)} exceeded ${target}`);
});

test('a lower target produces proportionally more idle time', () => {
  const tight = simulate({ target: 0.05, burstMs: () => 12 });
  const loose = simulate({ target: 0.50, burstMs: () => 12 });
  // Same work, so the tighter ceiling must take roughly 10x the wall clock.
  const ratio = tight.wall / loose.wall;
  assert.ok(ratio > 8 && ratio < 12,
    `expected ~10x wall-clock ratio, got ${ratio.toFixed(2)}`);
  assert.ok(Math.abs(tight.busy - loose.busy) < 1e-6,
    'the same amount of useful work should have been done either way');
});
