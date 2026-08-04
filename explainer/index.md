# Compute Consent Manifest — Explainer

*Format follows the [W3C TAG explainer template](https://tag.w3.org/explainers/).*

## Authors

DevGurav ([github.com/DevGurav](https://github.com/DevGurav))

## Participate

This is a project-local explainer, not yet filed against a W3C Community
Group or WICG repository. See [Status](#status) below for exactly what that
means and what would need to be true before it should be.

## Introduction

A page that wants to run non-trivial client-side compute — WebGPU inference,
a WASM SIMD kernel, an anti-bot proof-of-work challenge — has no
standardized way to *declare* what it's about to do, and no standardized way
for anyone downstream (the browser, an extension, a third-party auditor) to
check that declaration against what actually runs.

The absence of that declaration is not a hypothetical gap. Covert in-browser
cryptomining is a well-documented abuse pattern, and the natural response —
detecting it by inspecting code or behavior — has a hard ceiling: WASM binary
diversification (semantically-equivalent recompilation) evades the MINOS
detector in **100% of cases** and VirusTotal in ~90% (arXiv:2403.15197). A
detector a motivated adversary can evade completely cannot certify that a
*legitimate* workload is not one, and the false-positive cost of trying falls
on real WebGPU/WASM applications.

The **Compute Consent Manifest** (CCM) is a signed, machine-readable
declaration — workload class, resource ceiling, duration, data-access
scope, and SHA-256 hashes of the exact code that will run — designed to be
checked by a party who trusts neither the page's publisher nor whatever
broker assigned the work. It does not try to solve detection. It replaces
the question "is this behaving like a miner?" with "did the signer declare
this, bind it to specific code, and can a third party verify both?" — a
question detection cannot answer but a signature can.

Full format specification: [`packages/zkpoc-ccm/SPEC.md`](../packages/zkpoc-ccm/SPEC.md).
Reference implementation: [`packages/zkpoc-ccm/`](../packages/zkpoc-ccm/) (28
tests), consumed by a reference resource governor
([`packages/zkpoc-worker/`](../packages/zkpoc-worker/)) that refuses to run
anything the manifest didn't verify.

## Goals

- Give a page a standard, machine-checkable way to declare: what class of
  workload it's running, how much of the device it may use, for how long,
  and what it may touch.
- Bind that declaration to the *specific code* that will execute, via
  content hashes, so "declare one thing, ship another" is a detectable
  forgery rather than an undetectable lie.
- Let a party who trusts **neither the publisher nor any broker involved**
  — the browser itself, a user's extension, an independent auditor —
  verify the declaration from the manifest and the loaded code alone.
- Make consent revocable. A declaration the user cannot immediately
  withdraw is not consent.
- Stay verifiable without new browser-engine changes at v1: the reference
  implementation is a JSON format plus a JS library using WebCrypto
  (ECDSA P-256, RFC 8785 canonical JSON), running entirely in userland. Any
  future browser-level integration (a `<meta>` declaration, a
  Permissions-Policy-like header, a built-in verifier) is out of scope for
  this document and listed under [Alternatives](#alternatives-considered),
  not proposed.

## Non-goals

- **This does not prove the computation was performed correctly.** That is
  a separate verification layer (redundancy consensus, stake-derived audit,
  and — for a bounded proof-of-concept kernel — a Groth16 circuit; see
  [`packages/zkpoc-broker/`](../packages/zkpoc-broker/) and
  [`circuits/`](../circuits/)). The manifest binds *which code runs*, not
  whether its output is trustworthy.
- **This does not prove the platform obeyed the manifest.** A user running
  a hostile or modified browser build has no recourse from the manifest
  alone. The manifest is a promise the *page* makes and a governor enforces
  at runtime by withholding scheduling time — not a guarantee about the
  browser itself.
- **This does not establish that the declared workload is honest work.** A
  signed manifest for a disguised miner is still a miner. What it adds is
  *accountability*: the workload is now attributable to a signed identity
  instead of anonymous. That is the actual distinction this format draws
  between covert and consented compute — not a claim about intent.
- **This does not solve key distribution.** Verifiers obtain issuer keys
  out of band in v1; discovery and revocation-list infrastructure are
  unspecified.
- **This is not a proposal for a new browser-enforced permission,** the way
  camera or geolocation access is. v1 is enforced by a userland governor the
  page itself runs (which a hostile page could simply not use) — see
  [Privacy and security considerations](#privacy-and-security-considerations)
  for why that's stated as a limitation, not glossed over.

## User research

None conducted independently of this project's own literature review. The
detection-evasion figures above (MINOS, VirusTotal) are third-party
measurements (arXiv:2403.15197), not original research. The economic
grounding for *why* a page might want to run consented compute at all —
correcting a canonical cryptojacking-yield figure by ~87×, and measuring the
break-even resource share against advertising — is this project's own
work; see [`bench/tdsc_reproduction.py`](../bench/tdsc_reproduction.py) and
[`bench/breakeven.py`](../bench/breakeven.py), and
[ADR-0008](../docs/adr/0008-tdsc-baseline-correction.md)/[ADR-0001](../docs/adr/0001-break-even-frontier-and-anti-bot-flagship.md).

## Use cases

1. **Anti-bot proof-of-work** (the primary deployable target — see
   [ADR-0001](../docs/adr/0001-break-even-frontier-and-anti-bot-flagship.md)).
   Cloudflare Turnstile, Friendly Captcha, ALTCHA, mCaptcha, and Anubis
   already run hash-based proof-of-work in this exact slot, at ~100% CPU
   for 1–3 seconds, on a large fraction of web requests — burning cycles
   for output nobody wants. A manifest-declared, verifiably-bounded useful
   workload (e.g. an ML inference shard whose output has real value to a
   compute buyer) can occupy the same slot without the waste, and lets a
   verifier confirm the workload stayed inside its declared ceiling
   instead of trusting the widget blindly.
2. **Consented crowdsourced compute.** A page that wants to trade metered
   spare compute for content access, rather than showing ads or requiring
   a subscription — the barter mode in
   [`packages/zkpoc-broker/`](../packages/zkpoc-broker/) — needs the same
   declaration so a user (or their browser) can see exactly what's being
   asked for before it runs.
3. **Third-party auditing of "trusted" origins.** A browser extension or
   security researcher wants to confirm that a page claiming to run a
   bounded, consented workload is not quietly running something else,
   without needing to trust the page's own claims or run a behavioral
   detector that a motivated page could evade.

## Detailed design

The manifest is a signed JSON document. Full shape, hard caps, and
verification-check table: [`packages/zkpoc-ccm/SPEC.md`](../packages/zkpoc-ccm/SPEC.md#document-shape).
Summarized:

```jsonc
{
  "v": "zkpoc-ccm/1",
  "issuer":  { "origin": "https://publisher.example", "key_id": "<JWK thumbprint>" },
  "workload": { "class": "ml-inference", "description": "…" },
  "code": {
    "worker":  "sha256-<base64>",
    "kernels": [ { "type": "wgsl", "hash": "sha256-<base64>" } ]
  },
  "limits": {
    "cpu_share_max": 0.05, "gpu_share_max": 0.05,
    "duration_max_s": 360, "energy_max_mwh": 40,
    "network": { "egress_bytes_max": 1048576, "allowed_origins": ["https://broker.example"] }
  },
  "data_access": { "storage": "none", "dom": "none", "sensors": "none", "cookies": "none" },
  "session": { "nonce": "…", "issued_at": "…", "expires_at": "…" },
  "revocation": { "user_revocable": true },
  "sig": { "alg": "ECDSA-P256-SHA256", "value": "…" }
}
```

Three properties make the declaration mean something rather than being
decorative JSON:

1. **Code binding.** `code.worker`/`code.kernels[]` are SHA-256 digests of
   the exact source that will execute. A verifier with the loaded source
   recomputes the digest and compares; a manifest with no loaded code to
   check against is a **failed** check, not a skipped one.
2. **Enforceable limits.** Every `limits` field maps onto something the
   reference governor actually caps at runtime by withholding CPU/GPU
   scheduling time from the worker — the schema admits no field nothing
   enforces.
3. **Structural containment where possible.** Execution happens in a
   dedicated Worker with no DOM access, so `data_access.dom: "none"` is a
   fact about the execution context in the reference implementation, not
   an unverified promise. Storage/network denial are currently manifest
   *claims* the embedder is expected to enforce — see
   [Non-goals](#non-goals).

Signing is ECDSA P-256/SHA-256 over an RFC 8785 (JCS) canonicalization —
`JSON.stringify` is explicitly not used, because key-insertion order would
make semantically identical manifests produce different signatures, and a
third party receiving the manifest over an untrusted channel needs to
recompute the signed bytes from the parsed object alone.
`verifyManifest()` runs eight checks independently (structure, signature,
key binding, validity window, nonce freshness, per-file code binding,
policy) and reports each one, so a UI or auditor can say precisely what
failed rather than showing an opaque pass/fail — see the check table in
[SPEC.md](../packages/zkpoc-ccm/SPEC.md#verification).

## Alternatives considered

- **A new browser-level permission**, analogous to camera/geolocation,
  gating high-resource compute APIs directly. Rejected for v1: it requires
  browser-engine buy-in this project cannot obtain from a standalone
  proof-of-concept, and the userland-governor approach is independently
  useful (any page can adopt it today, no browser changes required) while
  leaving that door open for a future revision — noted, not designed here.
- **Relying on behavioral detection instead of declaration.** Rejected
  outright — see [Introduction](#introduction) and
  [ADR-0002](../docs/adr/0002-legitimacy-by-declaration-not-detection.md).
  A detector a motivated adversary evades completely cannot be the
  legitimacy signal; this is the central design decision the whole format
  exists to embody, not a rejected footnote.
- **Ed25519 instead of ECDSA P-256** for signing. Rejected for v1 only
  because ECDSA P-256 is unflagged everywhere WebCrypto exists; a manifest
  format nobody's browser can verify defeats the purpose. Revisitable if
  WebCrypto Ed25519 support becomes universal.
- **Proving `data_access` containment cryptographically** rather than
  structurally/by convention. Real future work, tracked as Q4 in
  [`docs/BUILD.md`](../docs/BUILD.md) §5 — not attempted in v1.

## Privacy and security considerations

- **The manifest is not a browser-enforced sandbox.** It is enforced by a
  userland governor the page itself chooses to run. A page can simply not
  use it, the same way a page can simply not use CSP. What it changes is
  not "can a page misbehave" — a page can always misbehave — but "can a
  misbehaving page's declaration be checked against what it actually did,
  by someone who doesn't have to trust the page." That is a real
  security property (accountability, evidence, attributability) and a
  meaningfully weaker one than platform-enforced isolation; this document
  does not conflate the two.
- **Key distribution is unsolved in v1.** A verifier must obtain the
  issuer's public key out of band and confirm it independently — the
  manifest's own `issuer.key_id` is *bound to* a key via a JWK thumbprint,
  but nothing in the format tells a verifier that key is trustworthy in
  the first place. This is explicitly named rather than hand-waved; see
  [Non-goals](#non-goals).
- **A signed manifest does not vouch for intent.** A disguised miner can
  sign an honest-looking manifest and still be a miner running different,
  unhashed code — code binding is what catches *that* specific lie
  (declare one thing, ship another), not lies about intent that are
  internally consistent between declaration and execution. See
  `packages/zkpoc-ccm/SPEC.md`'s own "What this does not do" section,
  which this explainer deliberately mirrors rather than softens.
- **Revocation must be immediate and unconditional.** `revocation.user_revocable: true`
  is a hard schema requirement, not a default; a manifest failing this
  check is rejected at the structural-validation stage, before any
  semantic check runs.

## Stakeholder feedback

None solicited yet from browser vendors or standards bodies. This document
is the artifact that would accompany initial outreach — see
[`docs/outreach.md`](../docs/outreach.md) for the drafted (not sent) pitch
material and target list.

## Status

**Experimental, project-local — not filed with W3C or WICG.** `zkpoc-ccm/1`
is explicitly marked unstable in its own spec and expected to change as the
governor and verification layers mature. This explainer exists to make the
proposal legible to a standards audience *before* that filing, matching the
sequencing the project's original plan laid out (measured result → demo →
packages → explainer → targeted outreach) — not to claim standards-track
status this project does not have.
