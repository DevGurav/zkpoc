# ADR-0007: In-browser proving is Circom/Groth16; zkVM moves to settlement-side

Status: Accepted (2026-08-02) — Track 1 implemented 2026-08-04, see
[ADR-0014](0014-m3-track1-toolchain-and-track2-blocked.md) for toolchain
choices and Track 2's status

## Context

The primary reference (VerifBFL) demonstrates recursive zk-SNARK proofs
(Nova/IVC) for training and aggregation integrity, but its benchmarks
(785s setup, 82s prove, 0.6s verify) are measured **natively** on a Dell
XPS-15 — not in a browser, not on mobile, not under any resource governor.
Whether the same proving approach is even *feasible* client-side, and at what
cost, is an open question the original synopsis did not resolve.

Two independent constraints answer it before any proving code is written:

- **WASM's 32-bit address space caps linear memory at 4 GB.** General-purpose
  zkVMs (RISC Zero, SP1) routinely exceed this for anything beyond trivial
  programs — they cannot run inside a browser tab at all, independent of how
  slow they might be.
- **FibRace** (arXiv:2510.14693) already measured client-side zk-SNARK proving
  at scale — 2.2M Cairo-M proofs across 1,420 device models — and found
  devices need **≥3 GB RAM**, with 3–4 GB devices crashing 4.2–4.4× per proof
  from OOM on the largest witnesses. Memory, not proving time, is the binding
  constraint on-device.

## Decision

Split the ZK layer into two tracks with different feasibility profiles and
different roles:

- **Track 1 (must land, in-browser): Circom + snarkjs, Groth16.** A single
  fixed, small kernel (a quantized matmul) is compiled to a circuit, proved
  client-side, and verified on-chain via a generated Solidity verifier.
  Bounded circuit size, mature toolchain, and Groth16's small constant-size
  proof keep this inside the memory ceiling FibRace already validated as
  workable. Noir and Cairo-M/Stwo (with WebGPU-accelerated proving, now
  shipping — zkSecurity's Stwo work reports ~2× end-to-end speedup) are
  tracked as evaluated alternatives, not replacements, pending measurement.
- **Track 2 (settlement-side only, measurement track): RISC Zero or SP1**,
  run on the broker at settlement, proving the same shard for comparison.
  This is explicitly *not* a client-side claim — it exists to produce the
  overhead table that parameterises `proof_cost` in `bench/breakeven.py`'s
  `VerificationPolicy` (ADR-0006), and a negative result ("too slow for
  real-time settlement") is still a reportable finding, not a blocker.

Track 2 must not block Track 1's delivery; they are independent workstreams
with a shared output (the `c_proof` parameter) rather than a dependency chain.

## Consequences

- The synopsis's own architecture (L3(c), "one folded proof at settlement")
  already anticipated something like Track 2's placement, so this decision is
  a refinement of scope rather than a reversal.
- A third, optional track — reproducing VerifBFL's Nova/IVC benchmarks
  natively via `nova-snark`, then measuring degradation in a throttled
  browser tab — is recorded as a stretch goal: it gives a direct
  apples-to-apples comparison against the primary reference on identical
  circuits, which neither Track 1 nor Track 2 alone provides.
- This ADR is written ahead of implementation, which is unusual for this
  project's ADR log (every other record here follows working code). It is
  included now because the reasoning — WASM's memory ceiling, FibRace's
  measured RAM floor — is already settled by evidence that exists today, and
  recording it before M3 starts avoids re-deriving it under time pressure or,
  worse, defaulting to the wrong pattern (attempting a client-side zkVM)
  before the memory constraint is rediscovered the hard way.
- Alternative considered and rejected: attempt a client-side zkVM (RISC Zero
  or SP1) directly on a compiled WASM shard as the primary in-browser path.
  Rejected outright by the 4 GB ceiling — this is not a performance trade-off
  to weigh, it is a hard capability gap.
