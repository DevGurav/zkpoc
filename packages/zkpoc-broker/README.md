# @zkpoc/broker

Shard model, tier-aware sizing, commit-then-challenge verification,
redundancy consensus, stake-derived audit, and a credit ledger — the
multi-client verification layer for consented browser compute. Splits into
two structurally separate pipelines, deliberately not sharing a
verification or reward path:

- **Barter** — crowdsourced compute, a worker paid for confirmed work.
- **Challenge** — anti-bot proof-of-work, useful work substituted into the
  slot hashcash-style widgets (Cloudflare Turnstile, Anubis, ALTCHA...)
  occupy today. See
  [`@zkpoc/challenge`](https://github.com/DevGurav/zkpoc/tree/main/packages/zkpoc-challenge)
  for the client-side solver.

Part of [ZK-PoC](https://github.com/DevGurav/zkpoc), a consent-governed,
verifiable browser-compute project. Zero runtime dependencies.

```js
import {
  LAPTOP_IGPU, chooseShardSize,
  issueChallenge, resolveChallenge, ChallengeOutcome,
} from '@zkpoc/broker';

// Server side: issue a challenge sized for ~2s of GPU compute on a
// measured device tier.
const { shard } = issueChallenge(LAPTOP_IGPU, { targetWallSeconds: 2 });
// ...send shard.toJSON() to the client, which solves it (@zkpoc/challenge)...

// Then verify the response:
const { outcome } = await resolveChallenge(shard, submittedResult, {});
if (outcome === ChallengeOutcome.ADMIT) proceed();
```

## Why commit-then-challenge

An earlier design derived the verification challenge from public shard data
alone, which let a worker compute just the checked points and skip the real
O(n³) computation entirely. The fix: a worker Merkle-commits every output
row first, and the challenge is derived from *that root* via Fiat-Shamir —
so a valid root costs the real computation, full stop. See
[ADR-0011](https://github.com/DevGurav/zkpoc/blob/main/docs/adr/0011-commit-then-challenge-row-verification.md).

## What's in here

| Module | What it does |
| --- | --- |
| `tiers` | Device-tier shard sizing from measured constants; refuses to guess for an unmeasured tier |
| `shard`, `merkle` | Deterministic-but-fresh shard inputs, row-level Merkle commitment, Fiat-Shamir challenge derivation |
| `queue` | Lease-based multi-worker assignment, replica independence |
| `consensus` | Per-submission gate plus majority/dispute tally |
| `audit`, `ledger` | Stake-derived audit rate (an economic inspection game, not fixed sampling), stake/reward/slash |
| `challenge` | The anti-bot single-submission protocol (issue/resolve), deliberately not built on the barter pipeline above |

## Status

Experimental — API surface may still change. 170 tests.

## License

MIT OR Apache-2.0.
