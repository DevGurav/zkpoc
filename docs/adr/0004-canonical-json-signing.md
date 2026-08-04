# ADR-0004: RFC 8785 canonical JSON for manifest signing

Status: Accepted (2026-08-02)

## Context

The Compute Consent Manifest (ADR-0002) is designed to be verified by a third
party — a browser extension, an auditor, a security researcher — who received
the manifest over an untrusted path and did not observe how it was
constructed. That party must be able to recompute the exact bytes that were
signed, from the parsed JSON object alone.

`JSON.stringify` cannot provide this. Key order follows insertion order in
JavaScript, so two semantically identical manifest objects — same fields, same
values, different construction order (e.g. after a round-trip through a
different JSON library, or after being rebuilt by an intermediary) — can
serialise to different byte strings and therefore produce different
signatures over what is, semantically, the same document. A verifier who
reconstructs the object independently (e.g. from a database row) has no
guaranteed way to reproduce the signer's exact byte sequence.

## Decision

Signing input is canonicalised per RFC 8785 (JSON Canonicalization Scheme,
JCS) before signing: object keys sorted by UTF-16 code unit, no insignificant
whitespace, numbers serialised via the ECMAScript `Number::toString`
algorithm. Implemented from scratch in `packages/zkpoc-ccm/src/canonical.js`
rather than pulled from a dependency, since the algorithm is small (~90 lines)
and the project otherwise has zero runtime dependencies (`CONTRIBUTING.md`).

Values RFC 8785 cannot represent are rejected outright rather than silently
coerced: `NaN`, `Infinity`, `undefined`, functions, `bigint`, and circular
references all throw, and `-0` is normalised to `0`. A signer that constructs
a manifest containing one of these has a bug, and canonicalising it into
something "valid" would hide that bug from both signer and verifier.

## Consequences

- `canonical.test.js` verifies key-reordering invariance directly: two objects
  built with keys in opposite order produce identical canonical output.
- The `sig` member is excluded from its own signing input (`ccm.js`'s
  `signManifest`/`verifySignature`) — signing over a field that contains the
  signature is circular by construction.
- Every mutation test in `demo-flow.test.js` and the demo's tamper panel
  relies on this: a single-byte change to any signed field must invalidate
  the signature, and canonical serialisation is what guarantees the signed
  bytes actually reflect the full object rather than some subset an attacker
  could route around.
- Cost: canonicalisation is O(n log n) in object size for the key sort, done
  on every sign and every verify. Not measured as a bottleneck at manifest
  sizes in this project (a few hundred bytes), but noted as a place to look
  first if manifest verification ever needs to happen at high frequency (e.g.
  per-request in challenge mode, ADR-0001).
- Alternative considered and rejected: sign the raw `JSON.stringify` output
  and require verifiers to keep the original signed string alongside the
  parsed object. Rejected because it defeats the purpose of a
  third-party-verifiable format — it would require trusting whoever forwards
  the manifest to preserve exact bytes, rather than letting the recipient
  reconstruct them.
