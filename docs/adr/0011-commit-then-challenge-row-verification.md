# ADR-0011: Commit-then-challenge row verification, replacing point-sample challenges

Status: Accepted (2026-08-03)

## Context

M2.1's shard verification derived a small set of "challenge" output points
directly from public shard data (`sampleIndices(shard)`, seeded only by
`shard.seed`), on the stated theory that "a worker cannot know which elements
will be demanded until it holds the shard." That claim was false: the moment
a worker is assigned a shard, it has everything needed to compute the
challenge locally, before doing any real work. Since a single output element
of an n x n GEMM costs O(n) to compute directly (versus O(n^3) for the full
product), a worker could compute exactly the ~8 points that would be checked
and skip the real computation entirely — passing `verifySamples()` with a
mathematically perfect score while doing none of the work being paid for.

This was not caught during M2.1's own review (22 passing tests, including
explicit freshness and replay tests) because those tests checked properties
the scheme *did* have — determinism, nonce-sensitivity, garbage rejection —
not the property it was missing: that producing a valid challenge response
required doing the full computation. The gap surfaced only while designing
M2.3 (redundancy consensus) and asking what consensus would actually be
defending against. It would not: two lazy workers taking this shortcut
compute the same correct answers on the cheap subset and agree with each
other, so redundancy provides no defense against this specific attack either.

This is a foundational problem, not a peripheral one — if a worker never
needs to perform the declared computation to pass verification, the "useful
work" premise the whole project is built on does not hold, independent of
anything M2.3–M2.6 add on top.

## Decision

Replace point-sampling with commit-then-challenge, implemented in
`packages/zkpoc-broker/src/merkle.js` and rebuilt into `shard.js`:

1. A worker computes every output row, hashes each one (SHA-256 over
   quantized values — quantization matches the existing tolerance-for-fp32
   convention, so independent honest implementations still converge on the
   same commitment), and builds a Merkle root over all n row hashes
   (`commitFullResult()`).
2. The challenge — which rows must be revealed — is derived via Fiat-Shamir
   from **both** the shard and the worker's own submitted root
   (`challengeRows(shard, root, k)`), so it cannot be known before the root
   exists, and the root cannot exist without every row having been hashed,
   which requires every row having been computed.
3. The broker independently re-derives the required row set from the
   submitted root — it does not trust the worker's choice of what to reveal
   — verifies each revealed row's Merkle inclusion proof against the root,
   and ground-truth-checks a handful of elements within each revealed row
   against `referenceElement()`.

This is a probabilistic guarantee, stated precisely rather than claimed
absolutely: a worker honest on fraction f of rows evades detection on a
single submission with probability f^k. `DEFAULT_CHALLENGE_ROWS = 8` keeps
that below 1% even at f = 0.5 (a worker skipping half the work); the
project's existing consensus layer (root agreement across independent
submissions, not just accepting one) further compounds this rather than
becoming redundant with it — see Consequences.

## Consequences

- **M2.3 (consensus) is now doing something a broken foundation could not
  have supported.** With this fix, comparing submitted *roots* across
  independent workers is a much stronger signal than comparing raw sample
  digests was: two independent forgers agreeing on a full Merkle root over
  content neither of them fully computed is not just unlikely, it requires
  either genuine computation or collusion — which reframes consensus's job
  from "catch obviously wrong answers" to "catch the residual probabilistic
  gap the per-submission challenge leaves open," a meaningfully different and
  stronger design.
- **Verification cost changed shape.** The old scheme checked O(k) points at
  O(n) each; the new scheme requires hashing all n rows to produce a
  commitment (O(n) hashes over O(n) values each = O(n^2), negligible next to
  the O(n^3) GEMM it stands in for) plus O(k) Merkle-proof checks. Confirmed
  practical at realistic shard size: a 1024-row tree builds and every leaf
  verifies in the test suite (`merkle.test.js`) in well under 200ms
  headlessly.
- **`shard.js`'s public API changed incompatibly.** `sampleIndices` and
  `verifySamples` are removed, not deprecated; `ShardResult`'s shape changed
  from `{samples: [{i,j,v}]}` to `{root, rows: [{index, values, proof}]}`.
  Every consumer (`queue.test.js`) was updated in the same change; there is
  no compatibility shim, consistent with this project's stated preference for
  changing code directly over maintaining parallel paths
  (`CONTRIBUTING.md`).
- This is the third ADR in this project's log that records a wrong first
  answer caught by evidence (after
  [ADR-0008](0008-tdsc-baseline-correction.md) and
  [ADR-0010](0010-sustained-trend-fit-not-quick-sweep.md)), and the first
  where the wrong answer was this project's own prior design rather than an
  external source. Recorded with the same weight, per this log's stated
  purpose.
- Alternative considered and rejected: a single full-matrix digest (one hash
  over all n² elements) instead of a row-level Merkle tree. Rejected because
  a flat hash supports verifying "this exact full disclosure matches" but not
  "this small revealed piece is part of a larger committed structure" —
  without a tree, the broker would need the *entire* matrix to check
  anything, which defeats the purpose of a cheap per-shard check and would
  push all verification onto the M2.4 audit layer, leaving every unaudited
  (bulk) shard exactly as exploitable as before this fix.
