import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueChallenge, resolveChallenge, ChallengeOutcome } from '../src/challenge.js';
import {
  Shard, ShardResult, buildHonestSubmission, commitFullResult, challengeRows,
} from '../src/shard.js';
import { LAPTOP_IGPU, DeviceTier } from '../src/tiers.js';
import { buildMerkleTree, hashRow, proveInclusion, toHex } from '../src/merkle.js';

// LAPTOP_IGPU is real, measured hardware (107.2 GFLOPS -- docs/BUILD.md §1),
// which is exactly the problem for a unit test: sizing a shard against it
// for even a fraction of a second of real wall-clock produces n in the
// thousands, and *executing* that shard here means the pure-JS reference
// GEMM (referenceElement/rowValues), not real WebGPU. O(n^3) at n~3000 is
// tens of billions of scalar ops -- fine for the device it was measured on,
// hopeless for a headless test.
//
// So: tests of issueChallenge's SIZING behaviour use LAPTOP_IGPU directly
// and only inspect shard.n/sizing, never execute the result. Tests that
// need to actually solve a shard (buildHonestSubmission/commitFullResult)
// use a small hand-built Shard instead, exactly like shard.test.js and
// audit.test.js already do -- this file is testing resolveChallenge's
// logic, not re-measuring the reference device.
const SMALL_TIER = new DeviceTier({
  name: 'unit-test-tier', gflops: 20, dispatchOverheadMs: 1, measured: true,
});
const mkSmallShard = (o = {}) => new Shard({
  id: 'challenge-fixture', n: 32, sessionNonce: 'session-nonce-eeeeeeeeeeee', ...o,
});

// --------------------------------------------------------------------------
// issueChallenge -- sizing + fresh issuance, no queue involved (ADR-0012)
// --------------------------------------------------------------------------

test('issueChallenge sizes the shard from the tier, matching chooseShardSize directly', () => {
  const { shard, sizing } = issueChallenge(LAPTOP_IGPU, { targetWallSeconds: 2 });
  assert.equal(shard.n, sizing.n);
  assert.equal(shard.tierName, LAPTOP_IGPU.name);
});

test('issueChallenge mints a fresh nonce and id on every call', () => {
  const a = issueChallenge(LAPTOP_IGPU);
  const b = issueChallenge(LAPTOP_IGPU);
  assert.notEqual(a.shard.sessionNonce, b.shard.sessionNonce);
  assert.notEqual(a.shard.id, b.shard.id);
});

test('issueChallenge accepts a caller-supplied id', () => {
  const { shard } = issueChallenge(LAPTOP_IGPU, { id: 'fixed-id-123' });
  assert.equal(shard.id, 'fixed-id-123');
});

test('issueChallenge respects the sizing floor for a tight target', () => {
  // Same boundary case tiers.test.js exercises directly: an unreasonably
  // short target must not produce a shard that sells dispatch latency.
  const { shard, sizing } = issueChallenge(LAPTOP_IGPU, {
    targetWallSeconds: 0.001, maxOverheadFraction: 0.10,
  });
  assert.equal(shard.n, sizing.floorN);
  assert.equal(sizing.budgetExceeded, true);
});

test('issueChallenge works for any DeviceTier, not just the built-in reference', () => {
  const { shard } = issueChallenge(SMALL_TIER, { targetWallSeconds: 1 });
  assert.equal(shard.tierName, 'unit-test-tier');
});

test('issueChallenge on a small/slow tier produces a shard small enough to actually solve in a test', () => {
  // Sanity bound for the fixture itself (measured: n=512 costs ~1.5s to
  // fully solve in pure JS, the one end-to-end test below pays that once),
  // so a future edit to SMALL_TIER that silently makes it much "faster"
  // doesn't quietly turn this file back into the multi-minute hang this
  // comment block exists to prevent.
  const { shard } = issueChallenge(SMALL_TIER, { targetWallSeconds: 0.02 });
  assert.ok(shard.n <= 600, `fixture shard too large for a headless test: n=${shard.n}`);
});

// --------------------------------------------------------------------------
// resolveChallenge -- single-submission gate, admit/deny
// --------------------------------------------------------------------------

test('a genuine, honestly-computed response is admitted', async () => {
  const shard = mkSmallShard();
  const response = await buildHonestSubmission(shard, 'visitor-session-1');
  const r = await resolveChallenge(shard, response);
  assert.equal(r.outcome, ChallengeOutcome.ADMIT);
  assert.equal(r.gate.ok, true);
});

test('a garbage response is denied', async () => {
  const shard = mkSmallShard();
  const { rows } = await commitFullResult(shard);
  const badRows = rows.map((r, i) => (i === 0 ? new Float32Array(r.length).fill(-999) : r));
  // Rebuild against corrupted content so the tree is internally consistent
  // (a real attacker's best case), still caught by the ground-truth check.
  const leaves = await Promise.all(badRows.map(hashRow));
  const { root: badRoot, layers: badLayers } = await buildMerkleTree(leaves);
  const required = challengeRows(shard, badRoot);
  const reveal = required.map((idx) => ({
    index: idx,
    values: Array.from(badRows[idx]),
    proof: proveInclusion(badLayers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const response = new ShardResult({
    shardId: shard.id, workerId: 'bot', root: toHex(badRoot), rows: reveal,
  });
  const r = await resolveChallenge(shard, response);
  assert.equal(r.outcome, ChallengeOutcome.DENY);
  assert.equal(r.gate.ok, false);
});

test('a response for the wrong shard is denied', async () => {
  const issued = mkSmallShard({ id: 'issued', sessionNonce: 'session-nonce-eeeeeeeeeeee' });
  const other = mkSmallShard({ id: 'other', sessionNonce: 'session-nonce-ffffffffffff' });
  const response = await buildHonestSubmission(other, 'visitor');
  const r = await resolveChallenge(issued, response);
  assert.equal(r.outcome, ChallengeOutcome.DENY);
});

// --------------------------------------------------------------------------
// timingRatio -- signal, never a gate (ADR-0012)
// --------------------------------------------------------------------------

test('timingRatio is null when no timing data is supplied', async () => {
  const shard = mkSmallShard();
  const response = await buildHonestSubmission(shard, 'v1');
  const r = await resolveChallenge(shard, response);
  assert.equal(r.timingRatio, null);
});

test('timingRatio reflects elapsed time relative to the sizing target', async () => {
  const shard = mkSmallShard();
  const response = await buildHonestSubmission(shard, 'v1');
  const r = await resolveChallenge(shard, response, {
    expectedWallSeconds: 2, elapsedMs: 2000,
  });
  assert.ok(Math.abs(r.timingRatio - 1.0) < 1e-9, 'elapsed == expected must give ratio 1.0');
});

test('a suspiciously fast but cryptographically valid response is still admitted', async () => {
  // The property ADR-0012 insists on: timing is reported, never enforced.
  // A legitimate visitor's device may simply be faster than the sizing
  // reference -- conflating "fast" with "cheating" is exactly the mistake
  // consensus.js's timing-anomaly signal was already built to avoid.
  const shard = mkSmallShard();
  const response = await buildHonestSubmission(shard, 'fast-attacker');
  const r = await resolveChallenge(shard, response, {
    expectedWallSeconds: 2, elapsedMs: 1,   // absurdly fast
  });
  assert.equal(r.outcome, ChallengeOutcome.ADMIT,
    'cryptographic validity must decide admission, not elapsed time');
  assert.ok(r.timingRatio < 0.01, 'the anomaly must still be visible in the reported ratio');
});

// --------------------------------------------------------------------------
// End-to-end
// --------------------------------------------------------------------------

test('issue -> honest solve -> resolve is admitted end to end', async () => {
  const { shard, sizing } = issueChallenge(SMALL_TIER, { targetWallSeconds: 0.02 });
  assert.ok(sizing.overheadFraction <= 0.10 + 1e-9);
  const response = await buildHonestSubmission(shard, 'real-visitor');
  const r = await resolveChallenge(shard, response);
  assert.equal(r.outcome, ChallengeOutcome.ADMIT);
});
