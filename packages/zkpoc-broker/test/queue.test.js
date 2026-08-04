import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShardQueue, AssignmentState, freshNonce } from '../src/queue.js';
import { Shard, ShardResult, buildHonestSubmission } from '../src/shard.js';

/** A controllable clock so lease expiry is deterministic, not timer-based. */
function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

/** The queue is agnostic to result correctness (see queue.js's docstring --
 * that's consensus's job, M2.3), so tests here just need a structurally
 * valid, honestly-computed submission. Building one requires hashing every
 * row (see shard.js), which is why this helper -- and every test that calls
 * it -- is async. */
const mkResult = (shard, workerId) => buildHonestSubmission(shard, workerId);

// --------------------------------------------------------------------------
// Freshness
// --------------------------------------------------------------------------

test('freshNonce produces distinct, sufficiently long values', () => {
  const a = freshNonce();
  const b = freshNonce();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16, 'must satisfy Shard\'s minimum nonce length');
});

test('createShard mints a fresh nonce per shard, satisfying Shard\'s own guard', () => {
  const q = new ShardQueue();
  const a = q.createShard({ n: 64 });
  const b = q.createShard({ n: 64 });
  assert.notEqual(a.sessionNonce, b.sessionNonce);
  assert.ok(a instanceof Shard);
});

test('a caller cannot supply a precomputed nonce through createShard', () => {
  // createShard's signature deliberately has no nonce parameter -- this test
  // documents that omission is load-bearing, not an oversight.
  const q = new ShardQueue();
  const s = q.createShard({ n: 64, tierName: 'laptop-igpu' });
  assert.equal(typeof s.sessionNonce, 'string');
  assert.ok(s.sessionNonce.length >= 16);
});

// --------------------------------------------------------------------------
// Basic assignment flow
// --------------------------------------------------------------------------

test('assign returns null when nothing is eligible', () => {
  const q = new ShardQueue();
  assert.equal(q.assign('w1'), null);
});

test('a fresh shard is assignable immediately', () => {
  const q = new ShardQueue({ redundancy: 2 });
  const shard = q.createShard({ n: 64 });
  const a = q.assign('w1');
  assert.ok(a);
  assert.equal(a.shard.id, shard.id);
  assert.equal(a.workerId, 'w1');
});

test('assign requires a workerId', () => {
  const q = new ShardQueue();
  q.createShard({ n: 64 });
  assert.throws(() => q.assign(), TypeError);
  assert.throws(() => q.assign(''), TypeError);
});

test('enqueue rejects a duplicate shard id', () => {
  const q = new ShardQueue();
  const shard = q.createShard({ n: 64, id: 'dup' });
  assert.throws(() => q.enqueue(shard), /already queued/);
});

// --------------------------------------------------------------------------
// Replica independence -- the property the module exists to guarantee
// --------------------------------------------------------------------------

test('the same worker is never assigned the same shard twice while active', () => {
  const q = new ShardQueue({ redundancy: 3 });
  q.createShard({ n: 64 });
  const first = q.assign('w1');
  assert.ok(first);
  assert.equal(q.assign('w1'), null,
    'w1 already holds this shard\'s only instance; there is nothing else to hand out');
});

test('redundancy N stops offering a shard after N distinct workers hold it', () => {
  const q = new ShardQueue({ redundancy: 2 });
  q.createShard({ n: 64 });
  assert.ok(q.assign('w1'));
  assert.ok(q.assign('w2'));
  assert.equal(q.assign('w3'), null, 'a third replica must not be handed out');
});

test('a worker that already submitted cannot be re-assigned the same shard', async () => {
  const q = new ShardQueue({ redundancy: 3 });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');
  q.submit(await mkResult(shard, 'w1'));
  assert.equal(q.assign('w1'), null);
});

test('replica independence survives lease expiry -- a worker cannot retry into a second slot', () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 2, leaseMs: 1000, now });
  q.createShard({ n: 64 });

  q.assign('w1');
  now.advance(1001);            // w1's lease lapses
  q.expireLeases();

  // The slot freed by expiry may go to a DIFFERENT worker...
  const second = q.assign('w2');
  assert.ok(second, 'an expired lease must free the replica slot');

  // ...but w1 itself must not be handed a second instance of the same shard.
  assert.equal(q.assign('w1'), null,
    'w1 already holds a (now-expired) assignment for this shard, ' +
    'and must not be allowed to occupy a second replica slot');
});

// --------------------------------------------------------------------------
// Lease expiry
// --------------------------------------------------------------------------

test('expireLeases transitions overdue active assignments to EXPIRED', async () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 2, leaseMs: 500, now });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');

  now.advance(499);
  assert.equal(q.expireLeases(), 0, 'not overdue yet');

  now.advance(2);
  assert.equal(q.expireLeases(), 1);

  const submitResult = q.submit(await mkResult(shard, 'w1'));
  assert.equal(submitResult.accepted, false);
  assert.match(submitResult.reason, /expired/);
});

test('expireLeases is idempotent', () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 1, leaseMs: 100, now });
  q.createShard({ n: 64 });
  q.assign('w1');
  now.advance(200);
  assert.equal(q.expireLeases(), 1);
  assert.equal(q.expireLeases(), 0, 'already-expired leases are not counted twice');
});

test('assign() lazily expires leases before offering work', () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 1, leaseMs: 100, now });
  q.createShard({ n: 64 });
  q.assign('w1');
  now.advance(200);
  // Caller never calls expireLeases() directly -- assign() must do it.
  const second = q.assign('w2');
  assert.ok(second, 'assign() must reclaim expired leases on its own');
});

test('a shard exhausting maxAttempts with no outstanding lease is abandoned', () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 2, leaseMs: 10, maxAttempts: 3, now });
  q.createShard({ n: 64, id: 'doomed' });

  // Three different workers each take and abandon the lease.
  for (const w of ['a', 'b', 'c']) {
    q.assign(w);
    now.advance(11);
    q.expireLeases();
  }
  assert.deepEqual(q.abandonedShardIds(), ['doomed']);
  assert.equal(q.assign('d'), null, 'an abandoned shard must not be re-offered');
});

// --------------------------------------------------------------------------
// submit()
// --------------------------------------------------------------------------

test('submit accepts a result against an active assignment and reports replica count', async () => {
  const q = new ShardQueue({ redundancy: 2 });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');
  const r = q.submit(await mkResult(shard, 'w1'));
  assert.equal(r.accepted, true);
  assert.equal(r.reason, null);
  assert.equal(r.replicas, 1);
  assert.equal(r.complete, false);
});

test('submit flips complete once redundancy replicas are in', async () => {
  const q = new ShardQueue({ redundancy: 2 });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');
  q.assign('w2');
  q.submit(await mkResult(shard, 'w1'));
  const r = q.submit(await mkResult(shard, 'w2'));
  assert.equal(r.replicas, 2);
  assert.equal(r.complete, true);
  assert.deepEqual(q.completedShardIds(), [shard.id]);
});

test('submit rejects an unknown shard', () => {
  const q = new ShardQueue();
  const fake = new ShardResult({
    shardId: 'nonexistent', workerId: 'w1', root: '00'.repeat(32),
    rows: [{ index: 0, values: [0], proof: [] }],
  });
  const r = q.submit(fake);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'unknown shard');
});

test('submit rejects a worker with no assignment for that shard', async () => {
  const q = new ShardQueue();
  const shard = q.createShard({ n: 64 });
  const r = q.submit(await mkResult(shard, 'never-assigned'));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'no assignment for this worker');
});

test('submit rejects a duplicate submission from the same worker', async () => {
  const q = new ShardQueue({ redundancy: 3 });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');
  const first = q.submit(await mkResult(shard, 'w1'));
  assert.equal(first.accepted, true);
  const second = q.submit(await mkResult(shard, 'w1'));
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'duplicate submission');
  assert.equal(second.replicas, 1, 'the duplicate must not double-count');
});

test('a genuinely expired (not merely submitted) assignment reports its real state', async () => {
  // Distinguishes the two "not active" reasons: EXPIRED assignments must still
  // surface as such, not be swallowed by the duplicate-submission branch above.
  const now = clock();
  const q = new ShardQueue({ redundancy: 3, leaseMs: 100, now });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');
  now.advance(200);
  q.expireLeases();
  const r = q.submit(await mkResult(shard, 'w1'));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'assignment is expired');
});

test('submit records elapsedMs for downstream anomaly checks', async () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 1, now });
  const shard = q.createShard({ n: 64 });
  q.assign('w1');
  now.advance(37);
  q.submit(await mkResult(shard, 'w1'));
  const [entry] = q.resultsFor(shard.id);
  assert.equal(entry.elapsedMs, 37);
});

// --------------------------------------------------------------------------
// Construction guards
// --------------------------------------------------------------------------

test('queue construction rejects invalid redundancy and lease values', () => {
  assert.throws(() => new ShardQueue({ redundancy: 0 }), RangeError);
  assert.throws(() => new ShardQueue({ redundancy: 1.5 }), RangeError);
  assert.throws(() => new ShardQueue({ leaseMs: 0 }), RangeError);
  assert.throws(() => new ShardQueue({ leaseMs: -1 }), RangeError);
});

// --------------------------------------------------------------------------
// Stated boundary: identity independence is NOT Sybil resistance
// --------------------------------------------------------------------------

test('the queue enforces distinct identities per shard, not distinct real-world actors', async () => {
  // This is the queue's documented limit, made concrete: nothing here stops
  // one adversary from presenting as two workerIds. Sybil resistance is the
  // stake's job (M2.4), not the queue's -- see the module docstring.
  const q = new ShardQueue({ redundancy: 2 });
  const shard = q.createShard({ n: 64 });

  const sybilA = q.assign('sybil-1');
  const sybilB = q.assign('sybil-2');
  assert.ok(sybilA && sybilB,
    'the queue has no way to know sybil-1 and sybil-2 are the same actor, ' +
    'and correctly does not pretend otherwise');

  const rA = q.submit(await mkResult(shard, 'sybil-1'));
  const rB = q.submit(await mkResult(shard, 'sybil-2'));
  assert.equal(rA.accepted, true);
  assert.equal(rB.accepted, true);
  assert.equal(rB.complete, true,
    'two Sybil identities can satisfy redundancy on their own -- this is why ' +
    'the stake mechanism, not the queue, is where Sybil resistance must live');
});

// --------------------------------------------------------------------------
// Introspection
// --------------------------------------------------------------------------

test('stats report pending, completed, abandoned and active counts consistently', async () => {
  const now = clock();
  const q = new ShardQueue({ redundancy: 2, leaseMs: 50, maxAttempts: 2, now });

  const done = q.createShard({ n: 64, id: 'done' });
  q.assign('a'); q.assign('b');
  q.submit(await mkResult(done, 'a'));
  q.submit(await mkResult(done, 'b'));

  q.createShard({ n: 64, id: 'pending' });
  q.assign('c');   // one active assignment, still needs a second replica

  const s = q.stats;
  assert.equal(s.total, 2);
  assert.equal(s.completed, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.abandoned, 0);
  assert.equal(s.activeAssignments, 1);
  assert.equal(s.redundancy, 2);
});

test('getShard returns the shard or null', () => {
  const q = new ShardQueue();
  const shard = q.createShard({ n: 64 });
  assert.equal(q.getShard(shard.id), shard);
  assert.equal(q.getShard('missing'), null);
});

test('resultsFor returns an empty array for a shard with no submissions', () => {
  const q = new ShardQueue();
  const shard = q.createShard({ n: 64 });
  assert.deepEqual(q.resultsFor(shard.id), []);
});

test('AssignmentState enum values are the strings submit()/expireLeases() rely on', () => {
  assert.equal(AssignmentState.ACTIVE, 'active');
  assert.equal(AssignmentState.SUBMITTED, 'submitted');
  assert.equal(AssignmentState.EXPIRED, 'expired');
});
