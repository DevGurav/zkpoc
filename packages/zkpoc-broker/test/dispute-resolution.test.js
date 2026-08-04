import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Shard, ShardResult, commitFullResult, challengeRows } from '../src/shard.js';
import { buildMerkleTree, hashRow, proveInclusion, toHex } from '../src/merkle.js';
import { reachConsensus, ShardStatus, Verdict } from '../src/consensus.js';
import { shouldAudit, auditFull } from '../src/audit.js';
import { CreditLedger, ViolationReason } from '../src/ledger.js';

/**
 * This file demonstrates the scenario docs/roadmap.md names as M2.4's job:
 * "this is also where disputed shards from consensus get resolved." It is
 * intentionally NOT wrapped in a single orchestrating function -- gluing
 * consensus, audit and the ledger into one pipeline call belongs to M2.5's
 * challenge protocol wrapper (which needs to decide policy questions this
 * phase deliberately leaves open: how many disputed replicas get audited,
 * what happens to a shard when an audit ALSO fails to resolve cleanly,
 * etc.). What this file proves is narrower and load-bearing on its own:
 * that the three pieces built in M2.1-M2.4 compose correctly when wired by
 * hand, with nothing hidden that a real orchestrator would need to
 * rediscover.
 */

async function fullReveal(shard, layers, rows) {
  return rows.map((r, i) => ({
    index: i,
    values: Array.from(r),
    proof: proveInclusion(layers, i).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
}

/** Build a submission that passes the k=8 sampled gate but is dishonest on
 * a row outside that sample. Same fixture as audit.test.js's "THE POINT OF
 * AUDIT" case -- see that test for how it was found. Returns both the
 * cheap (k=8) submission a real worker would actually transmit, and the
 * full disclosure it would need to retain locally to answer an audit. */
async function buildSneakySubmission(shard, workerId, badRow) {
  const rows = [];
  const leaves = [];
  for (let i = 0; i < shard.n; i++) {
    const row = i === badRow ? new Float32Array(shard.n).fill(999) : shard.rowValues(i);
    rows.push(row);
    leaves.push(await hashRow(row));
  }
  const { root, layers } = await buildMerkleTree(leaves);
  const required = challengeRows(shard, root, 8);

  const cheapReveal = required.map((idx) => ({
    index: idx,
    values: Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  const cheap = new ShardResult({ shardId: shard.id, workerId, root: toHex(root), rows: cheapReveal });
  const full = new ShardResult({
    shardId: shard.id, workerId, root: toHex(root), rows: await fullReveal(shard, layers, rows),
  });
  return { cheap, full, requiredSample: required };
}

async function buildFullHonest(shard, workerId) {
  const { root, layers, rows } = await commitFullResult(shard);
  return new ShardResult({
    shardId: shard.id, workerId, root: toHex(root), rows: await fullReveal(shard, layers, rows),
  });
}

test('a disputed shard is forced to audit, and the dishonest replica is slashed while the honest one is paid', async () => {
  // Same shard/fixture as audit.test.js's "THE POINT OF AUDIT" case: row 0
  // corrupted, row 0 not among the k=8 rows the resulting root requires.
  const shard = new Shard({
    id: 'dispute-fixture', n: 32, sessionNonce: 'audit-fixture-nonce-000001',
  });
  const BAD_ROW = 0;

  const honest = await buildFullHonest(shard, 'honest-worker');
  const { cheap: sneakyCheap, full: sneakyFull, requiredSample } =
    await buildSneakySubmission(shard, 'sneaky-worker', BAD_ROW);

  assert.notEqual(honest.root, sneakyCheap.root, 'sanity: the two roots must genuinely differ');
  assert.ok(!requiredSample.includes(BAD_ROW),
    'sanity: the corrupted row must be outside the sampled set, or this fixture proves nothing');

  // Step 1 -- consensus sees two replicas that both pass the cheap gate but
  // disagree on the root: an unresolved dispute, not an arbitrary pick.
  const verdict = await reachConsensus(shard, [honest, sneakyCheap]);
  assert.equal(verdict.status, ShardStatus.DISPUTED);
  assert.equal(verdict.confirmedRoot, null);
  assert.deepEqual(new Set(verdict.minorityWorkers), new Set(['honest-worker', 'sneaky-worker']),
    'consensus alone cannot yet tell these two apart -- that is the whole point of forcing an audit next');

  // Step 2 -- a dispute forces an audit regardless of stake or the ordinary
  // sampling rate (shouldAudit's `force` path), for BOTH disputed replicas.
  const ledger = new CreditLedger({ rewardPerShard: 1 });
  ledger.deposit('honest-worker', 100);
  ledger.deposit('sneaky-worker', 100);

  for (const workerId of verdict.minorityWorkers) {
    const decision = shouldAudit(shard, honest.root, ledger.stakeShards(workerId), { force: true });
    assert.equal(decision.audit, true, 'a disputed replica must always be audited, stake notwithstanding');
  }

  // Step 3 -- the audit itself: full disclosure, every row checked.
  const honestAudit = await auditFull(shard, honest);
  const sneakyAudit = await auditFull(shard, sneakyFull);

  assert.equal(honestAudit.ok, true, JSON.stringify(honestAudit.failures));
  assert.equal(sneakyAudit.ok, false, 'the corrupted row must surface once every row is checked');
  assert.ok(sneakyAudit.failures.some((f) => f.index === BAD_ROW));

  // Step 4 -- resolution: reward the confirmed-honest party, slash the one
  // the audit caught. This is the deterrence the a*=1/(1+k) formula assumes
  // exists (ADR-0006) -- without this step, the formula is just arithmetic.
  ledger.reward('honest-worker', 1);
  const slashResult = ledger.slash('sneaky-worker', ViolationReason.FAILED_AUDIT, { shardId: shard.id });

  assert.equal(ledger.balanceOf('honest-worker'), 1);
  assert.equal(ledger.balanceOf('sneaky-worker'), 0, 'a dishonest replica must not be paid');
  assert.equal(slashResult.slashed, 100, 'default slashFraction=1.0 forfeits the full stake');
  assert.equal(ledger.stakeOf('sneaky-worker'), 0);
  assert.equal(ledger.stakeOf('honest-worker'), 100, 'the honest party\'s stake must be untouched');

  const history = ledger.history('sneaky-worker');
  assert.equal(history[history.length - 1].reason, ViolationReason.FAILED_AUDIT);
  assert.equal(history[history.length - 1].shardId, shard.id);
});

test('an undisputed (clean majority) shard does not force an audit at all', async () => {
  // Contrast case: consensus resolving cleanly on its own must not trigger
  // the expensive full-disclosure path -- that would defeat the entire
  // economic argument for tiered verification (bench/breakeven.py).
  const shard = new Shard({ id: 'clean-shard', n: 16, sessionNonce: 'session-nonce-dddddddddddd' });
  const a = await buildFullHonest(shard, 'a');
  const b = await buildFullHonest(shard, 'b');

  const verdict = await reachConsensus(shard, [a, b]);
  assert.equal(verdict.status, ShardStatus.CONFIRMED);
  assert.deepEqual(verdict.minorityWorkers, [],
    'nothing here should be forced to audit -- there is no dispute to resolve');
});
