# ADR-0016: Memory-hard row commitment built, measured, and found structurally too costly at per-row granularity

Status: Accepted (2026-08-04)

## Context

[ADR-0013](0013-measured-attacker-advantage-exceeds-memory-hard-control.md)
measured challenge mode's central weakness — GPU-equipped attackers get
41×–271× more advantage over honest mobile devices than a memory-hard
puzzle would give them — and named a mitigation without building it: mix a
memory-hard cost into the row commitment (`merkle.js#hashRow`), tracked as
Q7 in `docs/BUILD.md` §5. This ADR is that follow-through: designed, built,
tested, and measured, with an honest report of what the measurement found.

## Decision

**Built:** `merkle.js#hashRow` gained an opt-in `memoryHard` option (default
`false`, so all 203 pre-existing tests are unaffected). It expands a
per-row seed into a configurable-size buffer via a fast, non-cryptographic
mixer (`mix32`, the same spreading function `shard.js` already uses for the
same non-cryptographic reason), then performs a data-dependent random-walk
mixing pass over it, and folds the result into the row's SHA-256 digest.
This is a deliberately narrow, purpose-built function — not a
reimplementation of Argon2id, whose actual security target (offline
password-cracking resistance) this use case doesn't need. `commitFullResult`,
`buildHonestSubmission`, and `verifyRowSubmission` (`shard.js`) all forward
the option through; `@zkpoc/challenge`'s `solveChallenge`/`runChallenge` do
too, end to end.

**Measured, honestly, with `bench/memory_hard_overhead.js`:** using real
shard sizes from `tiers.js#chooseShardSize` against `LAPTOP_IGPU` (the one
measured device tier) at the 1–3s target durations challenge mode actually
uses, and a buffer-size sweep at a fixed shard size:

| Buffer | Added cost, at n≈4736 (2s-target shard) |
| --- | --- |
| 1 KiB (far too small to matter against a GPU) | +2.65s (133% of the 2s target) |
| 8 KiB (still below any GPU's shared memory) | +2.99s (150%) |
| 64 KiB (comparable to older/typical GPU shared memory) | +5.13s (256%) |

**The finding: there is no buffer size in this sweep that is both
plausibly GPU-resistant and practically fast.** Cost scales linearly with
shard size because every row pays an independent memory-hard expansion —
even a trivially small, GPU-resistance-irrelevant 1 KiB buffer already
costs more than the shard's own GEMM target time, purely from being
multiplied across thousands of rows. This is a structural property of
mixing memory-hardness in at *per-row* granularity, not an undiscovered
good setting the sweep missed.

**What remains genuinely unverified:** whether any of these buffer sizes
actually resists GPU parallelization the way the design argument (GPU
shared memory per SM: roughly 48–228 KiB across current architectures)
claims. This environment has no GPU to check against — the same constraint
ADR-0013's own memory-hard control (Argon2id) worked around by citing two
independent *published* hardware benchmarks. This function is purpose-built
with no equivalent literature, so that verification stays an open question
rather than an assumption.

## Consequences

- **Q7 in `docs/BUILD.md` §5 is updated, not closed.** Its two original
  questions are now answered unevenly: "what does this cost
  `commitFullResult()`" has a real, measured answer (linearly scaling, and
  large relative to target durations at any buffer size tested); "does it
  close or narrow the Q1 gap" is now *structurally unlikely to be worth
  deploying as specified*, pending the unverified GPU-resistance question,
  rather than simply unmeasured as before.
- **This mitigation is not deployed as challenge mode's default.**
  `memoryHard` stays opt-in and off by default in every function that
  accepts it. Shipping a default that roughly triples honest-user wait
  time to address a GPU-advantage problem would trade one bad outcome for
  a different bad outcome, not fix the original one.
- **A more promising direction is named, not built:** applying
  memory-hardness once per submission (e.g. folded into the Merkle root or
  a small fixed-size aggregate) rather than once per row would make the
  added cost constant instead of linear in shard size — cheap regardless of
  n, at the real cost of a weaker deterrence argument (a fixed per-submission
  tax matters proportionally less as shard size, and therefore attacker
  advantage, grows). Whether that tradeoff is actually favorable is real,
  unstarted design work, tracked as a new open question rather than
  attempted under this ADR.
- Per this project's own claims discipline, the code is committed as a
  correct, tested, honestly-documented *capability* — usable, and useful
  for exactly the future work item above — without a claim that it solves
  ADR-0013's problem as currently built.
- Alternative considered and rejected: quietly not building this at all,
  on the theory that a negative result isn't worth the engineering time.
  Rejected — matching this project's own established pattern (ADR-0008,
  ADR-0010, ADR-0011, ADR-0013), an unfavorable, honestly-measured result is
  exactly the kind of finding this ADR log exists to keep, and ruling out
  the "just mix in a KDF" approach at per-row granularity is real,
  citable progress on Q7, not a wasted attempt.
