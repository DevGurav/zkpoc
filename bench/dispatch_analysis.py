#!/usr/bin/env python3
"""
Decompose a device sweep into dispatch overhead and marginal throughput,
and derive the shard size the broker should actually use.

WHY THIS EXISTS
---------------
A single GFLOPS number from one matrix size is not F(d). Every WebGPU dispatch
pays a fixed round-trip cost -- command encoding, submission, and the
`onSubmittedWorkDone()` fence -- that is independent of how much arithmetic the
dispatch contains. Measure a small shard and you measure that fence, not the
device.

Modelling one dispatch as

    t(N) = overhead + 2N^3 / throughput

and fitting across matrix sizes separates the two. The overhead term is the
number M2 needs: shards must be large enough that it amortises, or the system
sells latency instead of compute.

A SECOND CORRECTION: SUSTAINED vs PEAK
--------------------------------------
Sample arrays from the probe decay monotonically within every run. Integrated
GPUs share a package power budget with the CPU, so turbo is spent first and
the clock then settles. The median lands mid-decay and is therefore the wrong
statistic for an economic model concerned with minutes-long sessions -- the
last sample is closer to the truth, and even it is optimistic when the run is
short.

Run:  python bench/dispatch_analysis.py [sweep.json ...]
Deps: none (stdlib only). Writes a tier file to bench/device/measurements/.
"""

import glob
import json
import os
import sys

SWEEP_DIR = os.path.join(os.path.dirname(__file__), "device", "sweeps")
MEAS_DIR = os.path.join(os.path.dirname(__file__), "device", "measurements")


def fit_overhead_throughput(points, path="gpu"):
    """Least-squares fit of t = overhead + flops/throughput across sizes.

    Uses the *median* of each point for the fit, because overhead is a property
    of the dispatch path rather than of thermal state, and the median is the
    most stable estimator of it available here.

    Returns (overhead_s, throughput_flops_per_s).
    """
    xs, ys = [], []
    for p in points:
        entry = p.get(path)
        if not entry or entry.get("median_ms") is None:
            continue
        xs.append(p["gflop_per_rep"] * 1e9)      # FLOPs
        ys.append(entry["median_ms"] / 1000.0)   # seconds

    n = len(xs)
    if n < 2:
        raise ValueError(f"need >=2 sizes to separate overhead from throughput, got {n}")

    # Ordinary least squares on y = a + b*x, where b = 1/throughput.
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    a = my - b * mx
    if b <= 0:
        raise ValueError("non-positive slope; sweep is inconsistent")
    return a, 1.0 / b


def rates(entry, flops):
    """Peak / median / sustained GFLOPS for one measured point."""
    s = entry["samples_ms"]
    return {
        "peak": flops / (min(s) / 1000) / 1e9,
        "median": flops / (entry["median_ms"] / 1000) / 1e9,
        "sustained": flops / (max(s) / 1000) / 1e9,
        "decay": max(s) / min(s),
    }


def recommend_shard_n(overhead_s, throughput, max_overhead_frac=0.10,
                      target_wall_s=None):
    """Smallest N whose compute time makes overhead <= max_overhead_frac.

    overhead / (overhead + compute) <= f   =>   compute >= overhead * (1-f)/f
    and compute = 2N^3 / throughput.

    If target_wall_s is given, also report the N that fills that wall-clock,
    which is the other constraint on shard sizing (a challenge wants ~1-3 s).
    """
    min_compute = overhead_s * (1 - max_overhead_frac) / max_overhead_frac
    n_amortise = (min_compute * throughput / 2) ** (1 / 3)
    out = {"n_for_overhead_target": n_amortise, "max_overhead_frac": max_overhead_frac}
    if target_wall_s:
        compute = max(0.0, target_wall_s - overhead_s)
        out["n_for_target_wall"] = (compute * throughput / 2) ** (1 / 3)
        out["target_wall_s"] = target_wall_s
    return out


EXPECTED_SCHEMA = "zkpoc.device-sweep/1"


def analyse(path):
    with open(path, encoding="utf-8") as fh:
        sweep = json.load(fh)

    schema = sweep.get("schema")
    if schema != EXPECTED_SCHEMA:
        # e.g. zkpoc.device-sweep-sustained/1 from a single-size sustained run
        # (bench/power/ workflow) -- a different artifact this script does not
        # consume. Skip rather than crash; sweeps/ deliberately holds more than
        # one kind of file.
        print(f"skipping {os.path.basename(path)}: schema '{schema}' is not "
              f"'{EXPECTED_SCHEMA}' (multi-size overhead/throughput sweep)")
        return

    tier = sweep.get("tier") or os.path.splitext(os.path.basename(path))[0]
    pts = sorted(sweep["points"], key=lambda p: p["matrix_n"])
    dev = sweep.get("device", {})
    ad = dev.get("adapter", {})

    print("=" * 76)
    print(f"{tier}  --  {ad.get('vendor', '?')} / {ad.get('architecture', '?')}"
          f"   {dev.get('cores', '?')} cores, {dev.get('memory_gb', '?')} GB")
    print("=" * 76)

    # ---- raw curve
    print()
    print("  Measured, per matrix size")
    print(f"  {'N':>5} {'GFLOP/rep':>10} {'med ms':>8} "
          f"{'peak':>8} {'median':>8} {'sustained':>10} {'decay':>7}")
    print("  " + "-" * 62)
    for p in pts:
        f = p["gflop_per_rep"] * 1e9
        r = rates(p["gpu"], f)
        print(f"  {p['matrix_n']:>5} {p['gflop_per_rep']:>10.3f} "
              f"{p['gpu']['median_ms']:>8.1f} {r['peak']:>8.1f} {r['median']:>8.1f} "
              f"{r['sustained']:>10.1f} {r['decay']:>6.2f}x")
    print("  (GFLOPS. 'decay' is slowest sample / fastest within the run.)")

    # ---- decomposition
    overhead, thr = fit_overhead_throughput(pts, "gpu")
    print()
    print("  Decomposition   t(N) = overhead + 2N^3 / throughput")
    print(f"    fixed dispatch overhead : {overhead * 1000:8.2f} ms")
    print(f"    marginal throughput     : {thr / 1e9:8.1f} GFLOPS")
    print()
    print(f"  {'N':>5} {'measured':>10} {'compute':>10} {'overhead':>10} {'overhead %':>11}")
    print("  " + "-" * 50)
    for p in pts:
        meas = p["gpu"]["median_ms"]
        comp = p["gflop_per_rep"] * 1e9 / thr * 1000
        print(f"  {p['matrix_n']:>5} {meas:>9.1f}m {comp:>9.2f}m "
              f"{meas - comp:>9.2f}m {(meas - comp) / meas * 100:>10.1f}%")

    # ---- shard sizing, the M2 input
    rec = recommend_shard_n(overhead, thr, 0.10, target_wall_s=2.0)
    print()
    print("  Shard sizing")
    print(f"    N >= {rec['n_for_overhead_target']:.0f} keeps dispatch overhead under "
          f"{rec['max_overhead_frac'] * 100:.0f}%")
    print(f"    N  = {rec['n_for_target_wall']:.0f} fills a "
          f"{rec['target_wall_s']:.0f}s challenge in one dispatch")
    print("    Below the first figure the system is selling latency, not compute.")

    # ---- the number that goes into the economic model
    biggest = pts[-1]
    r = rates(biggest["gpu"], biggest["gflop_per_rep"] * 1e9)
    print()
    print(f"  F(d) for bench/breakeven.py: {r['sustained']:.1f} GFLOPS")
    print(f"    sustained rate at N={biggest['matrix_n']}, not peak and not median.")
    print("    Sessions run for minutes; bursts do not. This is still an UPPER")
    print("    bound -- the sweep is far too short to reach thermal steady state.")

    cpu = [p for p in pts if p.get("cpu")]
    if cpu:
        best_cpu = max(p["gflop_per_rep"] * 1e9 / (p["cpu"]["median_ms"] / 1000) / 1e9
                       for p in cpu)
        print(f"  CPU path (JS, not WASM SIMD): {best_cpu:.2f} GFLOPS best case")

    # ---- emit the tier file, merging rather than clobbering
    #
    # This script's own numbers (dispatch_overhead_ms, marginal_throughput_gflops)
    # come from a short multi-size sweep and are always safe to write -- they
    # measure a fixed per-dispatch cost, which is not thermally sensitive the
    # way sustained throughput is. results.gpu.gflops is a different story: a
    # short quick-sweep "sustained" figure (this script's own estimate) is
    # STRICTLY WORSE than a real sustained run from bench/power's workflow, and
    # overwriting a good measurement with a worse one on every re-run is a
    # regression a human would not choose. Rank statistics and never downgrade.
    STAT_RANK = {
        "median": 0,
        "sustained (slowest sample at largest N)": 1,
        "sustained-steady": 2,           # legacy label from an earlier probe.html
        "sustained-steady-ols": 3,
    }

    def rank(stat):
        if not stat:
            return -1
        for prefix, r in sorted(STAT_RANK.items(), key=lambda kv: -len(kv[0])):
            if stat.startswith(prefix):
                return r
        return -1

    os.makedirs(MEAS_DIR, exist_ok=True)
    out_path = os.path.join(MEAS_DIR, f"{tier}.json")

    existing = None
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as fh:
                existing = json.load(fh)
        except (OSError, json.JSONDecodeError):
            existing = None

    new_gpu = {
        "path": "webgpu-wgsl",
        "gflops": round(r["sustained"], 3),
        "median_ms": biggest["gpu"]["median_ms"],
        "correct": biggest["gpu"].get("correct", True),
        "statistic": "sustained (slowest sample at largest N)",
    }
    existing_gpu = (existing or {}).get("results", {}).get("gpu")
    keep_existing_gpu = existing_gpu and rank(existing_gpu.get("statistic")) > rank(new_gpu["statistic"])

    payload = {
        "schema": "zkpoc.device-probe/1",
        "captured_at": (existing or {}).get("captured_at") if keep_existing_gpu
                       else sweep.get("captured_at"),
        "derived_from": (existing or {}).get("derived_from") if keep_existing_gpu
                        else os.path.relpath(path, os.path.dirname(__file__)),
        "device": dev,
        "watts_full": (existing or {}).get("watts_full", sweep.get("watts_full")),
        "watts_note": (existing or {}).get("watts_note", sweep.get("watts_note")),
        "analysis": {
            **((existing or {}).get("analysis") or {}),
            "dispatch_overhead_ms": round(overhead * 1000, 3),
            "marginal_throughput_gflops": round(thr / 1e9, 2),
            "min_shard_n_for_10pct_overhead": round(rec["n_for_overhead_target"]),
        },
        "config": (existing or {}).get("config") if keep_existing_gpu
                  else {"matrix_n": biggest["matrix_n"], "duty_cycle": 1.0, "reps": 7},
        "results": {"gpu": existing_gpu if keep_existing_gpu else new_gpu},
    }
    if payload["watts_full"] is None:
        payload.pop("watts_full")          # let the loader keep its placeholder

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)

    print()
    print(f"  wrote {os.path.relpath(out_path, os.path.dirname(__file__))}")
    if keep_existing_gpu:
        print(f"  kept existing results.gpu.gflops = {existing_gpu['gflops']} "
              f"(statistic '{existing_gpu.get('statistic')}' outranks this "
              f"script's quick-sweep estimate) -- only the shard-sizing")
        print("    'analysis' block was refreshed.")
    if payload.get("watts_full") is None:
        print("  ! watts_full still unmeasured -- the tier keeps its placeholder")
        print("    wattage and stays flagged. Energy cost is half the break-even")
        print("    model, so this is the single biggest remaining gap.")


def main():
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(SWEEP_DIR, "*.json")))
    if not paths:
        print(f"no sweeps found in {SWEEP_DIR}")
        return 1
    for p in paths:
        analyse(p)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
