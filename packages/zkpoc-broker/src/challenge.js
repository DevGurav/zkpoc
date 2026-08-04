/**
 * Challenge-mode protocol wrapper -- anti-bot proof-of-work, the flagship
 * deployable target (ADR-0001), not crowdsourced barter. Ties shard sizing
 * (tiers.js), fresh shard issuance (shard.js) and single-submission
 * verification (ADR-0011's gate) into the actual issue -> execute -> resolve
 * flow a real drop-in replacement for hashcash needs.
 *
 * THE MODE BOUNDARY, MADE CONCRETE
 * ----------------------------------
 * M2.1-M2.4 built a pipeline for crowdsourced barter: a worker is paid for
 * confirmed work, so multiple independent replicas, consensus, and an
 * audit-with-slashing layer all make sense -- there is time to wait for
 * redundancy, and a persistent staked identity to hold accountable.
 *
 * Challenge mode is structurally different, not just a smaller version of
 * the same thing:
 *   - the "worker" is an anonymous site visitor's browser, given ONE shot
 *     to prove it burned the required compute before being let through a
 *     gate -- there is no second visitor to cross-check against, and no
 *     time to wait for one even if there were;
 *   - there is no stake to slash, because an anonymous visitor has posted
 *     none, and no reward to pay, because deterrence in this mode works by
 *     imposing cost, not by offering payment (ADR-0001's boundary between
 *     the two modes -- barter pays the client, challenge does not, and the
 *     SoK critique of proof-of-useful-work applies only where the client is
 *     paid);
 *   - so verification is the single-submission gate alone (ADR-0011's k-row
 *     sample), admit or deny, full stop. Reaching for consensus.js or
 *     ledger.js here would be reintroducing barter-mode assumptions into a
 *     mode that was designed specifically not to need them -- see
 *     ADR-0012.
 *
 * A response that verifies but arrives faster than the tier the challenge
 * was sized for could plausibly finish is not treated as an automatic deny
 * here (a legitimate visitor's device may simply be faster than the sizing
 * reference). It is surfaced as a timing ratio instead, because that exact
 * signal -- how much faster real attacker hardware solves the same shard
 * than the honest reference tier -- is the raw material the
 * attacker-advantage-ratio measurement (bench/attacker_advantage.py) is
 * built from.
 */

import { chooseShardSize } from './tiers.js';
import { Shard, verifyRowSubmission } from './shard.js';
import { freshNonce } from './queue.js';

export const ChallengeOutcome = Object.freeze({
  ADMIT: 'admit',
  DENY: 'deny',
});

/**
 * Issue a challenge: a fresh shard sized for a target wall-clock time on a
 * specific, already-measured device tier.
 *
 * Deliberately takes a `DeviceTier` object, not a tier name -- resolving an
 * unmeasured tier name to a guess is exactly what tiers.js#resolveTier
 * refuses to do, and this function trusts that refusal already happened
 * upstream rather than re-deciding it here.
 *
 * @param {DeviceTier} tier
 * @param {object} [o]  forwarded to chooseShardSize (targetWallSeconds,
 *   maxOverheadFraction, granularity)
 * @param {string} [o.id]
 * @returns {{shard:Shard, sizing:object, issuedAt:number}}
 */
export function issueChallenge(tier, o = {}) {
  const sizing = chooseShardSize(tier, o);
  const issuedAt = Date.now();
  const shard = new Shard({
    id: o.id ?? `challenge-${freshNonce(8)}`,
    n: sizing.n,
    sessionNonce: freshNonce(),
    tierName: tier.name,
    issuedAt,
  });
  return { shard, sizing, issuedAt };
}

/**
 * Resolve a single challenge response: verify it, decide admit or deny, and
 * report the timing ratio against the tier it was sized for.
 *
 * @param {Shard} shard
 * @param {ShardResult} result
 * @param {object} [o]
 * @param {number} [o.expectedWallSeconds]  from issueChallenge's `sizing`;
 *   if omitted, timingRatio is null rather than guessed at
 * @param {number} [o.elapsedMs]  wall-clock time the caller observed for
 *   this response, independent of anything the client self-reports
 * @returns {Promise<{outcome:string, gate:object, timingRatio:number|null}>}
 */
export async function resolveChallenge(shard, result, o = {}) {
  const gate = await verifyRowSubmission(shard, result, o);
  const outcome = gate.ok ? ChallengeOutcome.ADMIT : ChallengeOutcome.DENY;

  let timingRatio = null;
  if (o.expectedWallSeconds && o.elapsedMs != null) {
    // < 1 means faster than the reference tier -- the exact quantity
    // bench/attacker_advantage.py turns into a cost-asymmetry figure.
    timingRatio = (o.elapsedMs / 1000) / o.expectedWallSeconds;
  }

  return { outcome, gate, timingRatio };
}
