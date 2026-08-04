/**
 * Shard queue and assignment lifecycle.
 *
 * The queue owns three things that are easy to get subtly wrong:
 *
 *   1. FRESHNESS. Every shard is minted with a CSPRNG nonce, which seeds its
 *      inputs (see shard.js). Work is therefore unpredictable until issued and
 *      fully reproducible afterwards -- the property that lets useful work
 *      stand in for a hash puzzle without becoming precomputable.
 *
 *   2. REPLICA INDEPENDENCE. Redundancy consensus is worthless if the same
 *      worker can answer for the same shard twice: two copies of one worker's
 *      answer agree by construction, including when that answer is a lie. The
 *      queue enforces distinct worker identities per shard.
 *
 *   3. LEASES. A worker that takes a shard and vanishes must not strand it.
 *      Assignments expire and the work returns to the pool.
 *
 * What the queue explicitly does NOT provide is Sybil resistance. It enforces
 * distinct worker *identities*, but identities are cheap -- one adversary can
 * present as many. Making identity expensive is the stake's job (M2.4), and
 * no amount of queue bookkeeping substitutes for it. Stated here because
 * "assignments go to distinct workers" reads like a stronger guarantee than
 * it is.
 */

import { Shard } from './shard.js';

/** CSPRNG-backed nonce. Freshness is a security property, not a formality. */
export function freshNonce(bytes = 18) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Why an assignment ended. Retained for consensus and for operator insight. */
export const AssignmentState = Object.freeze({
  ACTIVE: 'active',
  SUBMITTED: 'submitted',
  EXPIRED: 'expired',
});

export class ShardQueue {
  /**
   * @param {object} [o]
   * @param {number} [o.redundancy=2]  independent results required per shard
   * @param {number} [o.leaseMs=30000] how long a worker holds an assignment
   * @param {number} [o.maxAttempts=8] give up on a shard after this many leases
   * @param {() => number} [o.now]     injectable clock, for deterministic tests
   */
  constructor(o = {}) {
    const {
      redundancy = 2, leaseMs = 30_000, maxAttempts = 8, now = Date.now,
    } = o;
    if (!Number.isInteger(redundancy) || redundancy < 1) {
      throw new RangeError('redundancy must be a positive integer');
    }
    if (!(leaseMs > 0)) throw new RangeError('leaseMs must be > 0');

    this.redundancy = redundancy;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this._now = now;

    /** @type {Map<string, object>} shardId -> record */
    this._shards = new Map();
    this._order = [];          // FIFO over shardIds
    this._seq = 0;
  }

  /**
   * Mint and enqueue a shard with a fresh nonce.
   *
   * The nonce is generated here rather than accepted from a caller so that a
   * publisher cannot supply a nonce it precomputed work for.
   */
  createShard({ n, tierName = null, id = null }) {
    const shard = new Shard({
      id: id ?? `shard-${++this._seq}`,
      n,
      sessionNonce: freshNonce(),
      tierName,
      issuedAt: this._now(),
    });
    this.enqueue(shard);
    return shard;
  }

  enqueue(shard) {
    if (this._shards.has(shard.id)) {
      throw new Error(`shard ${shard.id} already queued`);
    }
    this._shards.set(shard.id, {
      shard,
      assignments: new Map(),   // workerId -> {assignedAt, expiresAt, state}
      results: new Map(),       // workerId -> {result, assignedAt, submittedAt}
      attempts: 0,
      completed: false,
      abandoned: false,
    });
    this._order.push(shard.id);
    return shard;
  }

  /**
   * Hand a worker something to do, or null if nothing is eligible.
   *
   * A shard is eligible for worker W when it still needs replicas, W has not
   * already held or answered it, and it has not been abandoned.
   */
  assign(workerId) {
    if (!workerId) throw new TypeError('assign requires a workerId');
    this.expireLeases();
    const now = this._now();

    for (const id of this._order) {
      const rec = this._shards.get(id);
      if (!rec || rec.completed || rec.abandoned) continue;

      // Replica independence: one answer per identity, ever -- including
      // across expired leases, so a worker cannot retry its way into
      // occupying two of the replica slots for one shard.
      if (rec.assignments.has(workerId) || rec.results.has(workerId)) continue;

      const outstanding = [...rec.assignments.values()]
        .filter((a) => a.state === AssignmentState.ACTIVE).length;
      if (rec.results.size + outstanding >= this.redundancy) continue;

      rec.assignments.set(workerId, {
        assignedAt: now,
        expiresAt: now + this.leaseMs,
        state: AssignmentState.ACTIVE,
      });
      rec.attempts++;
      return {
        shard: rec.shard,
        workerId,
        assignedAt: now,
        expiresAt: now + this.leaseMs,
      };
    }
    return null;
  }

  /**
   * Accept a result against an active assignment.
   *
   * Returns a structured verdict rather than throwing: an unexpected or late
   * submission is normal operation in a distributed system, not an error, and
   * the caller needs the reason to decide whether it indicates misbehaviour.
   *
   * Note this does NOT judge correctness -- that is consensus (M2.3). The
   * queue only decides whether the submission is admissible at all.
   *
   * @returns {{accepted:boolean, reason:string|null, replicas:number,
   *            complete:boolean}}
   */
  submit(result) {
    const rec = this._shards.get(result.shardId);
    if (!rec) {
      return { accepted: false, reason: 'unknown shard', replicas: 0, complete: false };
    }
    const assignment = rec.assignments.get(result.workerId);
    if (!assignment) {
      // Either never assigned, or assigned and already expired-and-purged.
      return {
        accepted: false,
        reason: 'no assignment for this worker',
        replicas: rec.results.size,
        complete: rec.completed,
      };
    }
    // Checked before the state test below: once a worker's first submission
    // sets its assignment to SUBMITTED, that same state would otherwise match
    // the generic "assignment is X" branch on every retry, making this more
    // specific and more actionable reason permanently unreachable.
    if (rec.results.has(result.workerId)) {
      return {
        accepted: false, reason: 'duplicate submission',
        replicas: rec.results.size, complete: rec.completed,
      };
    }
    if (assignment.state !== AssignmentState.ACTIVE) {
      return {
        accepted: false,
        reason: `assignment is ${assignment.state}`,
        replicas: rec.results.size,
        complete: rec.completed,
      };
    }

    const now = this._now();
    assignment.state = AssignmentState.SUBMITTED;
    rec.results.set(result.workerId, {
      result,
      assignedAt: assignment.assignedAt,
      submittedAt: now,
      // Retained for M2.3: a result returned faster than the work could
      // physically take is evidence on its own, independent of its value.
      elapsedMs: now - assignment.assignedAt,
    });

    if (rec.results.size >= this.redundancy) rec.completed = true;
    return {
      accepted: true, reason: null,
      replicas: rec.results.size, complete: rec.completed,
    };
  }

  /**
   * Reclaim assignments whose lease ran out.
   *
   * Idempotent and safe to call often; `assign()` calls it first so a caller
   * never has to remember to.
   */
  expireLeases() {
    const now = this._now();
    let expired = 0;
    for (const rec of this._shards.values()) {
      if (rec.completed || rec.abandoned) continue;
      for (const [workerId, a] of rec.assignments) {
        if (a.state === AssignmentState.ACTIVE && now >= a.expiresAt) {
          a.state = AssignmentState.EXPIRED;
          a.expiredAt = now;
          expired++;
        }
      }
      // A shard nobody ever completes must not be retried forever.
      if (rec.attempts >= this.maxAttempts && rec.results.size < this.redundancy) {
        const outstanding = [...rec.assignments.values()]
          .filter((a) => a.state === AssignmentState.ACTIVE).length;
        if (outstanding === 0) rec.abandoned = true;
      }
    }
    return expired;
  }

  /** All admitted results for a shard, in submission order. */
  resultsFor(shardId) {
    const rec = this._shards.get(shardId);
    return rec ? [...rec.results.values()] : [];
  }

  getShard(shardId) {
    return this._shards.get(shardId)?.shard ?? null;
  }

  /** Shards with a full replica set, ready for consensus. */
  completedShardIds() {
    return this._order.filter((id) => this._shards.get(id)?.completed);
  }

  /** Shards that ran out of attempts without ever completing. */
  abandonedShardIds() {
    return this._order.filter((id) => this._shards.get(id)?.abandoned);
  }

  get stats() {
    let pending = 0, completed = 0, abandoned = 0, active = 0;
    for (const rec of this._shards.values()) {
      if (rec.abandoned) abandoned++;
      else if (rec.completed) completed++;
      else pending++;
      active += [...rec.assignments.values()]
        .filter((a) => a.state === AssignmentState.ACTIVE).length;
    }
    return {
      total: this._shards.size, pending, completed, abandoned,
      activeAssignments: active, redundancy: this.redundancy,
    };
  }
}
