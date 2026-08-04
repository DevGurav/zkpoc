# ADR-0009: Measure watts via the integrated energy counter, not instantaneous discharge rate

Status: Accepted (2026-08-03)

## Context

`bench/breakeven.py`'s break-even model weighs compute value directly against
electricity cost, so a device tier's `watts_full` (marginal power draw under
sustained load) is half the model — and it's the one input
`bench/device/probe.html` cannot obtain, since no browser API exposes power
draw.

On Windows, the ACPI battery exposes two relevant WMI fields under
`root\wmi BatteryStatus`: `DischargeRate` (an instantaneous milliwatt reading)
and `RemainingCapacity` (an integrated energy counter, in mWh). The first
measurement attempt (`bench/power/measure-windows.ps1`) sampled
`DischargeRate` at 1 Hz. This failed in a specific, informative way: firmware
refreshes the instantaneous rate only every few seconds, so 1 Hz sampling
produced long runs of duplicated values, and the resulting "median" draw was
dominated by whichever value happened to be current when the counter last
ticked — not a real average. A first real run returned a **negative**
marginal draw (idle read higher than load) purely from this artifact.

A second, independent problem compounded it: idle baseline itself drifts.
A laptop touched a minute earlier keeps winding down — background indexing
finishing, cores dropping to low P-states, panel auto-dimming on battery — and
an observed 17→34 W drift across a three-minute measurement window is larger
than the entire GPU signal being measured.

## Decision

Two changes to `bench/power/`:

1. **Use `RemainingCapacity` (mWh) deltas over each phase, not
   `DischargeRate`.** `analyse_power.py`'s `phase_power()` computes
   `Δ(mWh) / Δ(hours)` per phase — integrating over the whole phase window
   smooths exactly the sampling-cadence noise that made the instantaneous
   rate unusable. `DischargeRate`'s median is still logged and shown, but
   labelled explicitly as a cross-check, not the trustworthy column.
2. **Add a settle phase before measuring anything.** `measure-windows.ps1`'s
   Phase 0 watches two consecutive 30-second energy windows and only proceeds
   to the idle/load/idle sequence once they agree within 10%, using the same
   mWh-based method (not the noisy instantaneous rate) to judge stability.
3. **Report a bracket, not a false point estimate, when idle still drifts.**
   If the two idle phases (pre- and post-load) disagree by more than 15% even
   after settling, `analyse_power.py` computes marginal draw against *each*
   baseline separately and reports the range. Given a break-even wattage
   `W*`, a verdict (economic / uneconomic / inconclusive) is only issued when
   the entire bracket sits on one side of `W*` — an honest "inconclusive" is
   preferred to a precise-looking number that isn't trustworthy.

## Consequences

- `analyse_power.py --tier <name> --w-star <value>` only patches
  `watts_full` into a tier's measurement file when the result is confident
  (stable bracket or single-baseline drift under 15%), refusing otherwise
  rather than writing a number that would silently look as trustworthy as a
  clean measurement.
- The first real device (`laptop-igpu`, ADR-0010) measured 9.1 W marginal
  draw, well above its 5.6 W break-even threshold — decisive enough that the
  measurement's own imprecision doesn't change the verdict, which is the
  actual bar this method needs to clear (a precise wrong number would be
  worse than an honest ±1 W).
- This method is Windows/WMI-specific. `bench/power/README.md` documents
  fallbacks for other platforms (`powermetrics` on macOS, RAPL on Linux) that
  are not yet scripted.
- Alternative considered and rejected: average `DischargeRate` over a longer
  window to smooth its sampling artifact, without switching to the energy
  counter. Rejected because averaging a coarsely-updated instantaneous value
  over time is not equivalent to integrating true power — it still weights
  whichever readings happen to be sampled more densely, whereas the mWh
  counter's own update cadence is irrelevant to the correctness of a delta
  taken across it.
