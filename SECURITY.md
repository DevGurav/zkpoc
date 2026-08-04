# Security

## Read this first if you're auditing this repo

This project builds infrastructure for running third-party code on a
visitor's device without their active attention. That is, structurally, what
cryptojacking is. The entire design exists to answer one question honestly:
*what makes this different from the thing it resembles?* — and the answer is
not "we promise it's different."

The answer is [ADR-0002](docs/adr/0002-legitimacy-by-declaration-not-detection.md):
**legitimacy comes from a signed, hash-bound, third-party-verifiable
declaration of what will run and under what limits — not from a claim that
the code is benign.** A signed manifest for a disguised miner is still a
miner; the manifest makes the actor accountable and attributable, which is
what actually distinguishes covert compute from consented compute. If you're
looking for a claim that this system can detect or prevent malicious use by
inspecting behaviour, that claim does not exist here on purpose — see below.

## Why detection-based defenses are explicitly not used

WASM binary diversification (semantically-equivalent recompilation) evades
the MINOS detector in **100% of cases** and VirusTotal in ~90%
(arXiv:2403.15197). A detector a real miner can evade completely provides
negative assurance if relied upon as a legitimacy signal — it would let this
project claim a security property that is already broken. The M4 dual-use
evaluation runs these detectors anyway, and the honest, expected outcome is
that they *cannot* reliably tell this system apart from covert mining by
inspection. That's a property of detection as an approach, not a defect
unique to this design, and it's exactly why the manifest/code-binding
mechanism exists as the actual defense — see
[ADR-0002](docs/adr/0002-legitimacy-by-declaration-not-detection.md).

## What is and isn't guaranteed, stated plainly

From [packages/zkpoc-ccm/SPEC.md](packages/zkpoc-ccm/SPEC.md#what-this-does-not-do):

- **Not guaranteed:** that the computation was performed correctly (that's a
  separate verification layer, planned for M2/M3 — see
  [docs/roadmap.md](docs/roadmap.md)).
- **Not guaranteed:** that the platform (browser, OS) actually obeyed the
  manifest. A user running a hostile or modified browser build has no
  recourse from the manifest alone.
- **Not guaranteed:** that a declared workload is honest work, only that it
  is attributable to a signed identity.
- **Not solved:** key distribution. Verifiers obtain issuer keys out of band;
  discovery and revocation-list infrastructure are unspecified in v1.

## What is currently enforced

- **Resource ceilings** (`cpu_share_max`, `gpu_share_max`,
  `duration_max_s`, `energy_max_mwh`) are enforced by the
  [`Governor`](packages/zkpoc-worker/API.md) at runtime by withholding
  scheduling time from the worker — not by asking the workload to
  self-limit. See [ADR-0005](docs/adr/0005-integral-share-control.md).
- **Code identity** is enforced by SHA-256 hash comparison
  (`code.worker`, `code.kernels[]`) between the signed manifest and the
  actually-loaded source. `verifyManifest()` treats missing loaded-code as a
  **failed** check, not a skipped one.
- **DOM/window isolation** is structural: execution happens in a dedicated
  Worker, which has no synchronous access to the page, so `data_access.dom:
  "none"` is a fact about the execution context, not an unverified promise.
- **Revocation** is unconditional and immediate — `Governor.revoke()`
  terminates the worker rather than waiting for it to finish its current
  unit of work.
- **Manifest tampering** (resource ceiling, duration, data-access scope,
  code hash, expiry) is caught by the signature over an RFC 8785 canonical
  serialisation — see [ADR-0004](docs/adr/0004-canonical-json-signing.md)
  and the mutation-coverage tests in
  [docs/testing-strategy.md](docs/testing-strategy.md).

## What is not yet enforced (tracked, not hidden)

- Storage and network denial (`data_access.storage`, `.network`) are manifest
  *claims* the embedding page is expected to enforce; there is no independent
  runtime proof of containment yet.
- There is no on-chain or third-party verification that a worker's *results*
  are correct — that's the redundancy/audit layer, designed in
  [ADR-0006](docs/adr/0006-audit-rate-from-inspection-game.md) but not yet
  implemented (M2).
- The staking/slashing mechanism the audit-rate policy assumes doesn't exist
  yet, so the economic deterrence argument in ADR-0006 is currently a design,
  not a running guarantee.

## Reporting a vulnerability

This is a student major project without a dedicated security contact channel
yet. If you find a real issue — a way to forge a valid-looking verification
result, bypass the share ceiling, or defeat revocation — please open a GitHub
issue marked `security`, or reach the maintainer through the contact listed
on the repository's GitHub profile. There is no bug bounty; there is a
genuine interest in not shipping something that's actually broken.

## Supported versions

Pre-release. There is one moving target (`main`), no tagged releases, and no
backport policy yet. `zkpoc-ccm/1` (the manifest schema version) is marked
**experimental** in its own spec and is expected to change.
