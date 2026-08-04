# ADR-0015: Dual-use detector baselines reported environment-blocked, not run

Status: Accepted (2026-08-04)

## Context

The original plan named MinerRay, MINOS, and Delay-CJ as detector baselines
for M4's dual-use evaluation: run them against this system and report
whether they can tell it apart from covert cryptomining.
[ADR-0002](0002-legitimacy-by-declaration-not-detection.md) already
predicted and explained the expected outcome — a detector WASM
diversification evades in 100% of cases (MINOS) cannot certify legitimacy
either way — but the plan still called for actually running them.

None of the three are published, installable software. `npm view minos`,
`npm view minos-detector`, and `pip index versions minos` all resolve to
unrelated, generically-named packages, not the research artifacts from the
arXiv:2403.15197 lineage; MinerRay and Delay-CJ have no package-registry
presence under any plausible name. Reconstructing any of them would mean
reimplementing a research prototype from its paper alone, with no
verification the reimplementation matches the original's behavior — a
fundamentally different and much larger undertaking than "run the
baseline."

## Decision

Report the detector baselines as **environment-blocked**, matching the
precedent [ADR-0014](0014-m3-track1-toolchain-and-track2-blocked.md) already
set for M3 Track 2 (RISC Zero/SP1 needing a Rust toolchain unavailable in
this environment): a real, checkable tooling gap, named explicitly with what
would close it, rather than worked around with a fabricated result.

In its place, `docs/dual-use-evaluation.md` demonstrates the actual,
already-built positive path: the manifest/code-binding verification
mechanism ADR-0002 committed to as the real defense, exercised end to end
via `demo-flow.test.js`'s code-binding isolation test and the invariants in
`docs/BUILD.md` §2. This is not a substitute measurement standing in for the
missing detector runs — it is the mechanism ADR-0002 already named as the
one actually load-bearing, demonstrated on its own terms.

## Consequences

- No detector-evasion percentage is claimed for this specific system's
  kernels. The evasion rate cited (100% MINOS, ~90% VirusTotal) is
  arXiv:2403.15197's own published result for WASM diversification
  generally, cited as the reason detection cannot be the legitimacy
  mechanism — not re-measured here, and not attributed to this project's
  code.
- `docs/roadmap.md`'s M4 section records this sub-track as evaluated and
  closed via the declaration-based path, not as an open gap silently
  dropped from scope.
- Real future work is named, not attempted: obtaining the actual
  MinerRay/MINOS/Delay-CJ source (if released by their authors) or a
  faithful reimplementation from their papers, run against a live browser
  deployment of `packages/zkpoc-worker`'s kernels under each paper's own
  evaluation conditions.
- Alternative considered and rejected: reimplementing a detector from its
  paper description to have *something* to run. Rejected — an
  unvalidated reimplementation could produce a number that looks like
  evidence while measuring nothing about the actual published detectors,
  which is a worse outcome than reporting the gap plainly.
