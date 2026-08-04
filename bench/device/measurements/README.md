# Device measurements

Drop `bench/device/probe.html` output here, named after the tier it
represents — `laptop-dgpu.json`, `mobile-gpu.json`, etc. Names must match the
tier names in `DEFAULT_TIERS` in `bench/breakeven.py` to override them.

The probe cannot measure power draw; browsers expose none. Add a `watts_full`
key by hand from host-side instrumentation (RAPL, Intel Power Gadget,
`powermetrics`) or the tier keeps its placeholder wattage.

This directory is intentionally empty of measurements. Every number in the
break-even surface is a literature-anchored placeholder until real probe data
lands here, and the solver says so on every run.
