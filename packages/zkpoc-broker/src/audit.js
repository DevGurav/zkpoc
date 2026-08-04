/**
 * Audit rate derivation and unpredictable audit selection.
 *
 * TWO SEPARATE QUESTIONS, KEPT SEPARATE
 * --------------------------------------
 * 1. "How OFTEN must we audit a worker with stake k?" -- an economic
 *    question, answered by minAuditRate(), mirroring the inspection-game
 *    formula already derived and measured in bench/breakeven.py's
 *    min_audit_rate(): a* = 1/(1+k). A free-rider who fabricates a result
 *    gains g (one shard's credit); caught with probability a, they forfeit a
 *    stake worth k*g. Expected gain is non-positive when a >= 1/(1+k). A
 *    larger stake buys a smaller required audit rate, which is what keeps
 *    expensive verification (M3's ZK proofs, or this module's placeholder
 *    full-disclosure audit) economically survivable -- see
 *    docs/adr/0006-audit-rate-from-inspection-game.md.
 *
 * 2. "WHICH specific submission gets audited?" -- a security question.
 *    The selection draw must be unpredictable to the worker before it
 *    commits, for the same reason challengeRows() in shard.js is derived
 *    from the worker's own root rather than from public shard data alone
 *    (ADR-0011): a predictable audit schedule is one a rational free-rider
 *    simply avoids. auditDraw() reuses that pattern.
 *
 * WHAT "AUDIT" MEANS HERE, PENDING M3
 * -------------------------------------
 * M3's ZK circuits (ADR-0007) don't exist yet. Rather than block M2.4 on
 * them, an audit here is modelled as its own well-defined, already-testable
 * operation: full-disclosure re-verification, i.e. verifyRowSubmission()
 * with k = shard.n instead of DEFAULT_CHALLENGE_ROWS -- every row checked,
 * not a probabilistic sample. This is the honest stand-in for "prove it,"
 * not a weaker approximation of it: a worker that passes a full-disclosure
 * audit really did compute the whole shard, with certainty rather than
 * probability. What M3 changes is the COST of getting that certainty (a
 * succinct proof instead of transmitting every row), not the correctness
 * question being asked. auditFull() is written so a real ZK verifier can
 * replace its body later without changing its contract.
 */

import { challengeRows, verifyRowSubmission } from './shard.js';

/**
 * Minimum audit rate that makes free-riding non-profitable, for a worker
 * whose stake is worth `stakeShards` shards' credit. Mirrors
 * bench/breakeven.py#min_audit_rate exactly -- same formula, same name for
 * the parameter's meaning, so the two are trivially comparable rather than
 * silently drifting apart. See docs/BUILD.md §1 for the carried constant
 * this must not silently redefine.
 *
 * @param {number} stakeShards  k >= 0
 */
export function minAuditRate(stakeShards) {
  if (!(stakeShards >= 0)) {
    throw new RangeError(`stakeShards must be >= 0, got ${stakeShards}`);
  }
  return 1 / (1 + stakeShards);
}

/**
 * Deterministic pseudo-random draw in [0, 1), seeded by (shard, submitted
 * root) -- unknown to the worker before it commits, exactly like
 * challengeRows(). Reuses challengeRows() itself as the entropy source
 * rather than inventing a second derivation: requesting a draw of "rows"
 * from a virtual shard of size 2^31 and folding the first index down to
 * [0,1) is simpler than a parallel mixing function, and correctness here
 * only needs uniformity, not cryptographic strength beyond what the
 * SHA-256 root already provides.
 */
export function auditDraw(shard, root) {
  // challengeRows() already accepts either a hex string or raw bytes for
  // `root` and only reads `.seed`/`.n` off the shard argument, so a minimal
  // stand-in object is sufficient -- no need to duplicate its hex handling.
  const virtual = { seed: shard.seed, n: 0x7fffffff };
  const [index] = challengeRows(virtual, root, 1);
  return index / 0x7fffffff;
}

/**
 * Decide whether a specific submission must be audited.
 *
 * `force` exists for the one case where the probabilistic draw must be
 * bypassed entirely: a shard consensus (consensus.js) could not resolve --
 * DISPUTED status, or a specific worker landing in MINORITY -- has to be
 * audited regardless of what the stake-derived rate would otherwise say,
 * because redundancy alone already failed to settle it. See
 * docs/roadmap.md's M2 section: this is where disputed shards get resolved.
 *
 * @param {Shard} shard
 * @param {string} root
 * @param {number} stakeShards
 * @param {object} [o]
 * @param {boolean} [o.force=false]
 * @returns {{audit:boolean, rate:number, draw:number, forced:boolean}}
 */
export function shouldAudit(shard, root, stakeShards, o = {}) {
  const rate = minAuditRate(stakeShards);
  const draw = auditDraw(shard, root);
  const forced = !!o.force;
  return { audit: forced || draw < rate, rate, draw, forced };
}

/**
 * Full-disclosure audit: verify EVERY row, not a k-row sample. See the
 * module docstring for why this is a legitimate stand-in for a ZK proof
 * rather than a weaker placeholder -- it answers the same question with
 * certainty instead of the probabilistic f^k bound the original submission
 * carries.
 *
 * Requires the worker to have retained every row it computed (a real worker
 * must cache this locally to be able to respond to an audit at all -- it is
 * not reconstructable from the original k-row submission, which is the
 * whole point of the original scheme being cheap). Non-response to an audit
 * request is therefore its own signal, distinct from a failed audit --
 * callers should treat "no disclosure provided" as a rejection, not retry
 * silently.
 *
 * @param {Shard} shard
 * @param {ShardResult} fullDisclosure  a result whose `rows` cover every
 *   index 0..shard.n-1 for the SAME root as the original submission
 * @param {object} [o]  forwarded to verifyRowSubmission (tolerance, ...)
 * @returns {Promise<{ok:boolean, checkedRows:number[], failures:Array,
 *                     worstError:number}>}
 */
export async function auditFull(shard, fullDisclosure, o = {}) {
  return verifyRowSubmission(shard, fullDisclosure, { ...o, k: shard.n });
}
