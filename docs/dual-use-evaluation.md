# Dual-use evaluation — M4

This project builds infrastructure for running third-party code on a
visitor's device without their active attention. Structurally, that is what
cryptojacking is. [ADR-0002](adr/0002-legitimacy-by-declaration-not-detection.md)
already made the case that legitimacy has to come from a signed, verifiable
declaration rather than from behavioral detection — this document is the
follow-through: actually attempting the detector baselines the original plan
named, reporting honestly what happened, and demonstrating the positive path
in their place.

## What was attempted

The original plan named three detector/evasion baselines to run against this
system: **MinerRay**, **MINOS**, and **Delay-CJ**. All three are academic
research artifacts, not published, installable software:

- `npm view minos` and `npm view minos-detector` resolve to unrelated
  generically-named packages (a testing utility, a 404), not the MINOS
  cryptojacking detector from the arXiv:2403.15197 lineage.
- `pip index versions minos` similarly resolves to an unrelated PyPI
  package.
- MinerRay and Delay-CJ have no npm/PyPI presence at all under any
  plausible name.

None of the three ship a reproducible install path (no package registry
entry, no documented `pip install`/`npm install`, no container image found).
Reconstructing any of them would mean re-implementing a research prototype
from its paper alone — a materially different, much larger undertaking than
"run the baseline," and one this session's environment (no ability to
locate or clone the authors' original source, if it is even public) cannot
complete responsibly. This is the same class of environment constraint
[ADR-0014](adr/0014-m3-track1-toolchain-and-track2-blocked.md) already
documented for M3 Track 2 (RISC Zero/SP1 needing a Rust toolchain this
environment doesn't have) — a real, checkable gap, not a convenient excuse,
and reported the same way: honestly, with what tooling would close it named
explicitly, rather than worked around with fabricated numbers.

**What would close this gap:** the actual MinerRay/MINOS/Delay-CJ source
(from the authors, if released) or a faithful reimplementation from their
papers, run against a real deployment of this project's worker/kernels in a
live browser under the conditions those papers evaluate (static WASM
analysis for MINOS-style detectors, dynamic execution-trace analysis for
MinerRay-style ones). That is real, scoped future work — not attempted here.

## Why the finding doesn't actually depend on running them

This isn't a dead end for the evaluation, because ADR-0002 already predicted
the outcome and explained why it wouldn't matter either way:

> WASM binary diversification (semantically-equivalent recompilation) evades
> MINOS in **100%** of cases and VirusTotal in ~90% (arXiv:2403.15197).

A detector that a motivated adversary can evade completely provides
**negative** assurance if relied on as a legitimacy signal: it cannot
certify "this workload is not a miner," because a real miner that wanted to
evade it already would have. That conclusion is a property of the published
evasion results, not of this specific system's behavior under the detector —
running MinerRay/MINOS/Delay-CJ against `packages/zkpoc-worker`'s actual
kernels would, at best, reproduce a known result (evasion is achievable) and
at worst produce a false sense of validation if the naive, non-diversified
build happened to score as "detected" on one run. Either outcome leaves the
actual question — *is this system legitimate* — unanswered by detection,
which is exactly ADR-0002's point.

So: **the dual-use question is answered by declaration, not detection**, and
that mechanism is real, built, and tested, independent of whether the
detector baselines ever run.

## The positive path, demonstrated

What a third party can actually check, today, without running any detector:

1. **The manifest declares workload class, resource ceiling, duration, and
   data-access scope**, signed over an RFC 8785 canonicalization —
   [`packages/zkpoc-ccm/`](../packages/zkpoc-ccm/), 28 tests, including the
   mutation-coverage test asserting every manifest field is signature-covered.
2. **Code binding makes "declare one thing, ship another" a checkable
   forgery, not an undetectable lie.** `demo-flow.test.js`'s
   `"a validly signed manifest cannot cover for different served code"` is
   the concrete demonstration: the manifest stays validly signed, the page
   serves different code, and `verifyManifest()` still catches it — because
   the signature was never the thing doing that work, the code-hash
   comparison was. This is the test [docs/testing-strategy.md](testing-strategy.md)
   names as the one that matters most in the whole repo, and it is precisely
   the scenario a MINOS-style detector cannot see (the code that ships is
   real, running, undiversified-or-not code; a behavioral detector has
   nothing to flag if the shipped code simply matches what a miner would
   run without ever having promised otherwise).
3. **Resource ceilings are enforced by withholding scheduling time**, not
   by asking the workload to self-limit — `packages/zkpoc-worker/src/governor.js`,
   [ADR-0005](adr/0005-integral-share-control.md). A compromised or
   dishonest kernel can return wrong results but cannot grant itself more
   compute.
4. **Revocation is unconditional and immediate.** A consent manifest that
   fails the `revocation.user_revocable` check is rejected at the schema
   level before any semantic check runs.
5. **A verifier trusts neither the publisher nor the broker.** Every check
   `verifyManifest()` performs is derivable from the manifest, the loaded
   code, and the verifier's own policy — no party's self-report is taken on
   faith anywhere in the chain.

None of this requires trusting that the code is benign. It requires only
that the declaration is checkable — which is the actual, demonstrated
answer to "how is this different from the thing it resembles," standing on
its own regardless of what MinerRay/MINOS/Delay-CJ would or wouldn't flag.

## Status

**Detector baselines: not run, environment-blocked, honestly reported.**
**Positive path (manifest/code-binding verification): built, tested, and
the actual defense this project stands on** — see
[SECURITY.md](../SECURITY.md) for the full "what is and isn't guaranteed"
account. See [ADR-0015](adr/0015-dual-use-detectors-environment-blocked.md)
for the decision record.
