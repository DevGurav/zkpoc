import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Shard, ShardResult, seedFromNonce, challengeRows, commitFullResult,
  buildHonestSubmission, verifyRowSubmission,
  DEFAULT_TOLERANCE, DEFAULT_CHALLENGE_ROWS,
} from '../src/shard.js';
import { hashRow, buildMerkleTree, proveInclusion, toHex } from '../src/merkle.js';

const NONCE_A = 'session-nonce-aaaaaaaaaaaa';
const NONCE_B = 'session-nonce-bbbbbbbbbbbb';

const mkShard = (o = {}) => new Shard({
  id: 's1', n: 32, sessionNonce: NONCE_A, tierName: 'laptop-igpu', ...o,
});

// Everything in this file uses fixed literal nonces, not freshNonce()'s
// CSPRNG -- so despite the security argument being probabilistic in general,
// every test outcome here is fully deterministic and reproducible: no flake
// risk, because there is no real randomness anywhere in these test vectors.

// --------------------------------------------------------------------------
// Determinism -- without it, verification has no ground truth to check against
// --------------------------------------------------------------------------

test('the same descriptor always yields the same inputs', () => {
  const a = mkShard();
  const b = mkShard();
  assert.equal(a.seed, b.seed);
  for (const [i, j] of [[0, 0], [3, 7], [31, 31]]) {
    assert.equal(a.elemA(i, j), b.elemA(i, j));
    assert.equal(a.elemB(i, j), b.elemB(i, j));
  }
});

test('materialize agrees with element-wise access', () => {
  const s = mkShard({ n: 16 });
  const { A, B } = s.materialize();
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      assert.equal(A[i * 16 + j], Math.fround(s.elemA(i, j)));
      assert.equal(B[i * 16 + j], Math.fround(s.elemB(i, j)));
    }
  }
});

test('rowValues matches per-element referenceElement', () => {
  const s = mkShard({ n: 24 });
  const row = s.rowValues(5);
  assert.equal(row.length, 24);
  for (let j = 0; j < 24; j++) {
    assert.equal(row[j], s.referenceElement(5, j));
  }
});

// --------------------------------------------------------------------------
// Freshness
// --------------------------------------------------------------------------

test('a different session nonce produces entirely different work', () => {
  const a = mkShard({ sessionNonce: NONCE_A });
  const b = mkShard({ sessionNonce: NONCE_B });
  assert.notEqual(a.seed, b.seed);

  let differing = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) if (a.elemA(i, j) !== b.elemA(i, j)) differing++;
  }
  assert.ok(differing > 60, `expected nearly all inputs to differ, got ${differing}/64`);
});

test('a result built for one shard does not verify against a replayed (different-nonce) shard', async () => {
  const issued = mkShard({ id: 's1', sessionNonce: NONCE_A });
  const replayed = mkShard({ id: 's1', sessionNonce: NONCE_B });

  const stale = await buildHonestSubmission(issued, 'w1');
  const v = await verifyRowSubmission(replayed, stale);
  assert.equal(v.ok, false, 'a replayed submission must not verify against a fresh shard');
});

test('seedFromNonce is stable and nonce-sensitive', () => {
  assert.equal(seedFromNonce(NONCE_A), seedFromNonce(NONCE_A));
  assert.notEqual(seedFromNonce(NONCE_A), seedFromNonce(NONCE_B));
});

// --------------------------------------------------------------------------
// challengeRows -- commit-then-challenge, the fix itself
// --------------------------------------------------------------------------

test('challengeRows is deterministic in (shard, root, k)', async () => {
  const s = mkShard();
  const root = toHex(await hashRow([1, 2, 3]));
  assert.deepEqual(challengeRows(s, root, 6), challengeRows(s, root, 6));
});

test('challengeRows depends on the root, not just the shard', async () => {
  const s = mkShard();
  const rootA = toHex(await hashRow([1, 2, 3]));
  const rootB = toHex(await hashRow([4, 5, 6]));
  assert.notDeepEqual(challengeRows(s, rootA, 6), challengeRows(s, rootB, 6),
    'if the challenge ignored the root, a worker could compute it before committing -- ' +
    'which is exactly the vulnerability this scheme closes');
});

test('challengeRows returns distinct, sorted, in-range indices', async () => {
  const s = mkShard({ n: 32 });
  const root = toHex(await hashRow([9, 9, 9]));
  const rows = challengeRows(s, root, 10);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows, [...new Set(rows)].sort((a, b) => a - b));
  for (const r of rows) assert.ok(r >= 0 && r < 32);
});

test('challengeRows caps at n when k exceeds the row count', async () => {
  const s = mkShard({ n: 4 });
  const root = toHex(await hashRow([1]));
  assert.equal(challengeRows(s, root, 100).length, 4);
});

// --------------------------------------------------------------------------
// Honest round trip
// --------------------------------------------------------------------------

test('an honest submission verifies', async () => {
  const s = mkShard();
  const result = await buildHonestSubmission(s, 'w1');
  const v = await verifyRowSubmission(s, result);
  assert.equal(v.ok, true, JSON.stringify(v.failures));
  assert.equal(v.checkedRows.length, DEFAULT_CHALLENGE_ROWS);
  assert.ok(v.worstError < 1e-6);
});

test('commitFullResult + manual reveal matches buildHonestSubmission', async () => {
  const s = mkShard({ n: 16 });
  const { root, layers, rows } = await commitFullResult(s);
  const required = challengeRows(s, root, 5);
  const revealed = required.map((idx) => ({
    index: idx,
    values: Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const result = new ShardResult({ shardId: s.id, workerId: 'w1', root: toHex(root), rows: revealed });
  const v = await verifyRowSubmission(s, result, { k: 5 });
  assert.equal(v.ok, true, JSON.stringify(v.failures));
});

test('two honest workers on the same shard converge on the same root', async () => {
  // What makes cross-worker root comparison (consensus, M2.3) meaningful.
  const s = mkShard();
  const a = await buildHonestSubmission(s, 'a');
  const b = await buildHonestSubmission(s, 'b');
  assert.equal(a.root, b.root);
});

// --------------------------------------------------------------------------
// THE VULNERABILITY THIS FILE EXISTS TO CLOSE
//
// An earlier version derived challenge points directly from public shard
// data, so a worker could compute only the checked points (O(n) each) and
// skip the O(n^3) computation entirely. These tests demonstrate that attack
// no longer succeeds against the commit-then-challenge scheme.
// --------------------------------------------------------------------------

/** Build a submission where only `honestRows` are real; every other row is
 * a fixed placeholder the "attacker" never computed from the shard at all. */
async function buildPartiallyFakedSubmission(shard, workerId, honestRows) {
  const honestSet = new Set(honestRows);
  const rows = [];
  const leaves = [];
  for (let i = 0; i < shard.n; i++) {
    const row = honestSet.has(i)
      ? shard.rowValues(i)
      : new Float32Array(shard.n).fill(0);   // never computed -- a fixed stand-in
    rows.push(row);
    leaves.push(await hashRow(row));
  }
  const { root, layers } = await buildMerkleTree(leaves);
  const required = challengeRows(shard, root, DEFAULT_CHALLENGE_ROWS);
  const revealed = required.map((idx) => ({
    index: idx,
    values: Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  return {
    result: new ShardResult({ shardId: shard.id, workerId, root: toHex(root), rows: revealed }),
    required,
  };
}

test('a worker that computes zero rows and forges the rest is caught', async () => {
  const s = mkShard();
  const { result } = await buildPartiallyFakedSubmission(s, 'lazy', []);
  const v = await verifyRowSubmission(s, result);
  assert.equal(v.ok, false);
  assert.ok(v.failures.length > 0);
});

test('replaying the OLD exploit -- precompute a guessed set of "likely" rows -- fails', async () => {
  // This is the direct regression test for the vulnerability: under the old
  // scheme, computing exactly the rows that would be checked (and nothing
  // else) was sufficient to pass. Here the attacker guesses the most naive
  // possible target -- the first DEFAULT_CHALLENGE_ROWS row indices -- before
  // knowing anything about what will actually be required, then fakes every
  // other row. Because the real requirement is derived from a root that
  // depends on ALL rows (including the faked ones), the attacker's guess and
  // the broker's independently-derived requirement do not match: the fixed
  // shard/nonce/k in this test makes the outcome deterministic, not lucky.
  const s = mkShard({ n: 32 });
  const guessedRows = Array.from({ length: DEFAULT_CHALLENGE_ROWS }, (_, i) => i);
  const { result, required } = await buildPartiallyFakedSubmission(s, 'attacker', guessedRows);

  // buildPartiallyFakedSubmission always reveals every row the broker will
  // actually require (it doesn't know in advance which ones those are
  // either) -- what makes the rows "faked" is that their VALUES are a fixed
  // placeholder wherever they fall outside the attacker's guess, not that
  // they're missing. So the failure mode to expect is a ground-truth
  // mismatch on the required-but-never-honestly-computed rows, not an
  // absent reveal.
  const fakedButRequired = required.filter((idx) => !guessedRows.includes(idx));
  assert.ok(fakedButRequired.length > 0,
    'sanity check: at least one required row must fall outside the naive guess for ' +
    'this test to demonstrate anything -- if this fails, pick different fixtures');

  const v = await verifyRowSubmission(s, result);
  assert.equal(v.ok, false,
    'an attacker who never honestly computed all the actually-required rows must fail verification');
  assert.ok(
    v.failures.some((f) => fakedButRequired.includes(f.index) &&
      f.reason === 'value does not match ground truth'),
    `expected a ground-truth mismatch on one of [${fakedButRequired}], got: ${JSON.stringify(v.failures)}`);
});

test('a worker honest on most rows but faking even one required row is caught', async () => {
  // Complements the all-or-nothing tests above: confirms the ground-truth
  // spot-check (not just "was the row revealed") is what catches a forged
  // row that the attacker correctly anticipated would be required.
  const s = mkShard({ n: 16 });
  const { root, layers, rows } = await commitFullResult(s);
  const required = challengeRows(s, root, DEFAULT_CHALLENGE_ROWS);

  const revealed = required.map((idx, pos) => ({
    index: idx,
    // Corrupt exactly one required row's revealed values, while keeping a
    // VALID Merkle proof for the (now mismatching) content impossible --
    // so instead corrupt post-commitment: reveal wrong values but the
    // ORIGINAL proof, simulating "submit a lie about what was computed".
    values: pos === 0 ? Array.from(rows[idx]).map((v) => v + 10) : Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const result = new ShardResult({ shardId: s.id, workerId: 'w', root: toHex(root), rows: revealed });
  const v = await verifyRowSubmission(s, result);
  assert.equal(v.ok, false,
    'changing revealed values without recomputing the tree must break the Merkle proof, ' +
    'not just the ground-truth check -- either failure mode is acceptable, but one must fire');
});

// --------------------------------------------------------------------------
// Verification: structural failure modes, reported with distinct reasons
// --------------------------------------------------------------------------

test('verification rejects a result for the wrong shard', async () => {
  const s = mkShard({ id: 's1' });
  const other = mkShard({ id: 's2', sessionNonce: NONCE_B });
  const result = await buildHonestSubmission(s, 'w1');
  const v = await verifyRowSubmission(other, result);
  assert.equal(v.ok, false);
  assert.equal(v.failures[0].reason, 'result is for a different shard');
});

test('verification rejects a malformed root encoding', () => {
  const s = mkShard();
  assert.throws(() => new ShardResult({
    shardId: s.id, workerId: 'w', root: 'not-hex!!', rows: [{ index: 0, values: [0], proof: [] }],
  }), TypeError);
});

test('verification rejects a missing required row', async () => {
  const s = mkShard({ n: 16 });
  const result = await buildHonestSubmission(s, 'w1', { k: 4 });
  const trimmed = new ShardResult({
    shardId: result.shardId, workerId: result.workerId, root: result.root,
    rows: result.rows.slice(1),   // drop one required row
  });
  const v = await verifyRowSubmission(s, trimmed, { k: 4 });
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.reason === 'required row was not revealed'));
});

test('verification rejects a tampered Merkle proof', async () => {
  const s = mkShard({ n: 16 });
  const result = await buildHonestSubmission(s, 'w1', { k: 4 });
  const tampered = new ShardResult({
    shardId: result.shardId, workerId: result.workerId, root: result.root,
    rows: result.rows.map((r, i) => i === 0
      ? { ...r, proof: r.proof.map((p) => ({ ...p, hash: '00'.repeat(32) })) }
      : r),
  });
  const v = await verifyRowSubmission(s, tampered, { k: 4 });
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.reason === 'row is not included under the submitted root'));
});

test('verification rejects a row of the wrong length', async () => {
  const s = mkShard({ n: 16 });
  const result = await buildHonestSubmission(s, 'w1', { k: 4 });
  const truncated = new ShardResult({
    shardId: result.shardId, workerId: result.workerId, root: result.root,
    rows: result.rows.map((r, i) => i === 0 ? { ...r, values: r.values.slice(0, -1) } : r),
  });
  const v = await verifyRowSubmission(s, truncated, { k: 4 });
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.reason?.includes('expected 16')));
});

// --------------------------------------------------------------------------
// Construction guards
// --------------------------------------------------------------------------

test('shards reject weak or missing freshness binding', () => {
  assert.throws(() => new Shard({ id: 's', n: 32, sessionNonce: 'short' }), TypeError);
  assert.throws(() => new Shard({ id: 's', n: 32 }), TypeError);
});

test('shards reject invalid dimensions and missing ids', () => {
  assert.throws(() => new Shard({ id: 's', n: 0, sessionNonce: NONCE_A }), RangeError);
  assert.throws(() => new Shard({ id: 's', n: 1.5, sessionNonce: NONCE_A }), RangeError);
  assert.throws(() => new Shard({ n: 32, sessionNonce: NONCE_A }), TypeError);
});

test('shards are immutable, so difficulty cannot be renegotiated after issue', () => {
  const s = mkShard();
  assert.throws(() => { s.n = 8; }, TypeError);
});

test('results reject empty rows, missing shard/worker ids, and malformed row entries', () => {
  const validRoot = '00'.repeat(32);
  assert.throws(() => new ShardResult({ shardId: 's', workerId: 'w', root: validRoot, rows: [] }), TypeError);
  assert.throws(() => new ShardResult({ shardId: 's', root: validRoot, rows: [{ index: 0, values: [], proof: [] }] }), TypeError);
  assert.throws(() => new ShardResult({
    shardId: 's', workerId: 'w', root: validRoot, rows: [{ values: [], proof: [] }],
  }), TypeError, 'missing index');
  assert.throws(() => new ShardResult({
    shardId: 's', workerId: 'w', root: validRoot, rows: [{ index: 0, proof: [] }],
  }), TypeError, 'missing values');
});

test('results are immutable once constructed', async () => {
  const s = mkShard();
  const result = await buildHonestSubmission(s, 'w1');
  assert.throws(() => { result.workerId = 'w2'; }, TypeError);
});

test('DEFAULT_TOLERANCE is loose enough for cross-implementation fp32', () => {
  assert.ok(DEFAULT_TOLERANCE >= 1e-3 && DEFAULT_TOLERANCE <= 1e-1);
});

test('DEFAULT_CHALLENGE_ROWS is large enough that a coin-flip cheater is caught with high probability', () => {
  // f=0.5 evasion probability is 0.5^k; require it below 1%.
  assert.ok(0.5 ** DEFAULT_CHALLENGE_ROWS < 0.01,
    `k=${DEFAULT_CHALLENGE_ROWS} gives evasion probability ${0.5 ** DEFAULT_CHALLENGE_ROWS} at f=0.5`);
});
