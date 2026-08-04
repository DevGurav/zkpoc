# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries are grouped by milestone rather than semver — this project has no
tagged releases yet. See [docs/roadmap.md](docs/roadmap.md) for the fuller
account of what each milestone delivered and why; this file is the terse,
chronological version.

## [Unreleased]

Nothing landed yet. M2 (broker, tiered verification, useful-PoW challenge
protocol) is next.

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
