# ADR-0012: Challenge mode uses a single-submission gate, not the barter pipeline

Status: Accepted (2026-08-04)

## Context

M2.1–M2.4 built a verification pipeline for crowdsourced barter: a shard
queue with configurable redundancy, cross-worker consensus, a stake-derived
audit sampler, and a credit ledger that pays confirmed work and slashes
violations. That pipeline assumes three things are true of the party doing
the work: it has time to wait for redundant replicas before being paid, it
holds a persistent identity worth being accountable to, and it has posted
stake that can be forfeited.

None of those hold for the anti-bot use case ADR-0001 names as the flagship
deployable target. There, the "worker" is an anonymous site visitor's
browser, given one shot to prove it burned the required compute before being
let through a gate:

- **No time to wait.** The visitor is blocked on the result; waiting for a
  second independent replica to arrive and cross-check against is not a
  latency budget an anti-bot check can spend.
- **No persistent identity.** A first-time visitor has no account, no
  history, nothing a broker could hold accountable across sessions the way
  a crowdsourcing worker's identity is.
- **No stake.** ADR-0001 already establishes that challenge mode pays the
  client nothing — deterrence works by imposing cost, not by offering
  payment, which is also what keeps the SoK's proof-of-useful-work critique
  from applying to this mode. A party that is never paid has nothing to
  stake and nothing to slash.

Building `issueChallenge()`/`resolveChallenge()` on top of `ShardQueue`,
`reachConsensus()`, or `CreditLedger` would therefore mean carrying
assumptions into this mode that don't hold for it, for no benefit — the
extra machinery has nothing real to operate on.

## Decision

Challenge mode gets its own, structurally lighter path
(`packages/zkpoc-broker/src/challenge.js`):

- `issueChallenge(tier, o)` sizes and mints a single fresh shard directly
  (`tiers.js#chooseShardSize` + `shard.js#Shard`), independent of
  `ShardQueue`.
- `resolveChallenge(shard, result, o)` runs the single-submission gate alone
  (`verifyRowSubmission`, ADR-0011) and returns admit/deny. No redundancy, no
  consensus, no audit, no ledger interaction.
- A response's timing is reported as a ratio against the tier it was sized
  for (`timingRatio`), not used to auto-deny. A legitimate visitor's device
  may simply be faster than the sizing reference; conflating "fast" with
  "cheating" here would repeat the mistake ADR-0006/consensus.js's timing
  signal was already built to avoid. This ratio is the raw material for
  `bench/attacker_advantage.py`'s measurement instead — a real value, not a
  policy decision baked prematurely into the gate.

## Consequences

- Challenge mode's guarantee is strictly weaker than barter mode's: it rests
  on ADR-0011's probabilistic single-submission bound (evasion probability
  f^k) with no cross-worker correction, because there is no second worker.
  This is an accepted, load-bearing trade-off, not an oversight — it is
  exactly what the latency budget requires, and it matches how real anti-bot
  challenges (Turnstile, Anubis) already operate: one client, one check, one
  answer.
- If a future revision wants stronger assurance for challenge mode (e.g. a
  returning-visitor reputation system, or optional multi-round challenges
  for high-risk requests), it is a genuinely new mechanism to design, not an
  argument for retrofitting `ShardQueue`/`CreditLedger` underneath this path
  — those remain barter-mode-shaped by the reasoning above.
- Alternative considered and rejected: run challenge submissions through
  `ShardQueue` with `redundancy: 1`, to reuse the existing pipeline's code
  paths. Rejected because `redundancy: 1` degrades `reachConsensus()` to its
  own `INSUFFICIENT`/`UNCONFIRMED` branch (see consensus.js) — i.e. the
  "reuse" would immediately hit the code path that exists specifically to
  say "there is nothing here to reach consensus over," which is a sign the
  abstraction doesn't fit rather than a working simplification.
