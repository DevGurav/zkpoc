import { test } from 'node:test';
import assert from 'node:assert/strict';

import { minAuditRate, auditDraw, shouldAudit, auditFull } from '../src/audit.js';
import {
  Shard, ShardResult, buildHonestSubmission, commitFullResult, challengeRows,
} from '../src/shard.js';
import { buildMerkleTree, hashRow, proveInclusion, toHex } from '../src/merkle.js';

const mkShard = (o = {}) => new Shard({
  id: 'audit-shard', n: 32, sessionNonce: 'session-nonce-cccccccccccc', ...o,
});

// --------------------------------------------------------------------------
// minAuditRate -- mirrors bench/breakeven.py#min_audit_rate exactly. Pinned
// against the same table bench/breakeven.py's own tests/output use, so the
// two cannot silently drift apart -- see docs/BUILD.md §1.
// --------------------------------------------------------------------------

test('minAuditRate matches the documented a* = 1/(1+k) table', () => {
  const cases = [
    [0, 1.0],
    [1, 0.5],
    [9, 0.1],
    [99, 0.01],
    [999, 0.001],
    [9999, 0.0001],
  ];
  for (const [k, expected] of cases) {
    assert.ok(Math.abs(minAuditRate(k) - expected) < 1e-12,
      `k=${k}: expected ${expected}, got ${minAuditRate(k)}`);
  }
});

test('minAuditRate rejects a negative stake', () => {
  assert.throws(() => minAuditRate(-1), RangeError);
});

test('minAuditRate is monotonically decreasing in stake', () => {
  assert.ok(minAuditRate(0) > minAuditRate(10));
  assert.ok(minAuditRate(10) > minAuditRate(1000));
});

// --------------------------------------------------------------------------
// auditDraw -- unpredictable-before-commitment selection, same Fiat-Shamir
// shape as challengeRows(). Not a fresh mechanism, reuses that one.
// --------------------------------------------------------------------------

test('auditDraw is deterministic in (shard, root)', async () => {
  const s = mkShard();
  const root = toHex(await hashRow([1, 2, 3]));
  assert.equal(auditDraw(s, root), auditDraw(s, root));
});

test('auditDraw depends on the root, not just the shard', async () => {
  const s = mkShard();
  const rootA = toHex(await hashRow([1, 2, 3]));
  const rootB = toHex(await hashRow([4, 5, 6]));
  assert.notEqual(auditDraw(s, rootA), auditDraw(s, rootB),
    'a draw predictable before the root is committed would be a worker-avoidable audit schedule');
});

test('auditDraw returns a value in [0, 1)', async () => {
  const s = mkShard();
  for (let i = 0; i < 20; i++) {
    const root = toHex(await hashRow([i, i + 1, i + 2]));
    const d = auditDraw(s, root);
    assert.ok(d >= 0 && d < 1, `draw ${d} out of range`);
  }
});

// --------------------------------------------------------------------------
// shouldAudit -- combines the draw with the stake-derived rate
// --------------------------------------------------------------------------

test('shouldAudit audits when the draw falls under the stake-derived rate', async () => {
  const s = mkShard();
  const root = toHex(await hashRow(['probe']));
  const draw = auditDraw(s, root);

  // A stake of 0 shards => rate 1.0 => every draw in [0,1) is audited.
  const always = shouldAudit(s, root, 0);
  assert.equal(always.audit, true);
  assert.equal(always.rate, 1.0);
  assert.equal(always.draw, draw);

  // An astronomically large stake => rate ~0 => this specific draw (which is
  // > 0 with overwhelming probability) is not audited.
  const rarely = shouldAudit(s, root, 1e12);
  assert.ok(rarely.rate < 1e-11);
  assert.equal(rarely.audit, draw < rarely.rate);
});

test('shouldAudit force=true audits regardless of stake or draw', async () => {
  const s = mkShard();
  const root = toHex(await hashRow(['forced']));
  const r = shouldAudit(s, root, 1e12, { force: true });
  assert.equal(r.audit, true);
  assert.equal(r.forced, true);
  assert.ok(r.rate < 1e-11, 'forced does not change what the rate WOULD have been, only the outcome');
});

test('shouldAudit reports forced:false on the ordinary path', async () => {
  const s = mkShard();
  const root = toHex(await hashRow(['ordinary']));
  const r = shouldAudit(s, root, 5);
  assert.equal(r.forced, false);
});

// --------------------------------------------------------------------------
// auditFull -- full-disclosure re-verification, every row not a sample
// --------------------------------------------------------------------------

test('auditFull checks every row, not a k-row sample', async () => {
  const s = mkShard({ n: 16 });
  const { root, layers, rows } = await commitFullResult(s);
  const revealed = Array.from({ length: s.n }, (_, i) => ({
    index: i,
    values: Array.from(rows[i]),
    proof: proveInclusion(layers, i).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const full = new ShardResult({ shardId: s.id, workerId: 'w1', root: toHex(root), rows: revealed });

  const result = await auditFull(s, full);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.checkedRows.length, s.n, 'a full audit must check every row, not a sample');
});

test('auditFull passes an honestly-built full submission from buildHonestSubmission-equivalent data', async () => {
  // buildHonestSubmission() itself only reveals k rows by design (that's the
  // cheap path); auditFull needs the full commit's rows, which is what a
  // real worker retains locally to be able to respond to an audit request.
  const s = mkShard({ n: 24 });
  const { root, layers, rows } = await commitFullResult(s);
  const revealed = rows.map((r, i) => ({
    index: i,
    values: Array.from(r),
    proof: proveInclusion(layers, i).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const full = new ShardResult({ shardId: s.id, workerId: 'w1', root: toHex(root), rows: revealed });
  assert.equal((await auditFull(s, full)).ok, true);
});

test('THE POINT OF AUDIT: catches a corrupted row that the original k=8 sample missed', async () => {
  // Fixture found empirically (see the shell session that built this test):
  // for this exact shard, corrupting row 0 while computing every other row
  // honestly produces a root whose own required-8 challenge set is
  // [6,8,13,16,17,24,27,28] -- row 0 is not among them, so the ORIGINAL
  // sampled verification passes. A full audit checks row 0 too and must not.
  const s = new Shard({ id: 'audit-fixture', n: 32, sessionNonce: 'audit-fixture-nonce-000001' });
  const BAD_ROW = 0;

  const rows = [];
  const leaves = [];
  for (let i = 0; i < s.n; i++) {
    const row = i === BAD_ROW ? new Float32Array(s.n).fill(999) : s.rowValues(i);
    rows.push(row);
    leaves.push(await hashRow(row));
  }
  const { root, layers } = await buildMerkleTree(leaves);

  const required8 = challengeRows(s, root, 8);
  assert.ok(!required8.includes(BAD_ROW),
    'sanity check: the corrupted row must fall outside the sampled set for this test to prove anything');

  const sampledReveal = required8.map((idx) => ({
    index: idx,
    values: Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const sampledResult = new ShardResult({
    shardId: s.id, workerId: 'sneaky', root: toHex(root), rows: sampledReveal,
  });

  const { verifyRowSubmission } = await import('../src/shard.js');
  const originalGate = await verifyRowSubmission(s, sampledResult);
  assert.equal(originalGate.ok, true,
    'the original k=8 sample must pass -- that is exactly the blind spot audit exists to close');

  const fullReveal = rows.map((r, i) => ({
    index: i,
    values: Array.from(r),
    proof: proveInclusion(layers, i).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const fullResult = new ShardResult({
    shardId: s.id, workerId: 'sneaky', root: toHex(root), rows: fullReveal,
  });
  const audit = await auditFull(s, fullResult);
  assert.equal(audit.ok, false, 'a full audit must catch what the sample missed');
  assert.ok(audit.failures.some((f) => f.index === BAD_ROW));
});

test('auditFull rejects a partial disclosure (missing rows) rather than checking what was given', async () => {
  const s = mkShard({ n: 16 });
  const { root, layers, rows } = await commitFullResult(s);
  const partial = rows.slice(0, 10).map((r, i) => ({
    index: i,
    values: Array.from(r),
    proof: proveInclusion(layers, i).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const result = new ShardResult({ shardId: s.id, workerId: 'w1', root: toHex(root), rows: partial });
  const audit = await auditFull(s, result);
  assert.equal(audit.ok, false, 'non-response/partial response to an audit must not pass by default');
});
