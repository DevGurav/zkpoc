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
| Minimum safe audit rate | a\* = 1 / (1 + k), k = stake in shards | Inspection game — [ADR-0006](adr/0006-audit-rate-from-inspection-game.md) |
| ZK proving cost multiple | c_proof ≈ 10³–10⁶ | ZKML survey (arXiv:2502.18535) — refine with M3 Track 2 measurement |

### Shard verification constants (M2.1/M2.2, `packages/zkpoc-broker`)

| Constant | Value | Provenance |
| --- | --- | --- |
| Row challenge count (k) | **8** (`DEFAULT_CHALLENGE_ROWS`) | Keeps evasion probability f^k below 1% even at f=0.5 (a worker skipping half the work) — [ADR-0011](adr/0011-commit-then-challenge-row-verification.md) |
| Row-hash quantization | round(v × 10⁴) before SHA-256 | Matches the fp32 cross-implementation tolerance already used elsewhere; without it, honest WGSL vs. CPU workers commit to different roots for the same shard |
| Ground-truth spot-check density | 4 elements per revealed row | `verifyRowSubmission`'s `elementsPerRow` default, `shard.js` |

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
- **A verification challenge must depend on the worker's own commitment,
  never on public shard data alone.** A challenge derivable before the worker
  has done any work can be answered without doing the work — this is exactly
  the M2.1 vulnerability [ADR-0011](adr/0011-commit-then-challenge-row-verification.md)
  closes. Any future verification scheme (M2.4's audit sampler, M3's ZK
  circuits) must satisfy this or inherit the same hole.
- **The broker derives verification requirements itself; it never trusts a
  worker's choice of what to reveal or prove.** `verifyRowSubmission()`
  recomputes `challengeRows()` from the submitted root rather than accepting
  whatever rows the worker included — see ADR-0011. The same principle
  applies to anything M2.4 adds: sampling for audit must be broker-chosen,
  not negotiated.

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

### M2 — Broker, tiered verification, useful-PoW challenge protocol ✅ DONE

**Goal.** Turn a single governed worker into a verifiable multi-client system,
and build the flagship deployable artifact: useful work substituted into an
anti-bot proof-of-work slot.

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

**Exit criteria — all five met:**

1. ✅ Broker assigns tier-sized shards across ≥20 heterogeneous simulated
   clients, with redundancy consensus reaching correct verdicts. —
   `test/adversarial.test.js`, 24 distinct clients across 8 shards.
2. ✅ Adversarial harness caught at designed rates: garbage results, replayed
   results, Sybil identities, and selective non-participation. — same file;
   garbage/replay 100% (deterministic gate failures), partial-cheat
   empirically consistent with the f^k bound, Sybil stake-splitting shown to
   *raise* per-identity audit exposure not lower it, non-participation
   resolves to completed-or-abandoned with nothing left hanging.
3. ✅ **Attacker-advantage ratio measured** — `bench/attacker_advantage.py`,
   [ADR-0013](adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md).
   The ratio is unfavourable (41×–271× worse than the memory-hard control);
   the criterion was to measure and report it, not to arrive at a good
   number, and it's met either way.
4. ✅ Challenge widget issues, executes, and verifies useful work end to
   end — `challenge.js`, tested headlessly via the JS reference path. A real
   browser/WebGPU walkthrough is not yet done and is not claimed here.
5. ✅ Audit rate demonstrably derived from stake size, not hardcoded —
   `audit.js#minAuditRate`, exercised directly in `test/adversarial.test.js`'s
   Sybil tests.

**Primary risk, stated up front:** ML shard work is highly GPU-accelerable, so
an attacker with a GPU farm may enjoy a *larger* advantage over an honest
mobile user than a memory-hard hash puzzle would give them. If exit criterion
3 shows the ratio is worse than the memory-hard control, that is a finding to
report, not a number to bury — and it may force a mitigation (memory-hard
mixing into the shard commitment) or a scope change.

**Build order** (each phase independently testable):

| Phase | Scope | Testable headlessly? | Status |
| --- | --- | --- | --- |
| 2.1 | Shard model + tier-aware sizing from measured constants | Yes | ✅ done — **reworked once**, see below |
| 2.2 | Queue, assignment, nonce/freshness binding | Yes | ✅ done |
| 2.3 | Redundancy consensus + free-rider detection | Yes | ✅ done |
| 2.4 | Audit sampler (stake → a\*) + credit ledger | Yes | ✅ done |
| 2.5 | Challenge protocol wrapper + attacker-advantage measurement | Partly — needs real device timings | ✅ done |
| 2.6 | Adversarial harness across all of the above | Yes | ✅ done |

**2.1 correction, recorded here because it changes what 2.3 can assume.**
The first implementation of shard verification derived its challenge points
from public shard data alone, which meant a worker could compute the
challenge before doing any real work and pass verification while skipping
the O(n³) computation entirely — redundancy would not have caught this,
since two lazy workers agree with each other on the cheap subset. Found
while designing 2.3 and asking what consensus would actually defend against.
Fixed with commit-then-challenge row verification (Merkle-committed rows,
Fiat-Shamir challenge derived from the worker's own root) —
[ADR-0011](adr/0011-commit-then-challenge-row-verification.md). This is a
foundational fix, not a peripheral one: 2.3 is now being designed against a
scheme where a single verified submission carries real (if probabilistic,
f^k) evidence of full computation, which is what makes cross-worker root
comparison in 2.3 a meaningfully stronger check than raw-digest comparison
would have been.

**2.3 delivered:** `src/consensus.js` — a per-submission gate
(`verifyReplica`, wrapping ADR-0011's `verifyRowSubmission` plus an advisory
timing-anomaly check that never itself downgrades a cryptographically valid
result — see the module docstring on why speed is not evidence of cheating)
and a majority/dispute tally (`tallyVerifiedReplicas`, extracted as a pure
function specifically so majority/tie/minority logic could be tested against
hand-built verdict records rather than requiring an adversarial search to
construct two independently-valid-but-disagreeing roots for one shard). A
tie (including an exact 2-of-4 split) is a DISPUTE, not an arbitrary
pick — consensus does not resolve disagreement on its own; that is M2.4's
job. 19 tests, 140 passing across the monorepo.

**2.4 delivered:** `src/audit.js` — `minAuditRate(k)` mirrors
`bench/breakeven.py#min_audit_rate` exactly (pinned by test against the same
table BUILD.md §1 carries); `auditDraw()` reuses `challengeRows()`'s
Fiat-Shamir pattern so audit *selection* is unpredictable to a worker before
it commits, for the same reason challenge *content* is (ADR-0011);
`auditFull()` re-verifies every row (k=n) rather than the k=8 sample,
modelled as the honest stand-in for M3's ZK proof rather than a weaker
approximation of it — a worker that passes owes its pass to certainty, not
probability. `src/ledger.js` — stake and earned balance kept as separate
pools (conflating them would let a worker's own payout fund its deterrence
bond), `slash()` restricted to a closed `ViolationReason` enum so a caller
cannot slash for an unaudited ad hoc reason. `test/dispute-resolution.test.js`
demonstrates the scenario this phase exists for end to end: two replicas
that both pass the cheap gate but disagree (DISPUTED, per M2.3) force a full
audit regardless of stake, the audit exposes which one lied, and the ledger
pays the honest party while forfeiting the dishonest one's full stake. 33
new tests (139 in `zkpoc-broker`, 173 across the monorepo).

Not yet wired into one orchestrating call — consensus, audit and the ledger
are composed by hand in the integration test, deliberately: the policy
questions a real orchestrator has to answer (how many disputed replicas get
audited, what happens when an audit itself is inconclusive) belong to 2.5,
which is where these pieces meet an actual protocol rather than a
demonstration of composability.

**2.5 delivered:** `src/challenge.js` — issue/resolve for anti-bot
proof-of-work, deliberately **not** built on `ShardQueue`/`reachConsensus`/
`CreditLedger`: an anonymous site visitor has no time to wait for a second
replica, no persistent identity, and no stake to slash, so reusing the
barter pipeline underneath this mode would carry assumptions that don't
hold for it — see [ADR-0012](adr/0012-challenge-mode-single-submission-gate.md).
Verification is ADR-0011's single-submission gate alone; a response's timing
is reported as a ratio against the sizing target, never used to auto-deny
(a fast legitimate device is not evidence of cheating — same principle as
consensus.js's timing-anomaly signal).

`bench/attacker_advantage.py` then took the measurement M2.5 exists for:
this project's own measured GEMM kernel gives an attacker a **181.7×**
GPU/CPU throughput advantage, against a **0.67×–4.38×** literature-cited
range for a memory-hard control (Argon2id, two independent sources a decade
apart) — **41×–271× worse** than the control across that range. The primary
risk named in this file before any M2 code existed has materialised;
recorded as [ADR-0013](adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md)
rather than softened. A mitigation (mix a memory-hard KDF into the row
commitment) is named, not built — tracked as Q7 below.

13 new tests (152 in `zkpoc-broker`, 186 across the monorepo). Challenge
execution is tested headlessly via the JS reference path only; a real
browser/WebGPU walkthrough is not yet done and is not claimed here — see
`docs/testing-strategy.md`'s manual-vs-automated distinction.

**2.6 delivered:** `test/adversarial.test.js` — closes M2's two remaining
exit criteria together, since they're one scenario, not two. 24 distinct
simulated clients across 8 shards (redundancy 3) exercise every attack
class named in the exit criteria at once, then reward/slash through the
ledger exactly as a real orchestrator would. Two real bugs surfaced while
building the harness, both in the test itself, not production code: an
arithmetic slip in a hand-computed expected total (16 vs. a claimed 18), and
a genuine misunderstanding of `ShardQueue.assign()`'s contract — it
auto-selects the next *eligible* shard for a given worker id, it does not
accept a caller-chosen target, so a loop written as "for each shard id,
assign a worker to it" silently assigned everything to whichever shard
happened to still have room. Fixed by draining all open slots with fresh
worker ids each round instead of iterating shard ids directly. Garbage and
replay are caught at exactly 100% across 15 independent trials each
(deterministic cryptographic gate failures, not a probabilistic bound).
Partial cheating — the one attack class ADR-0011 gives a probabilistic
bound for for, not a certain one — is checked empirically against the f^k
prediction across 40+20 deterministic fixtures (varied nonces, not RNG
draws; see the file's own note on why that is a different and weaker claim
than a Monte Carlo confidence interval, and why it's still the right thing
to check). Sybil identities are shown to *raise* their own per-identity
audit exposure by splitting stake, not lower it — a direct, testable
consequence of a\*=1/(1+k) being per-identity. 9 new tests (161 in
`zkpoc-broker`, 195 across the monorepo).

**All five M2 exit criteria are now met. M2 is done.**

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
| Q1 | Does ML shard work widen the attacker/honest-user cost gap vs. a memory-hard puzzle? | M2 exit #3 | **Resolved — yes, 41×–271× wider.** `bench/attacker_advantage.py`, [ADR-0013](adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md) |
| Q2 | What is c_proof in practice, not as a 10³–10⁶ range? | Sharpens §1, ADR-0006 | Open — M3 Track 2 |
| Q3 | Do discrete-GPU tiers hold their clocks better than the integrated tier measured so far? | Five placeholder tiers | Open — needs sustained runs on more hardware |
| Q4 | Can `data_access` containment be *proven* rather than structurally asserted? | Strengthens SPEC's stated gap | Open — post-M3 |
| Q5 | Does the stake/slashing mechanism ADR-0006 assumes survive contact with a real adversary model? | M2 exit #5 | Open |
| Q6 | Revealing k full rows costs O(k·n) floats per submission (k=8, n=1024 → ~32KB) — is that bandwidth acceptable for a real challenge-mode round trip, or does it need row-compression / a smaller n for challenge-sized shards? | M2.5 | Open — needs a real transport, not just headless tests |
| Q7 | Can mixing a memory-hard KDF into `merkle.js#hashRow`'s commitment close (or narrow) the Q1 gap without changing the underlying GEMM kernel or the useful-work claim? What does that cost `commitFullResult()`? | Mitigates ADR-0013 | Open — named as the fix, not yet designed or benchmarked |
