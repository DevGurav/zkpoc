# Measuring `watts_full`

`watts_full` is the marginal power draw a workload adds at 100% device share.
It is half of the break-even model — compute value is weighed directly against
electricity cost — and it is the one input `bench/device/probe.html` cannot
obtain, because **no browser exposes power draw at all**. Battery Status gives
a coarse charge percentage and nothing else.

Windows does expose it. While running on battery, the ACPI battery reports both
an instantaneous discharge rate *and* a `RemainingCapacity` energy counter in
mWh through WMI (`root\wmi` `BatteryStatus`). Both are logged; the analysis
uses the energy counter, because firmware refreshes the rate only every few
seconds, and 1 Hz sampling of it produces long runs of duplicated values.

## Workflow

Unplug the charger and close everything else — this measures the whole machine,
so anything that wakes up lands in the result.

```powershell
powershell -ExecutionPolicy Bypass -File bench\power\measure-windows.ps1 -LoadSeconds 120
```

It runs four phases and tells you when to act:

0. **settle** (up to 150 s) — leave the machine alone; it waits for the idle
   baseline to stop moving before measuring anything
1. **idle** (30 s) — don't touch the machine
2. **load** (120 s) — start a *sustained* run in `bench/device/probe.html`,
   set to the **same duration** as `-LoadSeconds`
3. **idle** (30 s) — stop the probe

Then:

```sh
python bench/power/analyse_power.py --tier laptop-igpu --w-star 3.9
```

`--w-star` is the break-even wattage `bench/breakeven.py` reports for that
tier — passing it gets a verdict (economic / uneconomic / inconclusive)
instead of a bare number. That computes marginal draw, patches `watts_full`
into `bench/device/measurements/<tier>.json`, and `bench/breakeven.py` drops
the `w` placeholder flag on its next run.

## Why the settle phase exists

It is the failure mode that actually bites, not a theoretical one. A laptop
touched a minute ago keeps winding down: background indexing finishing, cores
dropping to low P-states, the panel auto-dimming on battery. Drift of 15–20 W
across three minutes is routine, and the GPU signal being measured is smaller
than that — without settling, the result is dominated by the decay and can
even come out negative. `-SettleSeconds` compares two consecutive 30 s energy
windows and proceeds once they agree within 10%; measuring stability from the
same coarse counter used for the phases, rather than the noisier instantaneous
rate.

## Why idle is measured twice

Even after settling, idle is measured either side of the load so drift stays
*visible*. If the two idle phases still disagree by more than 15%, the
analysis does not report a single confident number — it reports a **bracket**
(marginal computed against each baseline) and, if `--w-star` is given, a
verdict only when the whole bracket sits on one side of it. An honest range
beats a precise fiction.

## What the number means

It is the marginal draw of the **whole machine**, so it includes the CPU-side
cost of feeding the GPU, memory traffic, and any fan response. That is
deliberate and it is the right quantity for the model: the user pays for what
the machine draws, not for what the GPU die alone consumed.

It is *not* total system power. Subtracting the idle baseline removes the
screen, the OS and everything unrelated — charging the compute for those would
make every device look uneconomic for reasons that have nothing to do with the
workload.

## If this does not work on your machine

The script exits with a clear reason rather than guessing. Known cases:

- **Plugged in** — `DischargeRate` reads 0 while charging. Unplug.
- **Desktop or VM** — no battery, so no counter. Use an external wall meter;
  a plug-in energy monitor is accurate enough at these magnitudes.
- **Firmware does not populate `DischargeRate`** — some OEMs leave it at 0.
  Fall back to HWiNFO64 (CSV logging) or a wall meter, and set `watts_full`
  by hand in the tier file.

On macOS, `sudo powermetrics --samplers cpu_power,gpu_power` reports package
power directly and is more precise than the battery route; on Linux, RAPL via
`/sys/class/powercap/intel-rapl/` gives the same. Neither has a script here yet.
