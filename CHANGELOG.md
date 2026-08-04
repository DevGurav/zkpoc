# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries are grouped by milestone rather than semver — this project has no
tagged releases yet. See [docs/roadmap.md](docs/roadmap.md) for the fuller
account of what each milestone delivered and why; this file is the terse,
chronological version.

## [Unreleased]

Nothing landed yet.

## [M4] — 2026-08-04 — Demo, SDK, standards, dual-use evaluation

Packages, explainer, and dual-use evaluation done. Demo hosting, npm
publish, and outreach sending deliberately not attempted — see
[docs/roadmap.md](docs/roadmap.md#m4--demo-packaging-standards-outreach).

### Added

- `packages/zkpoc-sdk/`: `issueSession`/`attachGovernor`/`runSession` --
  wraps `@zkpoc/ccm` + `@zkpoc/worker` into the five-line publisher
  integration `demo/index.html` does by hand across ~40 lines. The first
  cross-package dependency in the monorepo; uses relative imports rather
  than bare `@zkpoc/...` specifiers so it works with no `npm install`,
  matching the rest of the project. 5 tests.
- `packages/zkpoc-challenge/`: `solveChallenge`/`runChallenge` -- the
  client half of the anti-bot challenge protocol, interoperating directly
  with `packages/zkpoc-broker/src/challenge.js`'s server half. Reference
  (JS/CPU) solve path; a WGSL-accelerated path is named as future work. 3
  tests.
- `explainer/index.md`: W3C/WICG-format explainer for the Compute Consent
  Manifest, built from `packages/zkpoc-ccm/SPEC.md`. Marked experimental
  and project-local, not filed with any standards body.
- `docs/dual-use-evaluation.md`, [ADR-0015](docs/adr/0015-dual-use-detectors-environment-blocked.md):
  MinerRay/MINOS/Delay-CJ confirmed to have no installable distribution
  (npm/PyPI lookups resolve to unrelated same-named packages) -- reported
  environment-blocked rather than faked, same treatment M3 Track 2 got.
  Demonstrates the manifest/code-binding verification path
  ([ADR-0002](docs/adr/0002-legitimacy-by-declaration-not-detection.md))
  as the real defense in their place.
- `docs/outreach.md`: drafted (not sent) pitch material for Cloudflare,
  Friendly Captcha, ALTCHA, mCaptcha, Anubis, Brave, and Mozilla/WICG,
  grounded in this project's actual measured results.
- `.nojekyll`, root `index.html` redirect to `/demo/`: local prep for a
  future GitHub Pages deploy, not pushed or enabled.

### Deliberately not done

- Demo not hosted (`demo/index.html` still local-only).
- Neither package published to npm (needs the maintainer's own credentials).
- `docs/outreach.md`'s pitches not sent to anyone.

## [M3] — 2026-08-04 — ZK layer: Track 1 (Circom/Groth16) done, Track 2 blocked

Track 1 exit criteria met; Track 2 reported environment-blocked rather than
faked. Plan in [ADR-0007](docs/adr/0007-tiered-zk-proving-plan.md),
implementation decisions in
[ADR-0014](docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md), full
account in [docs/BUILD.md](docs/BUILD.md#m3--zk-layer).

### Added

- `circuits/quant_dot.circom`: Groth16 circuit proving an 8-term quantized
  dot product — scoped to `packages/zkpoc-broker/src/shard.js#referenceElement`'s
  computation and `merkle.js`'s `QUANTIZE_SCALE` convention — as a private
  witness against a public output. 360 constraints (328 non-linear + 32
  linear), 16 private inputs, 1 public output. Includes a signed range check
  (`SignedRangeCheck`, via circomlib's `Num2Bits`) on every input so a
  dishonest prover can't wrap the field modulus and satisfy the dot-product
  constraint with a different integer value than it appears to reveal.
- `contracts/ShardRowVerifier.sol`: generated Solidity Groth16 verifier,
  committed (deterministically regenerable from the circuit via
  `zk/scripts/build.js`, not hand-edited).
- `zk/`: isolated toolchain package (circom2, snarkjs, Hardhat 2 +
  `@nomicfoundation/hardhat-toolbox`) — deliberately outside the root npm
  workspaces, since this is the project's first real heavy-dependency
  subtree; see ADR-0014.
  - `scripts/build.js`: circom2 compile → toy powers-of-tau ceremony →
    Groth16 setup → `verification_key.json` + `contracts/ShardRowVerifier.sol`.
  - `test/verifier.test.js`: deploys the verifier on Hardhat's local EVM,
    proves a real `Shard`-derived witness (not synthetic numbers), verifies
    it on-chain, and independently rejects a tampered public signal and a
    tampered proof point (4/4 passing).

### Fixed (tooling, not project code)

- **circom2's `-o` output path resolves relative to the input file's
  directory**, not cwd, when the input path contains `..` — confirmed by
  direct experiment. Worked around in `build.js` by copying the circuit
  source into the build directory first and compiling with a bare filename.
- **circom2's CLI process does not reliably exit** after printing its own
  success banner, hanging a naive `execSync` caller indefinitely (observed:
  40+ minutes at ~0% CPU) even though compilation itself takes seconds.
  Replaced with `spawn` + resolve-on-success-banner + explicit `child.kill()`.
  The parent process has an analogous issue (snarkjs's WASM curve
  implementation keeps worker threads alive) — fixed with an explicit
  `process.exit(0)` after all output is flushed.
- **Hardhat 2 (`HH1007`) refuses to compile a source file it considers
  outside the project**, which `contracts/` is by default relative to
  `zk/hardhat.config.cjs`'s directory. Fixed by setting `paths.root` to the
  repo root, making `contracts/` a genuine descendant again.

### Blocked, reported honestly

- **Track 2** (RISC Zero/SP1 settlement-side proving measurement): requires
  a Rust toolchain with no WASM/npm-installable distribution; unavailable in
  this environment. `bench/breakeven.py`'s `c_proof` parameter keeps its
  literature-anchored 10³–10⁶ range rather than being replaced with a
  fabricated number — see ADR-0014 for what tooling would close this and
  Q2 in `docs/BUILD.md` §5, left open rather than guessed at.

## [M2] — 2026-08-04 — Broker, tiered verification, useful-PoW challenge protocol

All 6 phases done, all 5 milestone exit criteria met. 161 tests in
`packages/zkpoc-broker`, 195 across the monorepo. Full design contract,
build order, and per-phase delivery notes in
[docs/BUILD.md](docs/BUILD.md#m2--broker-tiered-verification-useful-pow-challenge-protocol).

### Added

- `packages/zkpoc-broker/`: new package.
  - `src/shard.js`: deterministic-but-fresh shard inputs, bound to a session
    nonce so results cannot be replayed or precomputed. Commit-then-challenge
    result verification (see Fixed, below).
  - `src/merkle.js`: row-level Merkle commitment over SHA-256, with
    Fiat-Shamir challenge derivation.
  - `src/tiers.js`: device-tier shard sizing from the measured M0 constants
    (dispatch overhead, sustained throughput); refuses to size work for an
    unmeasured tier rather than guessing (`UnmeasuredTierError`).
  - `src/queue.js`: shard queue, lease-based assignment, replica-independence
    enforcement across expired leases, abandonment after exhausted retries.
  - `src/consensus.js`: per-submission gate plus majority/dispute tally over
    a shard's replica set. The tally logic is a pure function
    (`tallyVerifiedReplicas`) taking already-verified records, kept separate
    from the async cryptographic gate (`verifyReplica`) specifically so
    majority/tie/minority behaviour is testable without needing an
    adversarial search to construct two independently-valid-but-disagreeing
    roots for one shard. A timing-anomaly signal is advisory only and never
    downgrades a cryptographically confirmed result — conflating "fast" with
    "cheating" would prejudge the question M2.5's attacker-advantage-ratio
    measurement exists to answer.
  - `src/audit.js`: `minAuditRate(k)` mirrors
    `bench/breakeven.py#min_audit_rate` exactly (a\* = 1/(1+k)); `auditDraw()`
    reuses `challengeRows()`'s Fiat-Shamir pattern so audit *selection* is
    unpredictable before a worker commits, for the same reason
    ADR-0011 makes challenge *content* unpredictable; `auditFull()` re-verifies
    every row instead of the k=8 sample — an honest stand-in for M3's ZK
    proof, not a weaker approximation of it.
  - `src/ledger.js`: stake and earned balance as separate pools (conflating
    them would let a worker's payout fund its own deterrence bond); `slash()`
    restricted to a closed `ViolationReason` enum.
  - `test/dispute-resolution.test.js`: end-to-end demonstration of the
    scenario this phase exists for — two replicas both pass the cheap gate
    but disagree (a M2.3 dispute), a full audit is forced regardless of
    stake, the audit exposes the liar, the ledger pays the honest party and
    forfeits the dishonest one's stake.
  - `src/challenge.js`: anti-bot proof-of-work issue/resolve, deliberately
    *not* built on `ShardQueue`/`reachConsensus`/`CreditLedger` — an
    anonymous site visitor has no time to wait for a second replica, no
    persistent identity, and no stake to slash, so the barter pipeline's
    assumptions don't hold for this mode. Verification is the ADR-0011
    single-submission gate alone; a response's timing is reported as a
    ratio against the sizing target, never used to auto-deny.
  - `test/adversarial.test.js`: the harness that closes M2's last two exit
    criteria together — 24 distinct simulated clients across 8 shards
    (redundancy 3), exercising garbage results, replayed results, partial
    cheating, Sybil identities, and selective non-participation all at
    once, then rewarding/slashing through the ledger as a real orchestrator
    would. Garbage and replay caught at exactly 100% across 15 independent
    trials each (deterministic gate failures, not a probabilistic bound).
    Partial cheating checked empirically against ADR-0011's f^k prediction
    across 60 deterministic fixtures (varied nonces, not RNG draws — the
    file is explicit that this is not a Monte Carlo confidence interval).
    Sybil identities shown to *raise* their own per-identity audit exposure
    by splitting stake, not lower it — a direct consequence of a\*=1/(1+k)
    being per-identity.
  - 161 tests across `shard.test.js`, `merkle.test.js`, `tiers.test.js`,
    `queue.test.js`, `consensus.test.js`, `audit.test.js`, `ledger.test.js`,
    `dispute-resolution.test.js`, `challenge.test.js`, `adversarial.test.js`.
- `bench/attacker_advantage.py`: the measurement M2's design contract named
  as its primary risk before any M2 code existed. Compares this project's
  own measured GEMM kernel (181.7× GPU/CPU throughput ratio,
  `bench/dispatch_analysis.py`) against a memory-hard control (Argon2id,
  0.67×–4.38×, two independent published sources a decade apart) and the
  real-world Anubis/SHA-256 bypass precedent (Tavis Ormandy). **Finding:**
  the risk materialised — 41×–271× worse than the memory-hard control.
  Reported directly, mitigation named (memory-hard KDF mixed into the row
  commitment) but not yet built — see
  [ADR-0013](docs/adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md).
- [ADR-0012](docs/adr/0012-challenge-mode-single-submission-gate.md),
  [ADR-0013](docs/adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md).
- `docs/BUILD.md`: working spec carried forward between milestones — measured
  constants (§1), invariants that must not regress (§2), definition of done
  (§3), per-milestone design contracts and exit criteria (§4), tracked open
  questions (§5). Referenced from `CONTRIBUTING.md` as the document to read
  before writing code.
- [ADR-0011](docs/adr/0011-commit-then-challenge-row-verification.md).

### Fixed

- **Shard verification accepted zero-work submissions.** M2.1's first design
  derived challenge points directly from public shard data
  (`sampleIndices(shard)`), so a worker could compute the ~8 points that
  would be checked (O(n) each) and skip the O(n³) computation entirely,
  passing verification with a perfect score. Found while designing M2.3 and
  asking what redundancy consensus would actually defend against — it would
  not have caught this, since two lazy workers agree with each other on the
  cheap subset. Replaced with commit-then-challenge row verification: a
  worker hashes every output row into a Merkle root, and the challenge is
  derived from *that root*, so it cannot be known before the root exists,
  and the root cannot exist without every row having been computed. See
  [ADR-0011](docs/adr/0011-commit-then-challenge-row-verification.md) for the
  full account, including the direct regression test that replays the
  original exploit against the new scheme and confirms it now fails.
  `sampleIndices`/`verifySamples`/the old `ShardResult` shape were removed
  outright, not deprecated — every consumer was updated in the same change.
- **`ShardQueue.submit()`'s duplicate-submission check was unreachable dead
  code.** A worker's second submission for the same shard hit the
  "assignment is submitted" branch before ever reaching the
  `rec.results.has(...)` check meant to report `'duplicate submission'`
  specifically — the state check ran first and always matched on a retry.
  Reordered so the more specific, more actionable reason is checked first.
  Caught by a test asserting the exact rejection reason, not just that
  rejection occurred (see `docs/testing-strategy.md`'s stated convention).
- **Two bugs in the adversarial harness itself while building it (not
  production code, but worth the same discipline):** an arithmetic slip in
  a hand-computed expected total (asserted 18 confirmed replicas across the
  ≥20-client plan; the plan actually specifies 16), and a genuine
  misunderstanding of `ShardQueue.assign()`'s contract — it auto-selects
  the next *eligible* shard for a given worker id rather than accepting a
  caller-chosen target, so a loop written as "for each shard id, assign a
  worker to it" silently routed every assignment to whichever shard still
  had room. Fixed by draining all open slots with fresh worker ids each
  round instead of iterating shard ids directly.

## [M1] — 2026-08-03 — Worker, governor, Compute Consent Manifest

### Added

- `packages/zkpoc-ccm/`: manifest schema (`schema.js`), RFC 8785 canonical
  JSON signing (`canonical.js`), full third-party verification
  (`ccm.js#verifyManifest`), `SPEC.md`. 28 tests.
- `packages/zkpoc-worker/`: sandboxed shard `Worker` with a WGSL matmul
  kernel and JS fallback (`kernels.js`, `worker.js`), `Governor` with an
  integral share-control law and four throttle signals (`governor.js`). 6
  tests.
- `demo/index.html`: live meter, six-case tamper panel, revocation.
- `bench/device/probe.html`: sustained-run mode (60/120/300s, bucketed
  throughput, OLS-based plateau detection) added after quick-sweep
  measurement was found to be warmup-contaminated (see Fixed, below, and
  [ADR-0010](docs/adr/0010-sustained-trend-fit-not-quick-sweep.md)).
- `bench/power/`: Windows WMI-based marginal-watts measurement
  (`measure-windows.ps1`, `analyse_power.py`), with a settle phase and
  drift-bracket reporting.
- `bench/dispatch_analysis.py`: separates fixed WebGPU dispatch overhead from
  marginal throughput by fitting across matrix sizes; emits shard-sizing
  recommendations.

### Fixed

- **`dispatch_analysis.py` tier-file clobber.** The writer unconditionally
  overwrote `bench/device/measurements/<tier>.json` on every run, including
  `results.gpu.gflops` — meaning a later, better sustained measurement would
  be silently downgraded back to an earlier, worse quick-sweep estimate the
  next time the script ran. Fixed with a statistic-ranking merge that refuses
  to downgrade. Caught before it caused data loss, but only because of glob
  ordering luck on the run that would have triggered it.
- **`measure-windows.ps1` path resolution.** `$Out`'s default value
  (`"$PSScriptRoot\power-log.csv"`) evaluated against an unpopulated
  `$PSScriptRoot` inside the `param()` block, silently producing
  `\power-log.csv` → `C:\power-log.csv` → access denied. Resolved in the
  script body instead, with a `$MyInvocation`/cwd fallback chain.
- **`measure-windows.ps1` silent data loss on write failure.** The log-header
  write used a non-terminating `Out-File`, so the path bug above wasn't
  caught until the *first sample write*, after which the script kept running
  for the full measurement window (up to several minutes) producing nothing.
  Fixed: the log path is proven writable before any phase starts, with
  `$ErrorActionPreference = 'Stop'` and an explicit early exit.
- **Power measurement instantaneous-rate noise.** `DischargeRate` (mW)
  updates only every few seconds in firmware, so 1Hz sampling produced runs
  of duplicated values and, on a first real measurement, a *negative*
  marginal draw. Switched to `RemainingCapacity` (mWh) delta-over-time —
  see [ADR-0009](docs/adr/0009-energy-counter-not-instant-rate.md).
- **Sustained-throughput plateau misdiagnosis.** The original plateau
  detector flagged a genuinely flat 120-second sustained run as "not
  plateaued" (8.76% bucket-to-bucket spread), because it used a spread
  threshold rather than a trend fit. A spread threshold cannot distinguish
  sampling noise from real decline. Replaced with an OLS slope fit that
  excludes the initial warmup window — see
  [ADR-0010](docs/adr/0010-sustained-trend-fit-not-quick-sweep.md).
- **Encoding crash in `analyse_power.py`.** A `Δ` character in a table header
  crashed on the Windows console's default cp1252 codepage. Replaced with
  ASCII, matching the convention already used elsewhere in `bench/`.

### Corrected (measurement, not code)

- `laptop-igpu`'s F(d): **75.4 → 107.2 GFLOPS.** The first sustained
  measurement (7 quick-sweep repetitions) never ran long enough to get past
  ~16 seconds of pipeline warmup, and its monotonic within-run decay was
  misread as thermal throttling. A genuine 120-second sustained run shows a
  flat trend (+2.4%/min, within sampling noise). The tier's economic
  verdict — uneconomic at any share — survived the correction, but on the
  right numbers rather than numbers that happened to point the same
  direction. Full account in
  [docs/device-tiers.md](docs/device-tiers.md#what-the-first-real-measurement-changed).
- `laptop-igpu`'s `watts_full`: measured at **9.1 W** (was an unmeasured
  placeholder). Break-even wattage `W*` for this tier moved from 3.9 W to
  5.6 W to match the corrected F(d); measured draw exceeds it either way.

## [M0] — 2026-08-03 — Economic model + device benchmark

### Added

- `bench/tdsc_reproduction.py`: reproduces Saad & Mohaisen (IEEE TDSC 2024)
  from first principles.
- `bench/breakeven.py`: solves for σ\*(device, market), the break-even
  resource share for consented compute barter vs. advertising.
- `bench/device/probe.html`: first version, quick-sweep mode only.
- `packages/zkpoc-ccm/`, `packages/zkpoc-worker/`: package scaffolding
  (implementation followed in M1).

### Corrected

- **Saad & Mohaisen's stated cryptojacking yield.** The paper reports
  `$1.06×10⁻⁵ USD/second`; recomputing from the paper's own Eq. (5) and
  stated parameters gives `$1.22×10⁻⁷ USD/second` — the printed figure is the
  paper's own profit value divided by 60 instead of by the 5100-second
  session length, an ~87× overstatement. Every other intermediate value in
  the paper's worked example reproduces exactly. See
  [ADR-0008](docs/adr/0008-tdsc-baseline-correction.md).

### Findings

- The original ≤5% ambient resource ceiling cannot clear any modelled ad
  market on any modelled device class, even under maximally favourable
  assumptions — but only by 1.3×, not an order of magnitude
  ([ADR-0001](docs/adr/0001-break-even-frontier-and-anti-bot-flagship.md)).
  This finding changed the project's headline framing from an ad-replacement
  claim to a measured break-even frontier, with anti-bot proof-of-work
  adopted as the flagship deployable target.
