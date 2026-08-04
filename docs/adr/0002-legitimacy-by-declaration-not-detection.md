# ADR-0002: Legitimacy by declaration (signed manifest), not miner detection

Status: Accepted (2026-08-02)

## Context

Every prior system in this space — including the original synopsis — treats
the problem as *distinguishing* legitimate background compute from covert
cryptomining, typically via a classifier (MinerRay, MINOS, Delay-CJ-style
detectors) trained on execution traces or static features.

This doesn't work, and the failure isn't a tuning problem:

- WASM binary diversification (semantically-equivalent recompilation) evades
  MINOS in **100%** of cases and VirusTotal in ~90% (arXiv:2403.15197).
- The underlying task — telling apart two programs that perform the same
  floating-point-heavy computation, one with consent and one without — has no
  feature that consent changes. Consent is not a property of the bytecode.

A detector a miner can evade completely provides **negative** assurance: it
cannot be used to say "this workload is not a miner," because a real miner
that wanted to evade it already would have. Building the project's legitimacy
claim on top of such a detector would mean the central security property is
already broken on day one.

## Decision

Legitimacy is established by **declaration and binding**, not detection. The
Compute Consent Manifest (`packages/zkpoc-ccm/`) is a signed, structured
document that:

1. **Binds code, not behaviour.** SHA-256 digests of the exact worker and
   kernel sources that will execute (`code.worker`, `code.kernels[]`). A
   verifier who has *both* the manifest and the loaded source can check they
   match; `verifyManifest()` treats a missing `loadedCode` as a **failed**
   check, not a skipped one — an unbound declaration is not evidence of
   anything.
2. **States enforceable limits, not intentions.** Every `limits` field maps to
   something the governor can withhold at runtime by controlling scheduling
   time (ADR-0005). The schema admits no field nothing enforces.
3. **States a containment scope, backed structurally where possible.**
   `data_access: {dom: "none", ...}` is true because execution happens in a
   dedicated Worker with no DOM access, not because the manifest asserts it.

Verification never asks "does this look like a miner?" It asks "does the
signature verify, does the loaded code hash to what was declared, and does
the declaration fit my policy?" — three questions with objective, checkable
answers.

## Consequences

- The corollary is uncomfortable but has to be stated plainly: a *signed*
  manifest for a workload that turns out to be a disguised miner is still a
  miner. This system does not prove intent is honest — it makes the actor
  **accountable and attributable**, which is the actual difference between
  covert and consented compute, not a guarantee of good behaviour.
- The M4 dual-use evaluation is reframed accordingly: running MINOS/Delay-CJ
  baselines against this system is expected to show it is *not* reliably
  distinguishable from covert mining by detection — and that is reported as a
  finding about the limits of detection, not a failure of the design, with the
  positive claim resting on the manifest-verification path instead.
- Key distribution and revocation-list infrastructure are explicitly **out of
  scope for v1** (`packages/zkpoc-ccm/SPEC.md`, "What this does not do").
  Verifiers obtain issuer keys out of band. This is a known gap, not an
  oversight.
- Alternative considered and rejected: detector-based classification as the
  primary legitimacy signal, with the manifest as a secondary UX layer.
  Rejected because it would make the strongest published attack against this
  class of system (WASM diversification) a direct break of the *primary*
  security claim rather than an irrelevant footnote.
