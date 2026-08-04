# Compute Consent Manifest — `zkpoc-ccm/1`

A signed, machine-readable declaration of what a page intends to compute on a
visitor's device: which workload, how much of the machine, for how long, and
what it may touch. Designed to be checked by a party who trusts neither the
publisher nor the broker.

## Why declaration rather than detection

Covert in-browser compute cannot be reliably detected. WASM binary
diversification evades MINOS in **100%** of cases and VirusTotal in ~90%
(arXiv:2403.15197); the broader detector/evader literature has the shape of
every other arms race. A detector a miner escapes completely cannot certify
that a *legitimate* workload is not a miner — the question is undecidable in
practice, and the false-positive cost falls on legitimate WebAssembly and
WebGPU applications.

So legitimacy has to be **asserted and bound**, not inferred. That only helps
if the assertion is hard to lie about, which is what the three structural
properties below are for.

### 1. Code binding

`code.worker` and `code.kernels[]` carry SRI-style SHA-256 digests of the exact
sources that will execute. Without this, a manifest declares one thing and the
page ships another, and the whole document is theatre. A verifier that has the
loaded sources recomputes the digests and compares.

`verifyManifest()` treats a *missing* `loadedCode` as a **failed** check, not a
skipped one. An unbound declaration is not evidence.

### 2. Enforceable limits

Every field under `limits` maps onto something a governor can actually cap at
runtime by withholding scheduling time. The schema deliberately admits no
field that nothing enforces, because a limit no component checks is marketing.

The reference governor (`@zkpoc/worker`) derives its ceiling solely from the
manifest and refuses to start when verification fails.

### 3. Containment scope

`data_access` is the reverse direction — what the platform promises *not* to
touch. In this version it is a declaration backed by structural enforcement:
execution happens in a dedicated Worker, which has no DOM, no `window`, and no
synchronous page access, so `dom: "none"` is a property of the execution
context rather than a promise. Storage and network can be denied by the
embedder. A future revision can back the claim with a proof rather than a
context guarantee.

## Document shape

```jsonc
{
  "v": "zkpoc-ccm/1",
  "issuer":  { "origin": "https://publisher.example", "key_id": "<JWK thumbprint>" },
  "workload": {
    "class": "ml-inference",              // ml-inference|ml-training|render|scientific|benchmark
    "description": "quantized GEMM inference shard",
    "buyer": "optional"
  },
  "code": {
    "worker":  "sha256-<base64>",
    "kernels": [ { "type": "wgsl", "hash": "sha256-<base64>" } ]   // wgsl|wasm|js
  },
  "limits": {
    "cpu_share_max": 0.05,                // (0, 0.90]
    "gpu_share_max": 0.05,                // (0, 0.90]
    "duration_max_s": 360,                // [1, 3600]
    "energy_max_mwh": 40,                 // optional
    "network": {
      "egress_bytes_max": 1048576,
      "allowed_origins": ["https://broker.example"]
    }
  },
  "data_access": {                        // none|session|persistent
    "storage": "none", "dom": "none", "sensors": "none", "cookies": "none"
  },
  "session": {
    "nonce": "<>=16 chars>",
    "issued_at":  "2026-08-03T12:00:00.000Z",
    "expires_at": "2026-08-03T12:15:00.000Z"
  },
  "revocation": { "user_revocable": true, "endpoint": "https://..." },
  "sig": { "alg": "ECDSA-P256-SHA256", "value": "<base64url>" }
}
```

### Hard caps

The schema refuses values beyond these regardless of what a publisher asks for.
A manifest claiming 100% of a device for an hour is well-formed JSON but is not
a consent manifest in any useful sense, and that judgement belongs in the schema
rather than in each verifier.

| field | cap |
| --- | --- |
| `cpu_share_max`, `gpu_share_max` | `0.90` |
| `duration_max_s` | `3600` |
| `network.egress_bytes_max` | `256 MiB` |

`revocation.user_revocable` **must** be `true`. A consent manifest the user
cannot withdraw is the thing this format exists to be the opposite of.

## Signing

Canonicalisation is RFC 8785 (JCS): keys sorted by UTF-16 code unit, no
insignificant whitespace. `JSON.stringify` is not sufficient — key order
follows insertion order, so semantically identical manifests would produce
different signatures. A third party who received the manifest over an untrusted
path must be able to recompute the signing input from the parsed object alone.

The `sig` member is excluded from its own input. Signing is ECDSA P-256 /
SHA-256, chosen over Ed25519 only because it is unflagged everywhere WebCrypto
exists; a manifest nobody can verify defeats the purpose.

`issuer.key_id` is the RFC 7638 JWK thumbprint of the issuer's public key, and
verifiers must confirm the key they hold actually produces that thumbprint —
otherwise a manifest can name a reputable issuer while being signed by anyone.

## Verification

`verifyManifest()` runs these independently and reports each one, so a UI can
say precisely what failed rather than showing an opaque pass/fail:

| check | fails when |
| --- | --- |
| `structure` | schema violation or hard cap exceeded |
| `signature` | signature does not verify, or no issuer key supplied |
| `key_binding` | `issuer.key_id` is not the supplied key's thumbprint |
| `validity_window` | expired, or issued in the future (60 s skew allowed) |
| `nonce_freshness` | nonce already seen (replay), when a nonce set is supplied |
| `code.worker`, `code.kernels[i]` | loaded source does not hash to the declared digest |
| `code_binding` | no loaded code was supplied to check against |
| `policy` | the manifest exceeds the *verifier's own* limits |

Structural validity and policy are separate on purpose: structure is objective,
policy is the user's. A manifest can be perfectly well-formed and still ask for
more than a given person is willing to give.

## What this does not do

Stated plainly, because the gaps matter more than the guarantees:

- **It does not prove the computation was performed correctly.** That is the
  forward proof, and it lives in the verification layer, not here.
- **It does not prove the platform obeyed the manifest.** The governor enforces
  the ceiling, but a user running a hostile browser build has no recourse from
  this document alone. Backing `data_access` with a proof is future work.
- **It does not establish that the declared workload is honest work.** The
  manifest binds *which code* runs, not *what that code is for*. A signed
  manifest for a miner is still a miner — it is just an accountable one, named
  and attributable, which is the difference between covert and consented.
- **It does not solve key distribution.** Verifiers obtain issuer keys out of
  band. Discovery and revocation lists are unspecified in v1.

## Status

Experimental. `zkpoc-ccm/1` is not stable and is expected to change as the
governor and verification layers land. This document is the input to a planned
W3C/WICG explainer.
