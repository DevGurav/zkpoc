# ADR-0017: Scope narrowed to laptop/desktop; mobile excluded

Status: Accepted (2026-08-04)

## Context

`bench/breakeven.py`'s `DEFAULT_TIERS` and `docs/device-tiers.md` carried six
device classes from the project's earliest planning, two of them mobile
(`mobile-gpu`, `mobile-cpu`). Mobile phones have materially less headroom
than a laptop or desktop on every axis this project's governor already has
to manage carefully even on laptop-class hardware: sustained thermal budget,
battery capacity, and — per the measured attacker-advantage finding
([ADR-0013](0013-measured-attacker-advantage-exceeds-memory-hard-control.md))
— the GPU/CPU throughput gap that makes challenge-mode deterrence weaker on
exactly the devices with the least powerful GPU relative to what an attacker
can rent. None of the actual runtime code
(`packages/zkpoc-worker`, `packages/zkpoc-broker`, `packages/zkpoc-ccm`) is
mobile-specific — `tiers.js#KNOWN_TIERS` already contains only the one
measured tier (`LAPTOP_IGPU`) — so this was a scoping question in the
economic model and documentation, not a runtime capability question.

## Decision

Laptop and desktop only. `bench/breakeven.py`'s `DEFAULT_TIERS` drops
`mobile-gpu` and `mobile-cpu`, leaving four tiers: `desktop-dgpu`,
`laptop-dgpu`, `laptop-igpu` (the one measured tier), `laptop-cpu`.
`docs/device-tiers.md` and `docs/BUILD.md` §1/§5 (Q3) are updated to match.
`bench/attacker_advantage.py`'s `PLACEHOLDER_TIERS` context table drops the
mobile entries too — its actual measured ratio (107.2 GPU / 0.59 CPU
GFLOPS, both on the same laptop) was never a mobile measurement in the
first place, so this is a documentation-accuracy fix, not a change to the
finding.

## Consequences

- `docs/BUILD.md` §5 Q3 narrows from "five of six tiers unmeasured" to
  "three of four" — a smaller, more tractable remaining measurement
  surface, not a weaker claim.
- Historical text that quotes the *original* risk framing verbatim
  ("an attacker...may enjoy a larger advantage over an honest mobile
  user" — `docs/BUILD.md`'s M2 design contract, quoted in
  [ADR-0013](0013-measured-attacker-advantage-exceeds-memory-hard-control.md)
  and `bench/attacker_advantage.py`'s docstring) is left as-is: it is a
  record of how the risk was framed *before* this scoping decision, and
  rewriting it would misrepresent that history. Going forward, read
  "mobile" in that historical framing as shorthand for "an honest,
  non-GPU-equipped participant" (which `laptop-cpu` already represents) —
  the underlying GPU/CPU asymmetry the finding is about does not depend on
  the honest device being literally a phone, and the measured 181.7× ratio
  was always a same-laptop GPU-vs-CPU comparison, not a phone measurement.
- The Compute Consent Manifest format, the governor's throttle signals
  (interaction, frames, thermal proxy, battery), and the challenge protocol
  are unaffected — none of them are mobile-specific, and a laptop has a
  battery too, so the battery signal stays relevant.
- Alternative considered and rejected: keep mobile tiers as
  literature-anchored placeholders indefinitely, on the theory that more
  modeled tiers is strictly more informative. Rejected — carrying tiers
  this project has no intention of ever measuring, on hardware whose
  resource ceiling makes the barter/challenge economics even less
  favorable than the laptop case already measured, adds surface area
  without adding a claim anyone can act on.
