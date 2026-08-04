#!/usr/bin/env python3
"""
Derive marginal watts from a power log, and patch it into a device tier.

METHOD: ENERGY COUNTER, NOT INSTANTANEOUS RATE
----------------------------------------------
The ACPI battery exposes two useful fields. `DischargeRate` is an instantaneous
milliwatt reading that firmware refreshes only every few seconds, so 1 Hz
sampling yields long runs of duplicated values and a median that is dominated
by whenever the counter happened to tick. `RemainingCapacity` is an *energy*
counter in mWh, and dividing its delta by elapsed time gives true average power
over a window -- integration smooths exactly the noise that wrecks the rate
reading.

So capacity delta is the primary metric here and discharge rate is kept only as
a cross-check.

WHY THE BASELINE MATTERS MORE THAN THE LOAD
-------------------------------------------
Marginal draw is (load - idle), and on a laptop the idle term is not stable.
A machine that was recently touched keeps winding down for minutes: background
indexing finishing, cores dropping to low P-states, the panel auto-dimming on
battery. Observed drift of 15-20 W is routine, which is larger than the entire
signal being measured.

This script therefore refuses to report a single confident number when the two
idle phases disagree. It reports a *bracket* instead -- the marginal computed
against each baseline -- because an honest range beats a precise fiction. When
the whole bracket sits above the break-even wattage the question is still
answered, even though the measurement is poor.

Run:  python bench/power/analyse_power.py [power-log.csv] [--tier laptop-igpu]
                                          [--w-star 3.9]
Deps: none (stdlib only).
"""

import argparse
import csv
import json
import os
import statistics
import sys

HERE = os.path.dirname(__file__)
DEFAULT_LOG = os.path.join(HERE, "power-log.csv")
MEAS_DIR = os.path.join(HERE, "..", "device", "measurements")


def load(path):
    phases = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            phases.setdefault(row["phase"], []).append({
                "t": float(row["elapsed_s"]),
                "mw": float(row["discharge_mw"]),
                "mwh": float(row["remaining_mwh"]),
            })
    return phases


def phase_power(samples):
    """Average power over a phase, from the energy counter.

    Returns None when the counter did not move enough to be meaningful -- a
    short phase on a firmware that updates capacity coarsely can produce a
    zero delta, and reporting 0 W would be worse than reporting nothing.
    """
    if len(samples) < 2:
        return None
    dt_h = (samples[-1]["t"] - samples[0]["t"]) / 3600.0
    d_mwh = samples[0]["mwh"] - samples[-1]["mwh"]
    if dt_h <= 0 or d_mwh <= 0:
        return None
    return {
        "avg_mw": d_mwh / dt_h,
        "delta_mwh": d_mwh,
        "seconds": samples[-1]["t"] - samples[0]["t"],
        "n": len(samples),
        "rate_median_mw": statistics.median(s["mw"] for s in samples),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log", nargs="?", default=DEFAULT_LOG)
    ap.add_argument("--tier", help="patch watts_full into this tier's measurement file")
    ap.add_argument("--w-star", type=float, default=None,
                    help="break-even wattage from bench/breakeven.py, for a verdict")
    ap.add_argument("--load-seconds", type=float, default=None,
                    help="if the probe ran for less than the whole load phase, "
                         "give its actual duration to correct for the idle remainder")
    args = ap.parse_args()

    if not os.path.exists(args.log):
        print(f"no log at {args.log}\nrun bench/power/measure-windows.ps1 first")
        return 1

    phases = load(args.log)
    missing = [p for p in ("idle_pre", "load", "idle_post") if p not in phases]
    if missing:
        print(f"log is missing phases: {', '.join(missing)}")
        return 1

    pre, load_p, post = (phase_power(phases[k])
                         for k in ("idle_pre", "load", "idle_post"))
    if not all((pre, load_p, post)):
        print("  ! the energy counter did not move enough in one or more phases.")
        print("    Use longer phases -- this firmware updates capacity coarsely.")
        return 1

    print("=" * 72)
    print("Marginal power draw  (from the mWh energy counter)")
    print("=" * 72)
    # ASCII only: the Windows console defaults to cp1252 and dies on anything else.
    print(f"  {'phase':<12} {'secs':>6} {'d_mWh':>7} {'avg W':>8} {'rate-median W':>15}")
    print("  " + "-" * 52)
    for name, s in (("idle (pre)", pre), ("load", load_p), ("idle (post)", post)):
        print(f"  {name:<12} {s['seconds']:>6.0f} {s['delta_mwh']:>7.0f} "
              f"{s['avg_mw'] / 1000:>8.2f} {s['rate_median_mw'] / 1000:>15.2f}")
    print()
    print("  'avg W' is integrated energy and is the trustworthy column.")
    print("  'rate-median W' is the instantaneous counter, shown only as a check.")

    # -- baseline stability ------------------------------------------------
    drift = abs(pre["avg_mw"] - post["avg_mw"])
    baseline = min(pre["avg_mw"], post["avg_mw"])
    drift_frac = drift / max(1.0, baseline)

    load_mw = load_p["avg_mw"]
    if args.load_seconds and args.load_seconds < load_p["seconds"]:
        # The probe covered only part of the load phase; the remainder was
        # idle and is dragging the average down. Back out the active power.
        idle_for = load_p["seconds"] - args.load_seconds
        energy_mws = load_mw * load_p["seconds"]
        load_mw = (energy_mws - baseline * idle_for) / args.load_seconds
        print()
        print(f"  Corrected for a {args.load_seconds:.0f}s probe inside a "
              f"{load_p['seconds']:.0f}s load phase:")
        print(f"    active-load power = {load_mw / 1000:.2f} W")

    m_pre = (load_mw - pre["avg_mw"]) / 1000
    m_post = (load_mw - post["avg_mw"]) / 1000
    lo, hi = sorted((m_pre, m_post))

    print()
    if drift_frac > 0.15:
        print(f"  ! BASELINE DRIFTED {drift / 1000:.1f} W between the idle phases "
              f"({drift_frac * 100:.0f}%).")
        print("    The machine was still settling, so no single marginal figure")
        print("    is defensible. Bracketing against both baselines instead:")
        print()
        print(f"      vs idle-pre  ({pre['avg_mw'] / 1000:5.1f} W) : {m_pre:+6.2f} W")
        print(f"      vs idle-post ({post['avg_mw'] / 1000:5.1f} W) : {m_post:+6.2f} W")
        print(f"      marginal is somewhere in [{lo:+.2f}, {hi:+.2f}] W")
        confident = False
    else:
        marginal = (load_mw - statistics.fmean([pre["avg_mw"], post["avg_mw"]])) / 1000
        lo = hi = marginal
        print(f"  Baseline stable (drift {drift_frac * 100:.0f}%).")
        print(f"  MARGINAL = {marginal:.2f} W")
        confident = marginal > 0

    # -- verdict against the break-even wattage ----------------------------
    if args.w_star is not None:
        print()
        print(f"  Break-even wattage W* = {args.w_star:.1f} W")
        if lo > args.w_star:
            print(f"  VERDICT: marginal draw exceeds W* across the entire bracket.")
            print("  The tier is uneconomic at every share, and that holds even")
            print("  though the measurement itself is poor -- the question was")
            print("  never about the exact watts, only which side of W* they sit.")
        elif hi < args.w_star:
            print("  VERDICT: marginal draw is below W* across the entire bracket.")
            print("  The compute pays for its own electricity.")
        else:
            print("  VERDICT: INCONCLUSIVE -- the bracket straddles W*. A cleaner")
            print("  baseline is needed before this tier can be decided.")

    if not confident:
        print()
        print("  To get a clean run: leave the machine completely alone for two")
        print("  or three minutes first so the baseline settles, close every")
        print("  other application, and make the probe's sustained duration")
        print("  exactly match -LoadSeconds.")
        if args.tier:
            print(f"  Not patching {args.tier}.json -- the number is not trustworthy.")
        return 1

    watts = round(lo, 2)
    if args.tier:
        path = os.path.abspath(os.path.join(MEAS_DIR, f"{args.tier}.json"))
        if not os.path.exists(path):
            print(f"\n  no measurement file at {path}")
            return 1
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
        payload["watts_full"] = watts
        payload["watts_note"] = (
            f"measured via bench/power: load {load_mw:.0f} mW - "
            f"idle {baseline:.0f} mW, energy-counter method")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
        print(f"\n  patched watts_full = {watts} into {args.tier}.json")

    return 0


if __name__ == "__main__":
    sys.exit(main())
