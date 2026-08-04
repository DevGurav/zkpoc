# Roadmap

Single source of truth for milestone status — the table in `README.md` is a
summary of this, not the other way around. If they disagree, this file is
right and the README needs updating.

## Status at a glance

| Milestone | Status | Exit criteria met? |
| --- | --- | --- |
| M0 — Economic model + device benchmark | **Done** | Yes — see below |
| M1 — Worker, governor, Compute Consent Manifest | **Done** | Yes — see below |
| M2 — Broker, tiered verification, useful-PoW challenge protocol | **Not started** | — |
| M3 — ZK layer (in-browser Groth16 + settlement-side zkVM) | **Not started** (plan recorded — [ADR-0007](adr/0007-tiered-zk-proving-plan.md)) | — |
| M4 — Demo, SDK, W3C/WICG explainer, dual-use evaluation | **Not started** | — |

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
107.2 GFLOPS, watts = 9.1 W, both real. The other five remain
literature-anchored placeholders — flagged on every `bench/breakeven.py` run.

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

**Not started.** Planned scope: turn a single governed worker into a
verifiable multi-client system, and build the flagship deployable artifact —
useful work substituted into an anti-bot proof-of-work slot. Design contract
recorded in [BUILD.md §4](BUILD.md#m2--broker-tiered-verification-useful-pow-challenge-protocol)
ahead of implementation, including the primary named risk (ML shard work may
widen the attacker/honest-user cost gap vs. a memory-hard puzzle — tracked as
Q1 in BUILD.md §5).

## M3 — ZK layer

**Not started**, but the plan is recorded ahead of implementation in
[ADR-0007](adr/0007-tiered-zk-proving-plan.md), because the two constraints
that shape it (WASM's 4GB memory ceiling; FibRace's measured ≥3GB RAM floor
for client-side proving) are already settled by evidence and don't need
rediscovering under time pressure:

- **Track 1 (must land, in-browser):** Circom + snarkjs Groth16 over one fixed
  small kernel, Solidity verifier on Anvil/Hardhat.
- **Track 2 (settlement-side, measurement only):** RISC Zero or SP1 over the
  same shard, producing the `c_proof` overhead figure
  `bench/breakeven.py`'s `VerificationPolicy` already has a parameter slot
  for.
- Optional stretch: reproduce VerifBFL's native Nova/IVC benchmarks via
  `nova-snark`, then measure degradation in a throttled browser tab — a
  direct comparison against the primary reference on identical circuits.

## M4 — Demo, packaging, standards, outreach

**Not started.** Planned scope:

- Hosted one-click demo (current `demo/index.html` runs locally over
  `python -m http.server`; not yet deployed).
- `zkpoc-challenge` + `zkpoc-sdk` on npm; worker crate packaging.
- W3C/WICG Compute Consent Manifest explainer, built from
  `packages/zkpoc-ccm/SPEC.md`.
- **Dual-use evaluation**, reframed per
  [ADR-0002](adr/0002-legitimacy-by-declaration-not-detection.md): run
  MinerRay/MINOS/Delay-CJ baselines and *expect and report* that they cannot
  reliably distinguish this system from covert mining, citing the WASM
  diversification evasion result as evidence this is a property of
  detection-based approaches generally, not a defect specific to this design
  — then demonstrate the positive path (independent manifest/code-binding
  verification) as the actual legitimacy mechanism.
- Outreach: Cloudflare, Friendly Captcha, ALTCHA, mCaptcha, Anubis
  maintainers (bot-deterrence deployment slot); Brave, Mozilla/WICG (consent
  and governance angle). See the original plan's "Making it visible to a
  large company" section for the full sequencing rationale.

---

## How to keep this file honest

Update this file, not just the README table, whenever a milestone's status
changes. If an exit criterion turns out to be unmet when a milestone is
otherwise "done," record that explicitly rather than marking the milestone
complete — see M1's frame-drop and tamper-panel verification, which is real
but manual, and is labelled as such rather than folded into "34 tests
passing."
