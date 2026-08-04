# Roadmap

Single source of truth for milestone status — the table in `README.md` is a
summary of this, not the other way around. If they disagree, this file is
right and the README needs updating.

## Status at a glance

| Milestone | Status | Exit criteria met? |
| --- | --- | --- |
| M0 — Economic model + device benchmark | **Done** | Yes — see below |
| M1 — Worker, governor, Compute Consent Manifest | **Done** | Yes — see below |
| M2 — Broker, tiered verification, useful-PoW challenge protocol | **Done** | Yes — all 5, see below |
| M3 — ZK layer (in-browser Groth16 + settlement-side zkVM) | **Track 1 done, Track 2 environment-blocked** ([ADR-0007](adr/0007-tiered-zk-proving-plan.md), [ADR-0014](adr/0014-m3-track1-toolchain-and-track2-blocked.md)) | Track 1 yes; Track 2 not attemptable here |
| M4 — Demo, SDK, W3C/WICG explainer, dual-use evaluation | **Packages/explainer/evaluation done; deploy, npm publish, outreach deliberately not sent** ([ADR-0015](adr/0015-dual-use-detectors-environment-blocked.md)) | See below |

---

## M0 — Economic model + device benchmark

**Exit criteria (from the original plan):** break-even surface plotted; a
defensible statement of the form "barter beats a $X CPM only above share σ on
device tier d."

**Delivered:**

- `bench/tdsc_reproduction.py` — reproduces the reference paper's economic
  model exactly, isolates and corrects an ~87× arithmetic error in its stated
  per-second yield ([ADR-0008](adr/0008-tdsc-baseline-correction.md)), and
  reconciles its Table 9 row by row.
- `bench/breakeven.py` — solves for σ\*(device, market), the break-even
  resource share; reports a critical-wattage threshold `W*` per device tier so
  conclusions don't depend on unmeasured wattage; separates the "designed"
  (economically optimal) verification policy from a naive one to show the
  negative result survives even under favourable assumptions.
- `bench/device/probe.html` — in-browser F(d) measurement, no build step;
  gained a sustained-run mode with OLS-based plateau detection after Pass 1
  measurement was found to be warmup-contaminated
  ([ADR-0010](adr/0010-sustained-trend-fit-not-quick-sweep.md)).
- `bench/dispatch_analysis.py` — separates fixed WebGPU dispatch overhead
  (~4ms) from marginal throughput by fitting across matrix sizes; produces
  the shard-sizing floor (N ≥ 1187 on the one measured device) that M2's
  challenge protocol needs.
- `bench/power/` — marginal-watts measurement via Windows WMI energy-counter
  differencing, with a settle phase and drift-bracket reporting
  ([ADR-0009](adr/0009-energy-counter-not-instant-rate.md)).

**Headline result:** even under the most favourable assumptions modelled
(best device class, cheapest ad inventory, theoretical cloud-spot parity, zero
redundancy, zero verification overhead), σ\* ≈ 6.7% against the original
design's 5% ceiling — the ceiling misses by 1.3×, not an order of magnitude.
This is why the project's framing changed
([ADR-0001](adr/0001-break-even-frontier-and-anti-bot-flagship.md)) rather
than simply reporting a negative result.

**One tier is now fully measured** (`laptop-igpu`, Intel Gen-12LP): F(d) =
107.2 GFLOPS, watts = 9.1 W, both real. The other three remain
literature-anchored placeholders — flagged on every `bench/breakeven.py` run.
(Originally six tiers including two mobile classes; scope narrowed to
laptop/desktop only — [ADR-0017](adr/0017-scope-narrowed-to-laptop-desktop.md).)

## M1 — Worker, governor, Compute Consent Manifest

**Exit criteria:** shard executing at a measured and enforced ceiling with no
perceptible frame drop; governor demonstrably pre-empting under load; manifest
independently checkable by a third party.

**Delivered:**

- `packages/zkpoc-ccm/` — manifest schema, RFC 8785 canonical signing
  ([ADR-0004](adr/0004-canonical-json-signing.md)), full third-party
  verification (`verifyManifest()`), 28 tests including the
  code-binding-vs-signature isolation case
  ([testing-strategy.md](testing-strategy.md)).
- `packages/zkpoc-worker/` — sandboxed shard `Worker` (WGSL matmul + JS
  fallback kernel), `Governor` with an integral share-control law
  ([ADR-0005](adr/0005-integral-share-control.md)) and four composable
  throttle signals (interaction, frame health, thermal proxy, battery), 6
  tests.
- `demo/index.html` — live meter, six tamper-panel cases (five signature
  breaks, one code-binding isolation case), instant revocation.
- Manually verified in a real browser: WebGPU path, CPU fallback, frame-drop
  behaviour (1/2070 long frames in the recorded session), interaction
  preemption, instant revocation mid-dispatch. Not yet automated — see
  [testing-strategy.md](testing-strategy.md#verified-manually-not-automated).

**Bugs found and fixed during this milestone** (kept visible rather than
silently squashed, per [CHANGELOG.md](../CHANGELOG.md)): a PowerShell
`$PSScriptRoot`-in-param-default bug that silently wrote to `C:\`; a
non-terminating `Out-File` error that would have burned a full 3-minute
measurement window before failing; a tier-file clobber bug where
`dispatch_analysis.py` unconditionally overwrote a better sustained
measurement with a worse quick-sweep one on every re-run.

## M2 — Broker, tiered verification, useful-PoW challenge protocol

**Done — all 5 exit criteria met.** Full build-order table, design contract,
and per-phase delivery notes in
[BUILD.md §4](BUILD.md#m2--broker-tiered-verification-useful-pow-challenge-protocol);
this section is a milestone-level summary of it.

**Delivered** (`packages/zkpoc-broker/`, 161 tests):

- **Shard model + tier-aware sizing** (`src/shard.js`, `src/tiers.js`) —
  deterministic-but-fresh inputs bound to a session nonce; device-tier
  sizing from the measured M0 constants that refuses to guess for an
  unmeasured tier (`UnmeasuredTierError`) rather than silently substituting
  a placeholder.
- **Commit-then-challenge result verification** (`src/merkle.js`,
  `src/shard.js`) — replaced an initial point-sample scheme found to accept
  zero-work submissions; a worker now Merkle-commits every row, and the
  challenge is derived from *that root*, so producing a valid one costs the
  real computation. [ADR-0011](adr/0011-commit-then-challenge-row-verification.md).
- **Shard queue** (`src/queue.js`) — lease-based assignment, replica
  independence enforced even across expired leases, abandonment after
  exhausted retries.
- **Redundancy consensus** (`src/consensus.js`) — a per-submission gate plus
  majority/dispute tally. A tie is a dispute, not an arbitrary pick.
- **Audit sampler + credit ledger** (`src/audit.js`, `src/ledger.js`) — the
  stake-derived audit rate (a\* = 1/(1+k), [ADR-0006](adr/0006-audit-rate-from-inspection-game.md))
  is real code, backed by a ledger that posts stake, pays confirmed work, and
  slashes violations. A disputed shard forces a full-disclosure audit
  (every row, not the k-row sample) regardless of stake —
  `test/dispute-resolution.test.js` demonstrates dispute → forced audit →
  the dishonest replica loses its stake, the honest one gets paid.
- **Challenge protocol wrapper** (`src/challenge.js`) — issue/resolve for
  anti-bot proof-of-work, deliberately *not* built on the barter pipeline
  above: an anonymous visitor has no time to wait for a second replica, no
  identity, and no stake. [ADR-0012](adr/0012-challenge-mode-single-submission-gate.md).
- **Attacker-advantage-ratio measurement** (`bench/attacker_advantage.py`)
  — the finding M2's design contract named as its primary risk before any
  code existed is confirmed: this project's own measured GEMM kernel gives
  an attacker a 181.7× GPU/CPU throughput advantage, 41×–271× worse than a
  literature-cited memory-hard control (two independent published sources,
  a decade apart). Reported directly, not softened —
  [ADR-0013](adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md).
  A mitigation (mix a memory-hard KDF into the row commitment) was
  subsequently built, tested, and measured
  (`bench/memory_hard_overhead.js`) — found structurally too costly to
  deploy at per-row granularity (cost scales linearly with shard size; no
  buffer size tested is both plausibly GPU-resistant and practically fast),
  not deployed as a default, and a cheaper alternative direction named but
  not built. [ADR-0016](adr/0016-memory-hard-commitment-mitigation.md), Q7/Q8
  in BUILD.md §5.
- **Adversarial harness** (`test/adversarial.test.js`) — closes the
  remaining two exit criteria together: 24 distinct simulated clients across
  8 shards, garbage and replay caught at exactly 100% (deterministic gate
  failures), partial cheating checked empirically against the theoretical
  f^k bound, Sybil identities shown to *raise* their own audit exposure by
  splitting stake rather than lower it, and shards under selective
  non-participation resolve to completed-or-abandoned with nothing left
  hanging.

**Known, non-blocking gaps, carried forward rather than hidden:**

- Challenge execution is tested headlessly via the JS reference path only —
  no real browser/WebGPU walkthrough yet (`docs/testing-strategy.md`'s
  manual-vs-automated distinction).
- The attacker-advantage finding (ADR-0013)'s named mitigation was built
  and measured, and found not practically deployable as specified
  (ADR-0016) — the gap itself remains open.
- Publisher SDK + content gate (the secondary barter demo surface) is M4
  scope, not M2's.
- Three of four device tiers remain unmeasured placeholders — laptop and
  desktop only, mobile out of scope
  ([ADR-0017](adr/0017-scope-narrowed-to-laptop-desktop.md)) — see
  [docs/device-tiers.md](device-tiers.md).

## M3 — ZK layer

The plan was recorded ahead of implementation in
[ADR-0007](adr/0007-tiered-zk-proving-plan.md), because the two constraints
that shape it (WASM's 4GB memory ceiling; FibRace's measured ≥3GB RAM floor
for client-side proving) were already settled by evidence and didn't need
rediscovering under time pressure. Implementation-level choices (toolchain,
dependency isolation, Track 2's outcome) are in
[ADR-0014](adr/0014-m3-track1-toolchain-and-track2-blocked.md).

- **Track 1 (must land, in-browser) — done.** `circuits/quant_dot.circom`,
  a quantized 8-term dot product scoped to the same computation
  `packages/zkpoc-broker/src/shard.js#referenceElement` performs, compiled
  with circom2 (a WASM port of circom — no native/Rust compiler available
  in this environment), proved with snarkjs (Groth16), and verified on-chain
  against a generated `contracts/ShardRowVerifier.sol` on Hardhat's local
  EVM. `zk/test/verifier.test.js`: a genuine proof over real Shard-derived
  inputs verifies true; a tampered public signal and a tampered proof point
  are each independently rejected (4/4 passing).
- **Track 2 (settlement-side, measurement only) — environment-blocked.**
  RISC Zero and SP1 require a Rust toolchain with no WASM/npm-installable
  distribution; none is available here. Rather than substitute a guessed
  number, the `c_proof` overhead figure `bench/breakeven.py`'s
  `VerificationPolicy` has a parameter slot for stays at its
  literature-anchored range (ADR-0014).
- Optional stretch (not attempted, same blocker): reproduce VerifBFL's
  native Nova/IVC benchmarks via `nova-snark`, then measure degradation in a
  throttled browser tab.

## M4 — Demo, packaging, standards, outreach

**Exit criteria (from the original plan):** demo URL completes a full cycle
on a clean profile; `npm i` + the five-line snippet works in a fresh
project; detector baselines run with the outcome reported honestly either
way, alongside the manifest-verification path.

**Delivered:**

- `packages/zkpoc-sdk/` — five-line publisher integration wrapping
  `@zkpoc/ccm` + `@zkpoc/worker` (`issueSession`/`attachGovernor`/`runSession`),
  5 tests. `npm i` isn't meaningful yet since nothing is published (see
  Deliberately not done, below), but the snippet itself works today against
  the packages as committed.
- `packages/zkpoc-challenge/` — the client half of the anti-bot challenge
  protocol, interoperating directly with `packages/zkpoc-broker/src/challenge.js`'s
  server half, 3 tests.
- `explainer/index.md` — W3C/WICG-format explainer built from
  `packages/zkpoc-ccm/SPEC.md`.
- **Dual-use evaluation, closed via the declaration path.** MinerRay/MINOS/
  Delay-CJ have no installable distribution — confirmed, not assumed (npm
  and PyPI lookups resolve to unrelated same-named packages) — and reported
  environment-blocked rather than faked, the same treatment M3 Track 2 got.
  [ADR-0002](adr/0002-legitimacy-by-declaration-not-detection.md)'s
  predicted outcome (detection can't certify legitimacy either way) stands
  regardless; [docs/dual-use-evaluation.md](dual-use-evaluation.md)
  demonstrates the manifest/code-binding path as the real, already-tested
  defense. [ADR-0015](adr/0015-dual-use-detectors-environment-blocked.md).
- `.nojekyll` + a root `index.html` redirect to `/demo/`, in place for a
  future GitHub Pages deploy.

**Deliberately not done, by explicit choice rather than oversight:**

- **The demo is not hosted.** `demo/index.html` still runs locally only,
  via `python -m http.server`. Enabling GitHub Pages (a one-click repo
  Settings action: Deploy from branch → main → / (root)) and pushing are
  left to the maintainer — an externally-visible action outside this
  project's automation.
- **Neither package is published to npm.** Both are built and tested;
  `npm publish` needs the maintainer's own npm credentials and is a
  one-way action.
- **Outreach is handled privately by the maintainer**, not tracked in this
  repo — a business-development action, not a software one.

---

## How to keep this file honest

Update this file, not just the README table, whenever a milestone's status
changes. If an exit criterion turns out to be unmet when a milestone is
otherwise "done," record that explicitly rather than marking the milestone
complete — see M1's frame-drop and tamper-panel verification, which is real
but manual, and is labelled as such rather than folded into "34 tests
passing."
