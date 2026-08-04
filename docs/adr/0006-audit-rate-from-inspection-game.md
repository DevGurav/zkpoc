# ADR-0006: Audit rate set by an economic inspection game, not fixed sampling

Status: Accepted (2026-08-02)

## Context

Proving every shard's execution in zero knowledge is not economically viable:
the ZKML literature (arXiv:2502.18535) reports circuit-expansion factors of
10³–10⁴ for proving relative to the computation being proved, and zkVM
proving-time multiples are commonly quoted at 10⁵–10⁶. `bench/breakeven.py`'s
`VerificationPolicy.eta()` makes this concrete: at a 1% audit rate with
`proof_cost=1000`, sellable output per unit of work performed (`η`) drops to
0.083 — worse than not verifying at all in economic terms — and the naive
"prove 1% of shards" policy never clears the break-even bar against any
modelled ad market at any device tier (`report_policy_sensitivity()`).

Prior work in this space (zkVFL) sets the audit/proof rate via **anomaly-aware
sampling** — proving is triggered when a client's update looks statistically
unusual. That is a real and useful signal, but it optimises a different
objective (catching outliers) than the one this project needs (making
free-riding economically irrational at minimum verification cost).

## Decision

The audit rate is derived from an inspection game, not chosen as a fixed
percentage or triggered by anomaly detection. A free-rider who submits a
fabricated result gains credit for one shard; if caught (probability `a`, the
audit rate), they forfeit a stake worth `k` shards. Expected gain from
cheating is non-positive when:

```
(1 − a)·g − a·k·g ≤ 0   ⟹   a ≥ 1 / (1 + k)
```

So the *minimum viable* audit rate `a* = 1/(1+k)` is set by the stake size,
not chosen independently of it. `bench/breakeven.py`'s
`verification_feasibility()` shows the consequence directly: a stake worth
~10³–10⁴ shards drops the required audit rate low enough that `η` recovers to
economically survivable territory (0.33–0.48 at `proof_cost=1000`), because
the ZK proof only needs to be expensive per-shard *at the audit rate*, not on
average.

Redundancy (independent re-execution for consensus, factor `r`) and the ZK
audit are treated as two separate, composable verification mechanisms —
`η = 1/(r + a·c_proof)` — with redundancy catching the bulk of free-riding
cheaply and the audit providing the tail guarantee that makes the stake's
deterrence credible.

## Consequences

- This is the re-scoped form of the project's "tiered verification" claim
  (see the project plan's novelty recalibration): not "we sample instead of
  proving everything," which zkVFL already does via a different trigger, but
  "the sample rate is the solution to a stated economic optimisation," which
  is a different and citable claim.
- The stake mechanism this ADR assumes (crowdsourcing-style staking on task
  subscription) is designed but not yet implemented — it belongs to the M2
  broker, which is where this decision's assumptions (a stake exists, is
  slashable, and is worth `k` shards) become load-bearing rather than
  theoretical.
- This audit-rate policy applies to **challenge mode only** (ADR-0001). In
  barter mode the client is paid for its work, so the SoK's critique of
  utility-undermines-security-budget applies regardless of audit rate, and no
  anti-free-riding claim is made for that mode based on this mechanism.
- Alternative considered and rejected: fixed audit rate (e.g. always 1%),
  independent of stake or proof cost. Rejected because
  `verification_feasibility()` shows fixed rates are either too weak (audit
  rate too low relative to a small stake, so cheating remains profitable) or
  too expensive (audit rate high enough to deter with no stake, which
  destroys `η`) — there is no single fixed rate that is simultaneously safe
  and affordable across different stake sizes.
