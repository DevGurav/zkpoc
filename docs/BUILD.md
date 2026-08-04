# BUILD — the working spec

**This is the document to open before writing code, and to update after.**

It is deliberately different from its neighbours:

| Doc | Answers |
| --- | --- |
| **BUILD.md** (this file) | *What am I building next, against what constraints, and how do I know it's done?* |
| [roadmap.md](roadmap.md) | *What is the current status of each milestone?* |
| [adr/](adr/README.md) | *Why was this decided, and what was rejected?* |
| [architecture.md](architecture.md) | *How do the pieces fit together?* |

Working rule: **read §1 and §2 before starting any milestone.** They carry
forward every measured constant and every invariant that later work is not
allowed to break. When a milestone finishes, update §4 (its Definition of
Done) and `roadmap.md`, and add an ADR if a decision was made that would be
expensive to re-derive.

---

## 1. Carried constants

Measured values that constrain downstream design. **Do not re-derive these,
and do not silently substitute estimates for them.** Every number here is
either measured on real hardware or corrected from a source with a runnable
reproduction. Provenance is linked; if you need a number not on this list,
measure it and add it here.

### Device: `laptop-igpu` (Intel Gen-12LP / Iris Xe) — the one fully-measured tier

| Constant | Value | Provenance |
| --- | --- | --- |
| Sustained throughput F(d) | **107.2 GFLOPS** (±4.08, CV 3.8%) | 120s N=1024 sustained run, OLS trend fit, warmup excluded — [ADR-0010](adr/0010-sustained-trend-fit-not-quick-sweep.md) |
| Fixed WebGPU dispatch overhead | **4.014 ms** | Multi-size regression, `bench/dispatch_analysis.py` |
| Marginal throughput (regression fit) | 92.58 GFLOPS | Same regression. **Prefer F(d) above** — this figure is warmup-biased low |
| Min shard size for ≤10% overhead | **N ≥ 1187** | Derived from the two above |
| Marginal power draw | **9.1 W** | WMI energy-counter differencing — [ADR-0009](adr/0009-energy-counter-not-instant-rate.md) |
| Break-even wattage W\* | **5.6 W** | `bench/breakeven.py#critical_watts` — measured draw exceeds it, so this tier is uneconomic at every share |

### Economic constants

| Constant | Value | Provenance |
| --- | --- | --- |
| Corrected cryptojacking baseline | **$0.000438 / device-hour** | ~87× correction to Saad & Mohaisen — [ADR-0008](adr/0008-tdsc-baseline-correction.md) |
| Compute spot reference | $1.0×10⁻⁵ / GFLOPS-hour | `bench/breakeven.py#PI_MARKET_USD_PER_GFLOPS_HR` |
| Break-even share, best case | σ\* ≈ 6.7% vs. a 5% design ceiling | Most favourable assumptions modelled — [ADR-0001](adr/0001-break-even-frontier-and-anti-bot-flagship.md) |
| Verification efficiency | η = 1 / (r + a·c_proof) | `bench/breakeven.py#VerificationPolicy` |
| ZK proving cost multiple | c_proof ≈ 10³–10⁶ | ZKML survey (arXiv:2502.18535) — refine with M3 Track 2 measurement |

### Known-unmeasured (flagged, not assumed away)

Five of six device tiers remain literature-anchored placeholders. `bench/breakeven.py`
marks them `*` (FLOPS) and `w` (watts) on every run. **Do not quote a σ\* figure
for an unmeasured tier without the caveat.** The one tier that *was* measured
came in 11× below its placeholder, and the first attempt to correct it was
also wrong — see [device-tiers.md](device-tiers.md).

---

## 2. Invariants

Properties already built and tested. **Breaking any of these is a regression,
not a design change.** If a milestone appears to require breaking one, that is
an ADR-worthy decision, not a quiet edit.

### Consent and verification

- **A manifest that fails verification never runs.** `Governor.start()` checks
  `verification.ok` before constructing a `Worker` and returns `false` into
  `State.DENIED` otherwise. This is the whole contract.
- **Missing loaded code is a FAILED check, not a skipped one.**
  `verifyManifest()` without `loadedCode` reports `code_binding` failed. An
  unbound declaration is not evidence.
- **Every manifest field is signature-covered**, over an RFC 8785 canonical
  serialisation, so a third party can recompute signed bytes from the parsed
  object alone — [ADR-0004](adr/0004-canonical-json-signing.md).
- **`revocation.user_revocable` must be `true`.** A consent manifest the user
  cannot withdraw is rejected at the schema level.

### Execution and enforcement

- **The worker never controls its own schedule.** It reports *measured* busy
  time; the governor decides when to call it again. A compromised kernel can
  return wrong values but cannot grant itself more compute.
- **Cumulative share converges on the declared ceiling from below**, never
  above — integral control repays overshoot — [ADR-0005](adr/0005-integral-share-control.md).
- **Revocation is immediate**, terminating the worker mid-dispatch rather than
  waiting for the current unit of work.
- **WebGPU is the load-bearing path**; the CPU path is a fallback and a
  lower-bound reference only — [ADR-0003](adr/0003-webgpu-mandatory.md).

### Claims discipline

- **Challenge mode and barter mode stay structurally separate.** In challenge
  mode the client is unpaid, so per-request cost asymmetry (deterrence) holds.
  In barter mode the client *is* paid, so the PoUW security-budget critique
  applies in full and **no anti-abuse claim is made** —
  [ADR-0001](adr/0001-break-even-frontier-and-anti-bot-flagship.md). Do not
  let a shared code path blur this.
- **Legitimacy comes from declaration, never from detection.** Do not
  reintroduce a detector as a security control —
  [ADR-0002](adr/0002-legitimacy-by-declaration-not-detection.md).
- **F(d) comes from sustained runs only.** Quick sweeps measure warmup —
  [ADR-0010](adr/0010-sustained-trend-fit-not-quick-sweep.md).

---

## 3. Definition of done (every milestone)

A milestone is done when **all** of these hold. "Code written" is not done.

1. Exit criteria in §4 met, each one demonstrated rather than asserted.
2. Automated tests for the logic that can be tested headlessly, following
   [testing-strategy.md](testing-strategy.md) — assert *which* check failed,
   not just that something did.
3. Anything verified only by hand is **labelled as manual** in
   `testing-strategy.md`, not folded into the automated count.
4. No invariant from §2 broken (or: an ADR explains why one changed).
5. `CHANGELOG.md` updated, including bugs found and fixed along the way.
6. `roadmap.md` status updated; §4 below updated with what actually shipped.
7. An ADR written for any decision expensive to re-derive — **including
   wrong first answers that measurement corrected.**

---

## 4. Milestone specs

### M0 — Economic model + device benchmark ✅ DONE

Exit criteria met. Delivered the break-even surface, the corrected TDSC
baseline, the device probe, dispatch-overhead separation, and power
measurement. Full account in [roadmap.md](roadmap.md#m0--economic-model--device-benchmark).

### M1 — Worker, governor, Compute Consent Manifest ✅ DONE

Exit criteria met: shard executing under an enforced ceiling, governor
pre-empting under load, manifest independently verifiable. 34 tests. Browser
behaviour verified manually and labelled as such.

### M2 — Broker, tiered verification, useful-PoW challenge protocol

**Not started.** Goal: turn a single governed worker into a verifiable
multi-client system, and build the flagship deployable artifact: useful work
substituted into an anti-bot proof-of-work slot.

**Design contract:**

- **Shard sizing is a first-class constraint, not tuning.** Per §1, shards
  below N≈1187 on the reference device sell dispatch latency rather than
  compute (91.6% overhead at N=256). The broker must size shards from measured
  device tiers, and must refuse or downgrade a tier it has no measurement for
  rather than guessing.
- **Freshness by construction.** Challenge shards are drawn from a live buyer
  queue and bound to a per-session nonce. Unlike a hash puzzle, real work
  cannot be precomputed — this is the property that makes useful-PoW
  defensible where the Anubis/SHA-256 baseline is already broken.
- **Verification is tiered.** Redundancy consensus on the bulk (cheap, catches
  most free-riding), ZK audit on a sample at rate a\* = 1/(1+k) (expensive,
  makes the stake's deterrence credible). η = 1/(r + a·c_proof) must stay
  economically survivable — see §1.
- **Modes stay separate.** Challenge mode (client unpaid, deterrence claim
  holds) and barter mode (client paid, no anti-abuse claim) must not share a
  reward path.

**Exit criteria:**

1. Broker assigns tier-sized shards across ≥20 heterogeneous simulated
   clients, with redundancy consensus reaching correct verdicts.
2. Adversarial harness catches garbage results, replayed results, Sybil
   identities, and selective non-participation at designed rates.
3. Attacker-advantage ratio (GPU-equipped attacker vs. honest mobile device)
   measured against a memory-hard control and reported, whichever way it
   comes out.
4. Challenge widget issues, executes, and verifies useful work end to end.
5. Audit rate demonstrably derived from stake size, not hardcoded.

**Primary risk, stated up front:** ML shard work is highly GPU-accelerable, so
an attacker with a GPU farm may enjoy a *larger* advantage over an honest
mobile user than a memory-hard hash puzzle would give them. If exit criterion
3 shows the ratio is worse than the memory-hard control, that is a finding to
report, not a number to bury — and it may force a mitigation (memory-hard
mixing into the shard commitment) or a scope change.

### M3 — ZK layer

Plan recorded ahead of implementation in
[ADR-0007](adr/0007-tiered-zk-proving-plan.md) because its two shaping
constraints are already settled by evidence: WASM's 4 GB ceiling rules out
in-browser zkVMs entirely, and FibRace measured a ≥3 GB RAM floor for
client-side proving.

- **Track 1 (must land, in-browser):** Circom + snarkjs Groth16 over one fixed
  small kernel; Solidity verifier on Anvil.
- **Track 2 (settlement-side, measurement only):** RISC Zero or SP1 on the
  broker, producing the real `c_proof` that §1 currently carries as a range.
  Must not block Track 1.

**Exit criteria:** Track 1 proof verifies on-chain and a tampered witness is
rejected; Track 2 produces an overhead table that replaces the c_proof range
in §1 with a measured value.

### M4 — Demo, SDK, standards, dual-use evaluation

- Hosted one-click demo; `zkpoc-challenge` + `zkpoc-sdk` published.
- W3C/WICG explainer built from [SPEC.md](../packages/zkpoc-ccm/SPEC.md).
- **Dual-use evaluation** per [ADR-0002](adr/0002-legitimacy-by-declaration-not-detection.md):
  run MinerRay/MINOS/Delay-CJ and *expect and report* that they cannot
  distinguish this system from covert mining, then demonstrate the
  manifest/code-binding path as the actual legitimacy mechanism.

---

## 5. Open questions

Tracked here so they don't get silently resolved by assumption.

| # | Question | Blocks | Status |
| --- | --- | --- | --- |
| Q1 | Does ML shard work widen the attacker/honest-user cost gap vs. a memory-hard puzzle? | M2 exit #3 | Open — needs M2's attacker-advantage measurement |
| Q2 | What is c_proof in practice, not as a 10³–10⁶ range? | Sharpens §1, ADR-0006 | Open — M3 Track 2 |
| Q3 | Do discrete-GPU tiers hold their clocks better than the integrated tier measured so far? | Five placeholder tiers | Open — needs sustained runs on more hardware |
