# Architecture Decision Records

An ADR captures one architecturally significant decision: the context that
forced it, the decision itself, and the consequences — including the ones we
didn't want. It is a record of *why*, written at the time, before hindsight
sands off the reasoning. Format follows Michael Nygard's original template.

## Index

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-break-even-frontier-and-anti-bot-flagship.md) | Reframe from "compute replaces ads" to a break-even frontier, with anti-bot PoW as the flagship | Accepted |
| [0002](0002-legitimacy-by-declaration-not-detection.md) | Legitimacy by declaration (signed manifest), not miner detection | Accepted |
| [0003](0003-webgpu-mandatory.md) | WebGPU is mandatory; WASM-on-CPU is a fallback only | Accepted |
| [0004](0004-canonical-json-signing.md) | RFC 8785 canonical JSON for manifest signing | Accepted |
| [0005](0005-integral-share-control.md) | Integral, not per-burst, share control law in the governor | Accepted |
| [0006](0006-audit-rate-from-inspection-game.md) | Audit rate set by an economic inspection game, not fixed sampling | Accepted |
| [0007](0007-tiered-zk-proving-plan.md) | In-browser proving is Circom/Groth16; zkVM moves to settlement-side | Accepted |
| [0008](0008-tdsc-baseline-correction.md) | Use a corrected cryptojacking baseline, not the source paper's stated figure | Accepted |

## Adding one

Copy the template below into `docs/adr/000N-short-title.md`, number it
sequentially, and add a row to the index above. Status is one of *Proposed*,
*Accepted*, *Superseded by ADR-000M*, or *Rejected* (keep rejected ones — a
documented dead end saves the next person from re-deriving it).

```markdown
# ADR-000N: Title

Status: Accepted (YYYY-MM-DD)

## Context
What forced this decision. The constraint, the measurement, the failure.

## Decision
What we're doing, stated plainly.

## Consequences
What this buys us, and what it costs. Include the alternative(s) considered
and why they lost — a decision record with no rejected alternative usually
means the alternative was never seriously considered.
```
