# ADR-0013: The measured attacker-advantage ratio exceeds the memory-hard control — reported, mitigation deferred

Status: Accepted (2026-08-04)

## Context

Before any M2 code was written, `docs/BUILD.md`'s M2 design contract named
the flagship's central technical risk explicitly: "ML shard work is highly
GPU-accelerable, so an attacker with a GPU farm may enjoy a *larger*
advantage over an honest mobile user than a memory-hard hash puzzle would
give them," with an instruction attached — if the measurement bears that out,
"that is a finding to report, not a number to bury."

`bench/attacker_advantage.py` takes that measurement. For a FLOPS-bound
kernel sized to a fixed wall-clock budget, the attacker's solve-time speedup
collapses exactly to the hardware throughput ratio (GPU GFLOPS ÷ CPU
GFLOPS) — no cleverness required, which is what "highly GPU-accelerable"
means in practice.

Three grounded inputs, not estimates invented for this ADR:

1. **This project's own measured kernel.** 107.2 GFLOPS (GPU, sustained) vs.
   0.59 GFLOPS (CPU), same device (Intel Gen-12LP / Iris Xe), same GEMM
   kernel — `bench/dispatch_analysis.py`, carried in
   `docs/BUILD.md` §1. Ratio: **181.7×**.
2. **Memory-hard control (Argon2id), from two independent published
   sources a decade apart:** Specops Software/Outpost24 (Jul 2026) measured
   an 8× RTX 5090 GPU rig at 490 H/s against a single ~$2,100 AMD EPYC CPU
   at 730 H/s — the GPU rig was *slower* (0.67×). A PHC-era benchmark
   (~2015–16, discussed by Argon2 co-designer Dmitry Khovratovich) put a
   Titan X at ~4.38× a comparison baseline. Range: **0.67×–4.38×**. That the
   two sources disagree even on *direction* across a decade of hardware is
   itself the relevant fact: memory-hardness keeps this ratio in the single
   digits regardless of GPU generation, which is its entire design goal.
3. **Real-world precedent.** Tavis Ormandy's finding that a free-tier GCE VM
   running a native-code (non-GPU) solver could generate valid tokens for
   all 11,508 Anubis-protected sites in ~6 minutes, for under a cent a
   month — the deployed, already-broken SHA-256 baseline this project's
   flagship (ADR-0001) is positioned to replace.

The result: our measured ratio is **41×–271× larger** than the memory-hard
control across the full cited literature range. The primary risk named
before this measurement was taken has materialised.

## Decision

Report the finding plainly, as `bench/attacker_advantage.py`'s own output
does, rather than softening or omitting it: **on the specific axis this
metric measures, a GEMM-based useful-PoW challenge is a step backward from
the memory-hard designs it is meant to improve on.** This is recorded now,
at the point of measurement, rather than left to surface later.

Two things this finding does **not** mean, both worth stating with equal
weight so the result isn't misread in either direction:

- It does not mean the challenge is worse than the Anubis/SHA-256 baseline
  in absolute terms. Ormandy's bypass exploited a *compute-implementation*
  gap (native code vs. browser JS) with no equivalent here — there is no
  cheaper-than-honest way to satisfy ADR-0011's commit-then-challenge gate,
  because producing a valid root requires the real computation, full stop.
  The weakness measured here is specifically the *GPU-vs-CPU throughput*
  axis, not the freshness or forgery-resistance properties ADR-0011 and
  ADR-0012 already established.
- It does not mean the project's economics (ADR-0001, `bench/breakeven.py`)
  are wrong — cost was never the binding constraint (Part 5 of the
  measurement script: renting the full 182× advantage costs a fraction of a
  cent per hour, consistent with Ormandy's own figure). The binding
  constraint is throughput asymmetry, which is a different problem with a
  different fix.

## Consequences

- **A mitigation is named, not built.** BUILD.md's own primary-risk note
  already points at it: mix a memory-hard component into the shard
  *commitment* (`merkle.js#hashRow`, ADR-0011) rather than relying on the
  GEMM kernel alone for deterrence — raising the memory-hardness of the
  commitment step without changing the underlying matmul or the useful-work
  claim it sells. Sizing and benchmarking that change is out of scope for
  this measurement and is added to `docs/BUILD.md` §5 as an open question
  rather than attempted under this ADR.
- **M2.5's exit criterion 3 is satisfied by the measurement itself**, not by
  the ratio coming out favourably — BUILD.md never conditioned "done" on a
  good number, only on the number being real and reported. Scope discipline
  matters here: attempting a memory-hard redesign mid-measurement would
  conflate "measure the risk" with "fix the risk," and the fix deserves its
  own design pass against a stated cost budget (memory-hard commitment
  hashing is not free, and how much overhead it adds to `commitFullResult()`
  is itself unmeasured).
- This is the fourth ADR in this project's log built on a measurement that
  contradicts what would have been convenient to find (after
  [ADR-0008](0008-tdsc-baseline-correction.md),
  [ADR-0010](0010-sustained-trend-fit-not-quick-sweep.md), and
  [ADR-0011](0011-commit-then-challenge-row-verification.md)) — the
  difference here is that nothing was *wrong*; the finding is simply
  unfavourable, and is kept exactly that way rather than reframed.
- Alternative considered and rejected: delay writing this ADR until the
  memory-hard mitigation is designed, so the record shows a problem and its
  resolution together. Rejected because it would mean the risk BUILD.md
  named up front went unrecorded at the moment it was actually confirmed,
  which defeats the purpose of naming it up front at all.
