# Contributing

> **Before writing code, read [docs/BUILD.md](docs/BUILD.md).** It carries the
> measured constants later work depends on and the invariants that must not
> break. Most mistakes on this project have come from re-deriving a number
> that was already measured, or from quietly violating something §2 lists.

## Setup

Node ≥18, Python ≥3.10 (stdlib only — no `requirements.txt`, deliberately).
No install step: the JS packages have **zero runtime dependencies**, and
`bench/*.py` use only the standard library. This is a deliberate constraint,
not an oversight — a break-even model and a manifest verifier that need a
`node_modules` tree to audit are harder to trust than ones you can read start
to finish. If a real dependency becomes unavoidable (e.g. a WASM SIMD build
toolchain for the CPU kernel — see
[ADR-0003](docs/adr/0003-webgpu-mandatory.md)), that's fine, but it should be
a deliberate decision with an ADR, not an accretion.

**`zk/` is the one exception, by design.** M3 Track 1's Groth16 pipeline
(circom2, snarkjs, Hardhat + toolbox) is a genuinely heavy dependency tree
with no way to avoid one. Rather than accrete it into the root or a
`packages/*` workspace, it lives in its own `zk/package.json`, outside the
root npm workspaces — the top-level `npm install` above stays fast and
dependency-free. Opt in explicitly if you're touching the ZK layer:

```sh
cd zk && npm install && npm run build && npm test
```

See [zk/README.md](zk/README.md) and
[ADR-0014](docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md) for why.

```sh
git clone <repo>
cd zk-poc
npm test                       # all package tests, 213 total
python bench/tdsc_reproduction.py
python bench/breakeven.py
```

## Running things

| Task | Command |
| --- | --- |
| All tests | `npm test` |
| One package's tests | `npm test --prefix packages/zkpoc-ccm` |
| Both economic-model scripts | `npm run bench` |
| Live demo (meter, tamper panel, revocation) | `npm run serve`, then open `localhost:8000/demo/` |
| Device throughput probe | `npm run serve`, open `localhost:8000/bench/device/probe.html` |
| Dispatch-overhead analysis | `python bench/dispatch_analysis.py` |
| Power measurement (Windows) | see [bench/power/README.md](bench/power/README.md) |

The demo and probe **must** be served over HTTP, not opened as `file://` —
module workers and ES imports don't load from the filesystem scheme.

## Code conventions

- **No comments explaining *what* the code does.** Identifiers should make
  that obvious. A comment earns its place only by explaining a non-obvious
  *why* — a constraint, a rejected alternative, a bug it works around. Every
  file in this repo currently follows this; new code should too. If you find
  yourself writing "// increment counter", delete it.
- **Extract control logic as pure functions when it needs to be tested
  without a browser.** See `nextIdleMs()` in `governor.js` — the share
  control law is pulled out of the event-loop-and-timers code around it
  specifically so `share-control.test.js` can simulate hundreds of session
  cycles in milliseconds. If you're adding logic that's hard to test because
  it's tangled with `performance.now()`, a real `Worker`, or DOM APIs, that's
  usually a sign to extract first.
- **Assert your own numeric claims in `bench/` scripts.** Anything that
  reproduces or corrects a figure from an external source (a paper, an
  earlier measurement) should `assert` the reconstruction against known
  values, not just `print` and rely on eyeballing — see
  `tdsc_reproduction.py`. A script that silently drifts from the source it's
  meant to reproduce is worse than useless.
- **Prefer readable formulas over premature abstraction.** `bench/*.py` stay
  as flat, readable modules with dataclasses and functions rather than
  class hierarchies — the audience is someone checking the arithmetic, not
  someone extending a framework.

## Testing

Full policy in [docs/testing-strategy.md](docs/testing-strategy.md). Short
version:

- One `test()` per behaviour, named as a sentence stating what must be true.
- When testing a rejection, assert **which** check failed, not just that
  something failed — `assert.deepEqual(failedChecks, ['code.worker'])`, not
  `assert.equal(result.ok, false)`.
- If you're testing "this matches what's on disk" (e.g. a code-hash binding),
  read the real file with `readFile`, don't hardcode a fixture string that
  can drift out of sync with the thing it's supposed to represent.

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every
push/PR to `main`: the JS suite with zero install (matching the setup
section above — if CI needed `npm install` to pass, that would itself be a
bug), the `bench/` economic scripts, and `zk/`'s isolated toolchain
separately, since it's the one subtree that does need its own install.

## Architecture Decision Records

If you make a decision that would be expensive for someone else to
re-derive — a rejected alternative, a measurement that overturned an earlier
assumption, a constraint that shaped the design — write an ADR. See
[docs/adr/README.md](docs/adr/README.md) for the template and the numbering
convention. Two of the existing ADRs (0008, 0010) record a wrong first answer
being corrected by measurement; that trail is exactly what's worth keeping,
so don't feel obliged to only record decisions that turned out right the
first time.

## Adding a device measurement

The break-even model in `bench/breakeven.py` ships with six device tiers, of
which one (`laptop-igpu`) is fully measured and five are literature-anchored
placeholders — flagged with `*`/`w` markers on every run. Adding a real
measurement for another tier:

1. Open `bench/device/probe.html` (served over HTTP) on the target device.
   Use **sustained mode** (60–300s), not quick/reps mode — see
   [ADR-0010](docs/adr/0010-sustained-trend-fit-not-quick-sweep.md) for why a
   short sweep produces a warmup-contaminated, unreliable number. Confirm the
   result reports `trend: "plateaued"` before trusting it; if it says
   `"rising"` or `"falling"`, run longer.
2. Save the exported JSON to `bench/device/sweeps/`, named for the device.
3. For watts: on Windows, follow
   [bench/power/README.md](bench/power/README.md) — it requires the
   sustained probe run and the power script to run concurrently, matched in
   duration.
4. Write or update `bench/device/measurements/<tier-name>.json` with the
   measured `results.gpu.gflops` and `watts_full`. `bench/breakeven.py` picks
   it up automatically and drops the placeholder flags for that tier.
5. If the number materially changes a conclusion (as `laptop-igpu`'s
   correction did — see [CHANGELOG.md](CHANGELOG.md)), update
   `docs/device-tiers.md` and `README.md`'s headline numbers, not just the
   JSON file. A corrected measurement that only lives in a data file the
   reader never sees isn't actually a correction.

## Commit and PR conventions

This repo doesn't have a house style beyond: explain the *why* in the commit
message or PR description, not just the *what* (the diff already shows the
what). If a change is driven by a measurement or a bug found during testing,
say what the measurement showed or what the bug's symptom was — that context
is exactly what an ADR or changelog entry needs later, and it's cheapest to
capture at commit time.
