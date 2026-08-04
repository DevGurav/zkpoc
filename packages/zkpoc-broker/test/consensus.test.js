import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Verdict, ShardStatus, verifyReplica, tallyVerifiedReplicas, reachConsensus,
} from '../src/consensus.js';
import { Shard, buildHonestSubmission } from '../src/shard.js';
import { ShardQueue } from '../src/queue.js';

const mkShard = (o = {}) => new Shard({
  id: 's1', n: 32, sessionNonce: 'session-nonce-aaaaaaaaaaaa', ...o,
});

/** Build a submission guaranteed to fail the per-submission gate: a valid
 * Merkle tree over all-garbage rows, which passes structural checks
 * (ShardResult construction, Merkle inclusion) but fails the ground-truth
 * spot-check on every required row. */
async function buildGarbageSubmission(shard, workerId) {
  const { buildMerkleTree, hashRow, proveInclusion, toHex } =
    await import('../src/merkle.js');
  const { challengeRows } = await import('../src/shard.js');
  const { ShardResult } = await import('../src/shard.js');

  const rows = [];
  const leaves = [];
  for (let i = 0; i < shard.n; i++) {
    const row = new Float32Array(shard.n).fill(0);
    rows.push(row);
    leaves.push(await hashRow(row));
  }
  const { root, layers } = await buildMerkleTree(leaves);
  const required = challengeRows(shard, root);
  const revealed = required.map((idx) => ({
    index: idx,
    values: Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  return new ShardResult({ shardId: shard.id, workerId, root: toHex(root), rows: revealed });
}

// --------------------------------------------------------------------------
// tallyVerifiedReplicas -- pure tally/majority/dispute logic, tested against
// hand-built verdict records rather than real cryptographic roots. See the
// function's own docstring for why: constructing two genuinely-different
// roots that BOTH pass the gate for one shard needs an adversarial search,
// which would make these tests fragile for reasons unrelated to the tally
// logic itself.
// --------------------------------------------------------------------------

const ok = (workerId, root, extra = {}) => ({ workerId, root, gate: { ok: true }, ...extra });
const bad = (workerId, extra = {}) => ({ workerId, root: 'n/a', gate: { ok: false }, ...extra });

test('two valid replicas agreeing on a root are both confirmed', () => {
  const r = tallyVerifiedReplicas([ok('w1', 'R'), ok('w2', 'R')]);
  assert.equal(r.status, ShardStatus.CONFIRMED);
  assert.equal(r.confirmedRoot, 'R');
  assert.equal(r.replicas.every((x) => x.verdict === Verdict.CONFIRMED), true);
  assert.deepEqual(r.minorityWorkers, []);
  assert.deepEqual(r.rejectedWorkers, []);
});

test('two valid replicas disagreeing (1v1) is a dispute, not a coin-flip confirmation', () => {
  const r = tallyVerifiedReplicas([ok('w1', 'A'), ok('w2', 'B')]);
  assert.equal(r.status, ShardStatus.DISPUTED);
  assert.equal(r.confirmedRoot, null, 'a tie must not expose a root as if it were confirmed');
  assert.equal(r.replicas.every((x) => x.verdict === Verdict.MINORITY), true);
  assert.deepEqual(new Set(r.minorityWorkers), new Set(['w1', 'w2']));
});

test('three replicas, two agreeing and one differing, confirm the majority', () => {
  const r = tallyVerifiedReplicas([ok('w1', 'R'), ok('w2', 'R'), ok('w3', 'X')]);
  assert.equal(r.status, ShardStatus.CONFIRMED);
  assert.equal(r.confirmedRoot, 'R');
  assert.deepEqual(r.minorityWorkers, ['w3']);
  const w3 = r.replicas.find((x) => x.workerId === 'w3');
  assert.equal(w3.verdict, Verdict.MINORITY);
});

test('every replica failing the gate yields no valid replicas, not a false confirmation', () => {
  const r = tallyVerifiedReplicas([bad('w1'), bad('w2'), bad('w3')]);
  assert.equal(r.status, ShardStatus.NO_VALID_REPLICAS);
  assert.equal(r.confirmedRoot, null);
  assert.deepEqual(new Set(r.rejectedWorkers), new Set(['w1', 'w2', 'w3']));
  assert.equal(r.replicas.every((x) => x.verdict === Verdict.REJECTED), true);
});

test('a gate failure is excluded from the majority computation entirely', () => {
  // 1 invalid + 2 valid-agreeing must confirm on the 2, not be dragged into
  // a 2-of-3 framing that could ever read as anything but decisive.
  const r = tallyVerifiedReplicas([bad('liar'), ok('w1', 'R'), ok('w2', 'R')]);
  assert.equal(r.status, ShardStatus.CONFIRMED);
  assert.equal(r.confirmedRoot, 'R');
  assert.deepEqual(r.rejectedWorkers, ['liar']);
  assert.deepEqual(r.minorityWorkers, []);
});

test('zero replicas is insufficient, not any other status', () => {
  const r = tallyVerifiedReplicas([]);
  assert.equal(r.status, ShardStatus.INSUFFICIENT);
  assert.deepEqual(r.replicas, []);
  assert.equal(r.confirmedRoot, null);
});

test('a single valid replica is unconfirmed, not confirmed -- nothing cross-checked it', () => {
  const r = tallyVerifiedReplicas([ok('w1', 'R')]);
  assert.equal(r.status, ShardStatus.INSUFFICIENT);
  assert.equal(r.confirmedRoot, null,
    'confirmedRoot must stay null even though the lone submission is individually valid');
  assert.equal(r.replicas[0].verdict, Verdict.UNCONFIRMED);
});

test('a single invalid replica is insufficient AND rejected', () => {
  const r = tallyVerifiedReplicas([bad('w1')]);
  assert.equal(r.status, ShardStatus.INSUFFICIENT);
  assert.deepEqual(r.rejectedWorkers, ['w1']);
  assert.equal(r.replicas[0].verdict, Verdict.REJECTED);
});

test('an exact 2-of-4 tie is disputed, not confirmed', () => {
  const r = tallyVerifiedReplicas([ok('w1', 'A'), ok('w2', 'A'), ok('w3', 'B'), ok('w4', 'B')]);
  assert.equal(r.status, ShardStatus.DISPUTED);
  assert.equal(r.confirmedRoot, null);
});

test('majorityFraction is configurable and enforced strictly', () => {
  // 2-of-3 = 0.667, which clears the default 0.5 threshold...
  const loose = tallyVerifiedReplicas([ok('w1', 'R'), ok('w2', 'R'), ok('w3', 'X')]);
  assert.equal(loose.status, ShardStatus.CONFIRMED);

  // ...but not a supermajority requirement of 0.7.
  const strict = tallyVerifiedReplicas(
    [ok('w1', 'R'), ok('w2', 'R'), ok('w3', 'X')], { majorityFraction: 0.7 });
  assert.equal(strict.status, ShardStatus.DISPUTED);
});

test('a timing anomaly is advisory only -- it does not downgrade an otherwise-confirmed verdict', () => {
  // This is the property the module docstring insists on: fast hardware is
  // not evidence of cheating on its own, only evidence worth surfacing.
  const r = tallyVerifiedReplicas([
    ok('w1', 'R', { timingAnomaly: true }),
    ok('w2', 'R'),
  ]);
  assert.equal(r.status, ShardStatus.CONFIRMED);
  assert.equal(r.replicas.find((x) => x.workerId === 'w1').verdict, Verdict.CONFIRMED,
    'timing anomaly must not itself demote a cryptographically-confirmed replica');
  assert.deepEqual(r.timingAnomalies, ['w1']);
});

// --------------------------------------------------------------------------
// verifyReplica -- the per-submission gate + advisory timing check, wired to
// real shard.js/merkle.js cryptography.
// --------------------------------------------------------------------------

test('verifyReplica reports gate.ok true for an honest submission', async () => {
  const s = mkShard();
  const result = await buildHonestSubmission(s, 'w1');
  const v = await verifyReplica(s, result);
  assert.equal(v.gate.ok, true);
  assert.equal(v.root, result.root);
  assert.equal(v.workerId, 'w1');
});

test('verifyReplica reports gate.ok false for a garbage submission', async () => {
  const s = mkShard();
  const result = await buildGarbageSubmission(s, 'liar');
  const v = await verifyReplica(s, result);
  assert.equal(v.gate.ok, false);
});

test('verifyReplica accepts both a raw ShardResult and a queue-style {result, elapsedMs} entry', async () => {
  const s = mkShard();
  const result = await buildHonestSubmission(s, 'w1');

  const fromRaw = await verifyReplica(s, result);
  const fromEntry = await verifyReplica(s, { result, elapsedMs: 42 });

  assert.equal(fromRaw.gate.ok, true);
  assert.equal(fromEntry.gate.ok, true);
  assert.equal(fromEntry.elapsedMs, 42);
  assert.equal(fromRaw.elapsedMs, null, 'no timing source was given for the raw case');
});

test('verifyReplica flags an implausibly fast submission without failing the gate', async () => {
  const s = mkShard();
  const result = await buildHonestSubmission(s, 'w1');
  const v = await verifyReplica(s, { result, elapsedMs: 0 });
  assert.equal(v.gate.ok, true, 'timing must not be conflated with cryptographic validity');
  assert.equal(v.timingAnomaly, true);
});

test('verifyReplica does not flag a plausible elapsed time', async () => {
  const s = mkShard();
  const result = await buildHonestSubmission(s, 'w1');
  const v = await verifyReplica(s, { result, elapsedMs: 5000 });
  assert.equal(v.timingAnomaly, false);
});

// --------------------------------------------------------------------------
// reachConsensus -- end to end
// --------------------------------------------------------------------------

test('two independently-honest workers on the same shard confirm on their shared root', async () => {
  const s = mkShard();
  const a = await buildHonestSubmission(s, 'a');
  const b = await buildHonestSubmission(s, 'b');
  const r = await reachConsensus(s, [a, b]);
  assert.equal(r.status, ShardStatus.CONFIRMED);
  assert.equal(r.confirmedRoot, a.root);
  assert.equal(a.root, b.root, 'sanity: independent honest computation must converge');
});

test('one honest worker and one garbage worker still confirms, rejecting only the liar', async () => {
  const s = mkShard();
  const honest = await buildHonestSubmission(s, 'honest');
  const garbage = await buildGarbageSubmission(s, 'liar');
  const r = await reachConsensus(s, [honest, garbage]);
  assert.equal(r.status, ShardStatus.CONFIRMED);
  assert.equal(r.confirmedRoot, honest.root);
  assert.deepEqual(r.rejectedWorkers, ['liar']);
});

test('reachConsensus works directly against ShardQueue.resultsFor()\'s entry shape', async () => {
  const q = new ShardQueue({ redundancy: 2 });
  const shard = q.createShard({ n: 32 });
  q.assign('a');
  q.assign('b');
  q.submit(await buildHonestSubmission(shard, 'a'));
  q.submit(await buildHonestSubmission(shard, 'b'));

  const entries = q.resultsFor(shard.id);   // {result, assignedAt, submittedAt, elapsedMs}[]
  assert.equal(entries.length, 2);
  assert.ok('elapsedMs' in entries[0], 'sanity: confirms we are testing against the real shape');

  const r = await reachConsensus(shard, entries);
  assert.equal(r.status, ShardStatus.CONFIRMED);
});
