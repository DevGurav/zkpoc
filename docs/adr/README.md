# Architecture Decision Records

An ADR captures one architecturally significant decision: the context that
forced it, the decision itself, and the consequences — including the ones we
didn't want. It is a record of *why*, written at the time, before hindsight
sands off the reasoning. Format follows Michael Nygard's original template.

## Why this project keeps them

Three of the records below (0008, 0010, 0011) exist because a first answer was
wrong and evidence caught it — 0011 is the first where the wrong answer was
this project's own prior design, not an external source. A fourth (0013) is a
different case worth distinguishing: nothing was wrong, a risk named before
any code existed was measured and confirmed exactly as predicted, and the
finding is recorded as-is rather than held back until a fix was attached to
it. Both cases are the actual value of an ADR log on a project like this one:
not just recording what was decided, but leaving a trail of what was tried,
what broke it or confirmed it, and what came next — which is exactly the
material a thesis defense or a code review will ask for, and exactly the
material that is easiest to lose once the code moves on.

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
| [0009](0009-energy-counter-not-instant-rate.md) | Measure watts via the integrated energy counter, not instantaneous discharge rate | Accepted |
| [0010](0010-sustained-trend-fit-not-quick-sweep.md) | F(d) comes from a sustained OLS trend fit, not a short sweep's spread threshold | Accepted |
| [0011](0011-commit-then-challenge-row-verification.md) | Commit-then-challenge row verification, replacing point-sample challenges | Accepted |
| [0012](0012-challenge-mode-single-submission-gate.md) | Challenge mode uses a single-submission gate, not the barter pipeline | Accepted |
| [0013](0013-measured-attacker-advantage-exceeds-memory-hard-control.md) | Measured attacker-advantage ratio exceeds the memory-hard control — reported, mitigation deferred | Accepted |
| [0014](0014-m3-track1-toolchain-and-track2-blocked.md) | M3 Track 1 toolchain (circom2/snarkjs/Hardhat 2), dependency isolation, Track 2 reported environment-blocked | Accepted |

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
