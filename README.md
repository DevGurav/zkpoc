# ZK-PoC

**Consent-governed, verifiable browser compute — and an honest measurement of
whether it can pay for anything.**

The web has two funding rails: surveillance advertising and hard paywalls.
The industry's flagship attempt at a third — Google's Privacy Sandbox — was
retired in October 2025 and fully removed from Chrome in M150 (July 2026),
with Protected Audience never exceeding 1% adoption. The problem is not merely
unsolved; the best-funded attempt was withdrawn.

ZK-PoC asks whether metered, consented, cryptographically verified spare
compute can be that third rail, and measures the answer rather than asserting
it.

---

## Two results, both reproducible in under a minute

### 1. The canonical cryptojacking baseline is overstated by ~87×

Saad & Mohaisen (*IEEE TDSC* 2024, arXiv:2304.13253) is the reference economic
analysis of in-browser compute monetisation. It reports a yield of
`$1.06 × 10⁻⁵ USD/second`. Recomputed from the paper's own Eq. (5) and its own
parameters, the correct figure is **`$1.22 × 10⁻⁷ USD/second`** — the reported
value is their P divided by 60 rather than by the 5100-second session.

Every other intermediate in the paper reproduces exactly (3.19e-6 XMR,
$6.38e-4, L/P ≈ 7×, 3.45e10 hashes per XMR, ~52 years to mine 1 XMR). **This
strengthens their negative conclusion rather than undermining it** — the true
yield is $0.00044/device-hour, so the profit-and-loss gap they identify is
~87× wider than stated. ([ADR-0008](docs/adr/0008-tdsc-baseline-correction.md))

```sh
python bench/tdsc_reproduction.py
```

The script also reports a reconciliation of Table 9. Two of the nine rows do
not close against a fixed per-device session length; for Windows α=0.5 the
reported P and T *both* invert to h ≈ 10.5 against a printed h = 14, so the row
is internally consistent and the printed hash rate is the outlier. Reported as
a reconciliation, not an error claim — the table does not print a per-row Δt.

### 2. The ≤5% ambient resource ceiling cannot work, but only just

```sh
python bench/breakeven.py
```

Solving `V_compute·η_verify − E_cost > R_ads` for the resource share σ gives
the break-even surface σ\*(device, market) — the share of a device needed for
compute barter to match advertising. Nobody has published this.

Under the *most favourable* assumptions available — best device class,
cheapest ad inventory, theoretical cloud-spot parity, zero redundancy and zero
verification overhead — the answer is **σ\* = 6.7%**, against a design ceiling
of 5%.

The ceiling misses by 1.3×, not by an order of magnitude. The constructive
reading is that the architecture is close to right and the ceiling is simply
set too low: at roughly 7–25% share on a discrete GPU, long-tail inventory is
reachable. That is a design recommendation, not a refutation.

Two corollaries fall out of the same model:

- **WASM-on-CPU is economically dead** at any share — electricity costs more
  than the compute is worth. WebGPU is not an optional path, it is the project.
  ([ADR-0003](docs/adr/0003-webgpu-mandatory.md))
- **ZK auditing is only viable when paired with a large stake.** Proving costs
  10³–10⁶× the work it proves, so any audit rate high enough to deter
  free-riding on its own destroys the economics. The inspection game gives
  `a* = 1/(1+k)` for a stake worth `k` shards: a stake of ~10³–10⁴ shards drops
  the required audit rate far enough that proofs become a rounding error.
  Deterrence comes from the stake so the proof can stay rare.
  ([ADR-0006](docs/adr/0006-audit-rate-from-inspection-game.md))

### 3. The first fully-measured device: 107.2 GFLOPS, 9.1 W, uneconomic — and a lesson in measurement discipline

An Intel Gen-12LP (Iris Xe) was placeholder-estimated at 850 GFLOPS. Getting a
trustworthy number took two passes, and the second one overturned a conclusion
the first pass looked confident about.

```sh
python bench/dispatch_analysis.py
```

A first, 7-rep sweep across N=256/512/1024 gave a "sustained" rate of 75.4
GFLOPS, with every run decaying monotonically within itself — which looked
exactly like thermal throttling on an integrated GPU sharing power with the
CPU. It wasn't. A genuine 120-second sustained run at N=1024 shows throughput
climbing for the first ~16 seconds and then holding flat (OLS trend
**+2.4%/min**, within sampling noise) at **107.2 GFLOPS**. Seven dispatches is
~200 ms of GPU work — the earlier run never got past the warmup ramp, and a
too-short measurement produced a wrong story that fit a plausible hardware
narrative. The probe's plateau detector was rewritten from a spread threshold
(which flagged this exact run as "not plateaued") to a trend fit that can
actually tell *noisy-but-flat* from *genuinely declining*.

The dispatch-overhead result survives untouched: fitting
`t(N) = overhead + 2N³/throughput` separates a **fixed 4.0 ms per-dispatch
cost** from throughput. At N=256, 91.6% of measured time is the
`onSubmittedWorkDone()` fence — a small shard measures the fence, not the
device — which puts a floor of **N ≥ 1187** on shard sizing to keep overhead
under 10%. That's a first-class M2 problem, not a tuning detail: the cuPOW
paper names difficulty calibration as PoUW's unsolved problem, and this is the
concrete answer for this device.

Marginal watts were measured too, via WMI energy-counter differencing
(`bench/power/`) — **9.1 W**, after a dedicated settle phase, since the first
attempt showed the idle baseline itself drifting 17→34 W as the machine wound
down from being touched. With the corrected F(d), break-even wattage `W*`
rises from 3.9 W to **5.6 W**. Measured draw exceeds it either way: **the tier
is uneconomic at every share** — the Pass-1 conclusion survives, but now on
numbers that are right rather than numbers that happened to agree by accident.
Full account in [docs/device-tiers.md](docs/device-tiers.md), decision record
in [ADR-0009](docs/adr/0009-energy-counter-not-instant-rate.md) and
[ADR-0010](docs/adr/0010-sustained-trend-fit-not-quick-sweep.md).

> The remaining five tiers are still literature-anchored **placeholders**. The
> lesson above argues for caution in both directions — the original placeholder
> was wrong by 11×, and the first attempt to correct it was *also* wrong, just
> less wrong. The solver flags every unmeasured value on every run — `*` for
> FLOPS, `w` for watts — and σ\* stays provisional until more devices are
> measured with a sustained run, not a quick one.

---

## Measuring your own device

Open [`bench/device/probe.html`](bench/device/probe.html) — no build step, no
dependencies. It measures achievable GFLOPS on the WebGPU and CPU paths at a
controlled duty cycle (100% / 25% / 5%), verifies the GPU result against a CPU
recomputation so a timing number alone is never trusted, and exports JSON.

Two modes, and the distinction matters:

- **quick (reps)** — sweep N=256/512/1024 and feed all three to
  `bench/dispatch_analysis.py`, which separates fixed dispatch overhead from
  marginal throughput. Not valid as F(d) on its own.
- **sustained (60–300 s)** — the only mode whose number belongs in the economic
  model. It buckets throughput over time and reports whether the curve actually
  **plateaued**; if it did not, the steady value is still an upper bound and it
  says so rather than quietly reporting the last sample as converged.

Save the output to `bench/device/measurements/<tier-name>.json` and
`bench/breakeven.py` picks it up automatically.

For `watts_full`, which no browser can provide, see
[bench/power/](bench/power/README.md) — on Windows the ACPI battery reports
discharge in mW through WMI, so an idle/load/idle sequence gives marginal draw
with nothing to install:

```sh
powershell -File bench/power/measure-windows.ps1 -LoadSeconds 120
python bench/power/analyse_power.py --tier laptop-igpu
```

Quantifying energy and thermal effects is the gap FibRace (arXiv:2510.14693
§5.1.3) explicitly left open, so it is instrumented deliberately rather than
assumed.

---

## Where this is going

The barter economics above are a *measurement*, not the product. The deployable
application of the same machinery is **anti-bot proof-of-work**.

Cloudflare Turnstile, Friendly Captcha, ALTCHA, mCaptcha and Anubis already burn
client CPU at ~100% for 1–3 seconds on a large fraction of web requests,
producing output nobody wants — and that baseline is already broken: a free-tier
Google Compute Engine instance can mine enough tokens to bypass every Anubis
deployment on the internet in about six minutes. Substituting useful, verified
work keeps the deterrence property while recovering the waste, and gets two
things hash puzzles cannot: inputs drawn from a live buyer queue (unpredictable,
so un-precomputable) and a proof the work was actually done.

The obvious objection is the 2025 SoK *Is Proof-of-Useful-Work Really Useful?*
(IACR ePrint 2025/1814), which shows utility undermines the security budget in
PoUW consensus. It does not transfer here: the shard output goes to the workload
buyer and the revenue to the site operator, so the client — honest user or bot —
receives nothing and the per-request cost asymmetry is preserved. That is the
SoK's own recommended remedy, *partial incentive allocation*. The boundary is
stated honestly: in **barter** mode the client *is* paid, so the criticism
applies in full and no anti-abuse claim is made for that mode.

| Milestone | Status |
| --- | --- |
| **M0** Economic model + device benchmark | done |
| **M1** Worker + resource governor + Compute Consent Manifest | done; 34 tests passing |
| **M2** Broker, tiered verification, useful-PoW challenge protocol | done; 161 tests, [ADR-0013](docs/adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md) finding reported |
| **M3** ZK layer — in-browser Groth16, settlement-side zkVM | Track 1 done, Track 2 environment-blocked ([ADR-0007](docs/adr/0007-tiered-zk-proving-plan.md), [ADR-0014](docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md)) |
| **M4** Demo, SDK, W3C/WICG explainer | packages + explainer + dual-use evaluation done; deploy/publish/outreach deliberately not sent |

This table is a summary. [docs/roadmap.md](docs/roadmap.md) is the source of
truth — exit criteria, what shipped, and what's still open per milestone.

---

## Consent and enforcement (M1)

Because covert compute cannot be reliably detected — WASM diversification
evades MINOS in **100%** of cases (arXiv:2403.15197) — legitimacy here comes
from *declaration*, not detection ([ADR-0002](docs/adr/0002-legitimacy-by-declaration-not-detection.md)).
The [Compute Consent Manifest](packages/zkpoc-ccm/SPEC.md) is a signed statement of
which code will run, how much of the device it may take, for how long, and what
it may touch, verifiable by someone who trusts neither publisher nor broker.
Signing uses RFC 8785 canonical JSON, not `JSON.stringify`
([ADR-0004](docs/adr/0004-canonical-json-signing.md)), so a third party can
recompute the signed bytes from the parsed object alone.

Three properties make the declaration mean something:

- **Code binding** — SHA-256 digests of the worker and every kernel. Without
  this you declare one thing and ship another. A verifier given no loaded code
  gets a *failed* check, not a skipped one.
- **Enforceable limits** — every `limits` field maps to something the governor
  caps at runtime by withholding scheduling time. The schema admits no field
  nothing enforces.
- **Containment scope** — `data_access` is enforced structurally where possible:
  execution is in a dedicated Worker, which has no DOM, so `dom: "none"` is a
  property of the context rather than a promise.

The [governor](packages/zkpoc-worker/src/governor.js) holds the schedule and
therefore the power — the worker never decides how much of the device to use.
Share control is **integral, not per-burst**: sleeping `busy × (1/target − 1)`
after each burst pins the *instantaneous* share but lets a burst that overran
its budget permanently inflate the session average. The target wall-clock is
recomputed from cumulative busy time instead, so overshoot is repaid and the
session average converges on the ceiling from below
([ADR-0005](docs/adr/0005-integral-share-control.md)). Four signals throttle
independently and compose multiplicatively: user interaction, dropped frames,
sustained throughput decay (a thermal proxy — no browser exposes temperature),
and battery discharge. Full API in
[packages/zkpoc-worker/API.md](packages/zkpoc-worker/API.md).

```sh
npm test --prefix packages/zkpoc-ccm      # 28 tests
npm test --prefix packages/zkpoc-worker   #  6 tests
```

### Running the demo

Module workers and ES imports do not load from `file://`, so serve the repo:

```sh
python -m http.server 8000
```

Then open `http://localhost:8000/demo/`. Issue a manifest, watch the
verification checks, start the governor, and use the tamper buttons — each one
alters the manifest after signing, and both the verifier and the governor must
reject it.

---

## Verifiable compute, and an uncomfortable measurement (M2)

`packages/zkpoc-broker/` turns a single governed worker into a
multi-client system, split into two pipelines that deliberately don't share
a verification or reward path
([ADR-0012](docs/adr/0012-challenge-mode-single-submission-gate.md)):

- **Barter** — crowdsourced compute, a worker paid for confirmed work. Shard
  queue with lease-based assignment → commit-then-challenge verification
  → redundancy consensus → stake-derived audit → a credit ledger that pays
  and slashes.
- **Challenge** — anti-bot proof-of-work, the flagship. An anonymous visitor
  has no time to wait for a second replica and no stake, so this path skips
  the barter machinery entirely: issue a shard, verify the one response, admit
  or deny.

Both rest on **commit-then-challenge** result verification
([ADR-0011](docs/adr/0011-commit-then-challenge-row-verification.md)): an
earlier design derived the check directly from public shard data, which a
worker could satisfy in O(n) without ever running the O(n³) computation being
paid for — found while designing consensus and asking what it would actually
defend against. Fixed by having the worker Merkle-commit every row first;
the challenge is derived from *that root*, so a valid one costs the real
computation.

**The finding worth stating plainly:** `bench/attacker_advantage.py`
measured M2's stated primary risk — before any of this was built,
[BUILD.md](docs/BUILD.md) named the concern that GPU-accelerable shard work
might hand an attacker more advantage than a memory-hard puzzle would. It
does: this project's own measured GEMM kernel gives a GPU-equipped attacker
a **181.7× throughput advantage** over a CPU-bound honest device — against a
**0.67×–4.38×** range for a memory-hard control (Argon2id, two independent
published sources a decade apart: an 8×RTX5090 rig that was *slower* than a
single server CPU, and a historical Titan X benchmark). **41×–271× worse**
than the control, reported directly rather than reframed —
[ADR-0013](docs/adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md).
A mitigation (mix a memory-hard KDF into the row commitment) was built and
measured, honestly, after the fact — and found **not practically deployable
as specified**: cost scales linearly with shard size, so no buffer size
tested is both plausibly GPU-resistant and fast enough not to roughly
double or triple honest-user wait time. Not shipped as a default; a cheaper
alternative approach is named, not built —
[ADR-0016](docs/adr/0016-memory-hard-commitment-mitigation.md),
`bench/memory_hard_overhead.js`.

```sh
npm test --prefix packages/zkpoc-broker   # 170 tests
python bench/attacker_advantage.py
```

---

## Proved, not just checked (M3)

Everything above verifies a claim by re-checking it (redundancy, audit,
row-reveal). `circuits/quant_dot.circom` proves one instead: a Groth16 circuit
over an 8-term quantized dot product — the same computation
`shard.js#referenceElement` performs, the same `QUANTIZE_SCALE` convention
`merkle.js` uses — that convinces a verifier the private witness satisfies
the claimed output *without revealing the witness*. That's the gap this
closes relative to M2's row-reveal audit: `auditFull()` proves correctness by
disclosing every challenged row in the clear; this circuit proves the same
class of claim while disclosing nothing.

Circom2 (a WASM port of the circom compiler) and snarkjs stand in for a
native Rust toolchain unavailable in this environment; Hardhat 2's local EVM
stands in for Anvil. Both choices, plus why this toolchain lives in its own
`zk/` package outside the rest of the project's zero-dependency packages,
are in [ADR-0014](docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md).

```sh
cd zk && npm install && npm run build && npm test   # 4/4 passing
```

`npm test` deploys the generated `contracts/ShardRowVerifier.sol` to
Hardhat's local EVM, proves a real `Shard`-derived witness, and checks both
directions: the genuine proof verifies true, and a tampered public signal
and a tampered proof point are each independently rejected.

**Stated plainly, the settlement-side half didn't land.** The plan
([ADR-0007](docs/adr/0007-tiered-zk-proving-plan.md)) called for a second,
independent track — RISC Zero or SP1 measuring proving overhead on the
broker at settlement, to replace the literature-derived `c_proof` range in
the break-even model with a measured number. Both need a Rust toolchain with
no WASM/npm-installable distribution, and none is available here. Rather
than substitute a guessed number, `c_proof` stays a range — see ADR-0014 and
`docs/BUILD.md`'s Q2.

---

## Packaged, explained, and honestly scoped (M4)

Two npm-shaped packages turn the pieces above into drop-in integrations:

- **[`@zkpoc/sdk`](packages/zkpoc-sdk/)** — the five-line publisher
  integration (`runSession()`) that issues a manifest, verifies it, and
  runs the governed worker session, wrapping `@zkpoc/ccm` + `@zkpoc/worker`.
- **[`@zkpoc/challenge`](packages/zkpoc-challenge/)** — the client half of
  the anti-bot challenge protocol, interoperating directly with
  `packages/zkpoc-broker/src/challenge.js`'s server half.

**[`explainer/index.md`](explainer/index.md)** translates the Compute
Consent Manifest for a standards audience — goals, explicit non-goals, use
cases, privacy/security considerations — marked experimental and
project-local, not filed with W3C or WICG.

**Dual-use evaluation, closed via the declaration path, not detection.**
The plan named MinerRay/MINOS/Delay-CJ as baselines to run; none have an
installable distribution (checked, not assumed — npm/PyPI lookups resolve
to unrelated same-named packages), so the finding is reported
environment-blocked, same treatment M3 Track 2 got, rather than faked.
[ADR-0002](docs/adr/0002-legitimacy-by-declaration-not-detection.md)
already predicted this outcome doesn't matter either way — a detector WASM
diversification evades in 100% of cases can't certify legitimacy regardless
— and [docs/dual-use-evaluation.md](docs/dual-use-evaluation.md)
demonstrates the actual defense: the manifest/code-binding verification
path, already built, already tested.
[ADR-0015](docs/adr/0015-dual-use-detectors-environment-blocked.md).

**Stated plainly, two things in the original M4 scope were deliberately not
done:** the demo isn't hosted (still local-only via `python -m http.server`;
`.nojekyll` and a root redirect are staged for a future GitHub Pages
deploy), and neither package is published to npm. Both are one-way,
externally-visible actions outside what this project automates on its own.
Outreach itself is handled privately by the maintainer, not tracked in this
repo.

## Documentation

Written as it would be kept alongside real engineering work, not
back-filled at the end — several of the ADRs below record a wrong first
answer and the measurement that caught it, which is the part worth keeping.

| Doc | What's in it |
| --- | --- |
| **[docs/BUILD.md](docs/BUILD.md)** | **The working spec — open this before writing code.** Carried constants, invariants that must not break, per-milestone design contracts and exit criteria |
| [docs/architecture.md](docs/architecture.md) | System overview, component diagram, trust boundaries, full session data flow |
| [docs/roadmap.md](docs/roadmap.md) | Milestone status — the source of truth the table above summarises |
| [docs/testing-strategy.md](docs/testing-strategy.md) | Coverage map, the one test that actually matters and why, what's verified manually vs. automated |
| [docs/adr/](docs/adr/README.md) | 15 Architecture Decision Records — the *why* behind every non-obvious design choice, including a corrected verification vulnerability and an unfavourable measurement reported as-is |
| [zk/README.md](zk/README.md) | M3 Track 1 toolchain: build/test instructions, toy-ceremony caveat, tooling bugs worked around |
| [docs/device-tiers.md](docs/device-tiers.md) | Full account of the placeholder→measured device-tier correction |
| [docs/dual-use-evaluation.md](docs/dual-use-evaluation.md) | M4: why the detector baselines are environment-blocked, and what stands in their place |
| [explainer/index.md](explainer/index.md) | W3C/WICG-format Compute Consent Manifest explainer |
| [CHANGELOG.md](CHANGELOG.md) | What shipped, what broke, what got corrected — by milestone |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, conventions, how to add a device measurement |
| [SECURITY.md](SECURITY.md) | Threat model, the dual-use question stated head-on, what is and isn't enforced today |
| [packages/zkpoc-ccm/SPEC.md](packages/zkpoc-ccm/SPEC.md) | Compute Consent Manifest format — the input to the explainer above |
| [packages/zkpoc-worker/API.md](packages/zkpoc-worker/API.md) | `Governor` API, worker message protocol, kernel exports |
| [packages/zkpoc-sdk/README.md](packages/zkpoc-sdk/README.md) | Publisher integration — the five-line snippet, the headless/browser split |
| [packages/zkpoc-challenge/README.md](packages/zkpoc-challenge/README.md) | Anti-bot widget — client-side solver, wire protocol |

## Layout

```text
bench/tdsc_reproduction.py     reproduce + correct the TDSC baseline
bench/breakeven.py             break-even model, sigma*(device, market)
bench/dispatch_analysis.py     separate dispatch overhead from throughput
bench/device/probe.html        in-browser F(d) probe, no build step
bench/device/sweeps/           raw multi-size sweeps
bench/device/measurements/     per-tier F(d), consumed by breakeven.py
bench/power/                   marginal watts via WMI battery discharge
bench/attacker_advantage.py    GPU/CPU throughput ratio vs. memory-hard control
packages/zkpoc-ccm/            Compute Consent Manifest — sign, verify, SPEC.md
packages/zkpoc-worker/         resource governor + sandboxed shard worker, API.md
packages/zkpoc-broker/         shard model, queue, consensus, audit, ledger, challenge
packages/zkpoc-sdk/            publisher integration — issue, verify, run a session
packages/zkpoc-challenge/      anti-bot widget — client-side challenge solver
circuits/quant_dot.circom      M3 Track 1 Groth16 circuit
contracts/ShardRowVerifier.sol generated Solidity verifier (committed, regenerable)
zk/                             isolated circom2/snarkjs/Hardhat toolchain, README.md
demo/                          live meter, revocation, tamper tests
explainer/index.md             W3C/WICG-format Compute Consent Manifest explainer
docs/adr/                      Architecture Decision Records
docs/architecture.md           system overview, trust boundaries
docs/BUILD.md                  working spec — measured constants, invariants, phase status
docs/roadmap.md                milestone status, source of truth
docs/testing-strategy.md       coverage map and testing conventions
docs/device-tiers.md           tier provenance + what measurement changed
docs/dual-use-evaluation.md    M4: detector baselines environment-blocked, the real defense
CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, LICENSE-MIT, LICENSE-APACHE
```

## Notes on rigour

Claims here are deliberately narrow. Client-side proving on consumer devices
was already measured at scale by FibRace (2.2M proofs, 1,420 device models);
selective ZK audit in federated learning was already done by zkVFL. What
remains open — and what this project claims — is in-browser proving of a *real*
workload under a *resource governor* with *energy and thermal instrumentation*,
and an audit rate derived from economics rather than anomaly detection.

## License

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache License, Version 2.0](LICENSE-APACHE),
at your option.
