#!/usr/bin/env python3
"""
Attacker-advantage-ratio measurement: does a GEMM-based useful-PoW challenge
give a GPU-farm attacker MORE relative advantage over an honest device than
the memory-hard puzzles it's meant to improve on?

This is M2's exit criterion 3 (docs/BUILD.md), and it exists to answer the
"primary risk" the M2 design contract named before any of this was built:

    "ML shard work is highly GPU-accelerable, so an attacker with a GPU farm
     may enjoy a LARGER advantage over an honest mobile user than a
     memory-hard hash puzzle would give them. If [this] shows the ratio is
     worse than the memory-hard control, that is a finding to report, not a
     number to bury."

THE METRIC
----------
For a FLOPS-bound kernel sized to a fixed target wall-clock time (see
tiers.py#chooseShardSize / packages/zkpoc-broker/src/tiers.js), the shard's
size is fixed once issued. An attacker with higher throughput solves the
SAME shard in less time:

    advantage_ratio = honest_solve_time / attacker_solve_time
                     = attacker_gflops / honest_gflops

For a FLOPS-bound kernel this collapses to exactly the hardware throughput
ratio -- no cleverness needed on the attacker's part, which is precisely
what "highly GPU-accelerable" means and why this metric is the right one to
compute.

THREE DATA SOURCES, EACH LABELLED BY PROVENANCE
-------------------------------------------------
1. OUR OWN MEASURED KERNEL. GPU 107.2 GFLOPS / CPU 0.59 GFLOPS, same device
   (Intel Gen-12LP / Iris Xe), same GEMM kernel, from
   bench/dispatch_analysis.py -- see docs/BUILD.md §1. This is the real
   number for the actual thing this project built, not an estimate.

2. MEMORY-HARD CONTROL (Argon2), from published sources:
   - Specops Software (an Outpost24 company), July 2026: an 8x Nvidia RTX
     5090 GPU rig achieved 490 H/s against Argon2id; a single ~$2,100 AMD
     EPYC server CPU achieved 730 H/s -- the GPU rig was SLOWER than the
     single CPU. Ratio ~= 490/730 ~= 0.67x.
   - Historical PHC-era benchmark (~2015-16, discussed by Argon2 co-designer
     Dmitry Khovratovich): a Titan X GPU achieved ~4.2-4.38x a comparison
     baseline when memory bandwidth was the limiting factor.
   These two sources disagree in direction (one shows GPUs slower than a
   single CPU, one shows a modest GPU edge) across a decade of hardware
   generations -- which is itself informative: unlike a compute-bound
   kernel, the ratio for a memory-hard function stays in the single digits
   REGARDLESS of which generation of GPU you point at it. That stability is
   the entire design goal of memory-hardness, and it is what this project's
   own measured 182x ratio is being compared against.

3. REAL-WORLD PRECEDENT (Anubis, SHA-256, NOT memory-hard): Tavis Ormandy
   found that a free-tier Google Compute Engine VM running a native-code
   (not JS) solver could generate valid tokens for all ~11,508
   Anubis-protected sites in ~6 minutes, at an estimated cost of under one
   cent per month. This used NO GPU at all -- the asymmetry was pure
   native-code-vs-browser-JS implementation efficiency, on top of SHA-256
   already being compute-bound. It is the concrete, already-observed
   real-world failure mode this project's flagship (ADR-0001) is positioned
   as a replacement for, which makes it the right baseline to ask "at least
   this well-defended," not merely "better than nothing."

WHAT THIS SCRIPT DOES NOT DO
------------------------------
It does not benchmark Argon2 itself -- that would require implementing and
tuning a real memory-hard KDF, which is out of scope for a measurement
script and would not change the conclusion below (see the Result section for
why the margin is wide enough not to hinge on Argon2 parameter tuning). It
also does not have a MEASURED honest-mobile-device figure -- only
laptop-igpu is measured project-wide (docs/device-tiers.md); mobile tiers
remain literature-anchored placeholders and are reported as such, exactly
like bench/breakeven.py flags them.

Run:  python bench/attacker_advantage.py
Deps: none (stdlib only).
"""

# --------------------------------------------------------------------------
# 1. Our own measured kernel (real data)
# --------------------------------------------------------------------------

MEASURED_GPU_GFLOPS = 107.2   # docs/BUILD.md §1, sustained OLS figure
MEASURED_CPU_GFLOPS = 0.59    # bench/dispatch_analysis.py, "CPU path ... best case"
MEASURED_DEVICE = "Intel Gen-12LP / Iris Xe (the one fully-measured project tier)"

# --------------------------------------------------------------------------
# 2. Memory-hard control: Argon2id, from published sources (see docstring)
# --------------------------------------------------------------------------

ARGON2_GPU_CPU_RATIO_LOW = 490 / 730   # Specops Software, Jul 2026: 8x RTX5090 vs 1 EPYC CPU
ARGON2_GPU_CPU_RATIO_HIGH = 4.38       # PHC-era Titan X benchmark, ~2015-16

# --------------------------------------------------------------------------
# 3. Cost model -- reuses bench/breakeven.py's own constants rather than
#    introducing a second, disconnected pricing assumption.
# --------------------------------------------------------------------------

PI_MARKET_USD_PER_GFLOPS_HR = 1.0e-5   # bench/breakeven.py -- consumer-GPU cloud spot
ANUBIS_SITES_BYPASSED = 11_508
ANUBIS_BYPASS_MINUTES = 6
ANUBIS_MONTHLY_COST_USD = 0.01         # Ormandy's own estimate, "under a cent"

# --------------------------------------------------------------------------
# Literature-anchored placeholder tiers, for context only -- NOT measured.
# Mirrors bench/breakeven.py's DEFAULT_TIERS naming so the two stay legible
# against each other; flagged with the same convention used there.
# --------------------------------------------------------------------------

PLACEHOLDER_TIERS = {
    "mobile-gpu": 300.0,     # bench/breakeven.py DEFAULT_TIERS, unmeasured
    "mobile-cpu": 15.0,      # bench/breakeven.py DEFAULT_TIERS, unmeasured
    "desktop-dgpu": 5000.0,  # bench/breakeven.py DEFAULT_TIERS, unmeasured
}


def solve_time_s(flops: float, gflops: float) -> float:
    return flops / (gflops * 1e9)


def advantage_ratio(attacker_gflops: float, honest_gflops: float) -> float:
    """attacker throughput / honest throughput, for a FLOPS-bound kernel this
    IS the solve-time speedup -- see the module docstring's derivation."""
    return attacker_gflops / honest_gflops


def report_measured_ratio() -> float:
    print("=" * 78)
    print("PART 1 -- Our own measured kernel: GPU/CPU throughput ratio")
    print("=" * 78)
    print(f"  Device: {MEASURED_DEVICE}")
    print(f"  GPU (WebGPU, sustained) : {MEASURED_GPU_GFLOPS:8.2f} GFLOPS  [measured]")
    print(f"  CPU (JS reference)      : {MEASURED_CPU_GFLOPS:8.2f} GFLOPS  [measured]")
    ratio = advantage_ratio(MEASURED_GPU_GFLOPS, MEASURED_CPU_GFLOPS)
    print(f"  Ratio (GPU/CPU)         : {ratio:8.1f}x")
    print()
    print("  For a FLOPS-bound kernel sized to a fixed wall-clock budget, this")
    print("  ratio IS the attacker's solve-time speedup: an attacker running the")
    print("  same shard on the GPU path solves it ~{:.0f}x faster than an honest".format(ratio))
    print("  device limited to the CPU path.")
    return ratio


def report_memory_hard_control() -> tuple[float, float]:
    print()
    print("=" * 78)
    print("PART 2 -- Memory-hard control: Argon2id GPU/CPU ratio, from literature")
    print("=" * 78)
    print("  Specops Software (Jul 2026): 8x RTX 5090 rig vs 1x AMD EPYC CPU")
    print(f"    490 H/s (GPU rig)  /  730 H/s (single CPU)  =  "
          f"{ARGON2_GPU_CPU_RATIO_LOW:.2f}x  (GPU SLOWER than one CPU)")
    print("  PHC-era benchmark (~2015-16), Titan X, discussed by Argon2 co-designer")
    print(f"  Dmitry Khovratovich: ~{ARGON2_GPU_CPU_RATIO_HIGH:.2f}x (memory-bandwidth-limited)")
    print()
    lo, hi = sorted([ARGON2_GPU_CPU_RATIO_LOW, ARGON2_GPU_CPU_RATIO_HIGH])
    print(f"  Range across a decade of GPU generations: {lo:.2f}x - {hi:.2f}x")
    print("  Two sources, a decade apart, disagreeing even on DIRECTION (one shows")
    print("  GPUs slower than a single server CPU) is itself the point: memory-hard")
    print("  functions keep this ratio in the single digits regardless of which")
    print("  hardware generation you throw at them. That stability is the entire")
    print("  design goal, and it's what our kernel is about to be measured against.")
    return lo, hi


def report_anubis_precedent() -> None:
    print()
    print("=" * 78)
    print("PART 3 -- Real-world precedent: Anubis (SHA-256, not memory-hard)")
    print("=" * 78)
    print(f"  Tavis Ormandy: a free-tier GCE VM running a native-code solver")
    print(f"  generated valid tokens for all {ANUBIS_SITES_BYPASSED:,} Anubis-protected")
    print(f"  sites in ~{ANUBIS_BYPASS_MINUTES} minutes, at an estimated cost under "
          f"${ANUBIS_MONTHLY_COST_USD:.2f}/month.")
    print()
    print("  No GPU was involved -- the asymmetry was pure native-code-vs-browser-JS")
    print("  implementation efficiency, stacked on top of SHA-256 already being")
    print("  compute-bound. This is the ALREADY-DEPLOYED, ALREADY-BROKEN baseline")
    print("  ADR-0001 positions this project's flagship as a replacement for -- the")
    print("  bar to clear is 'at least this well-defended,' not 'perfect.'")


def report_comparison(measured_ratio: float, mh_lo: float, mh_hi: float) -> None:
    print()
    print("=" * 78)
    print("PART 4 -- The comparison M2's exit criterion 3 exists to make")
    print("=" * 78)
    print(f"  {'':<38}{'ratio':>12}")
    print("  " + "-" * 50)
    print(f"  {'Our GEMM kernel (measured)':<38}{measured_ratio:>11.1f}x")
    print(f"  {'Argon2id memory-hard control (lit.)':<38}{mh_lo:.2f}x - {mh_hi:.2f}x")
    print()
    factor_lo = measured_ratio / mh_hi
    factor_hi = measured_ratio / mh_lo
    print(f"  Our kernel's GPU/CPU advantage is {factor_lo:.0f}x-{factor_hi:.0f}x LARGER than")
    print("  the memory-hard control's, across the full cited literature range.")
    print()
    print("  FINDING (per BUILD.md: report this, don't bury it)")
    print("  ----------------------------------------------------------------")
    print("  The primary risk named before this measurement was taken has")
    print("  materialised. A GEMM-based useful-PoW challenge, as currently")
    print("  specified, gives a GPU-equipped attacker a substantially LARGER")
    print("  relative advantage over an honest CPU-bound device than a")
    print("  memory-hard puzzle would. This does not mean the challenge is")
    print("  worse than Anubis's SHA-256 baseline in absolute terms -- it is")
    print("  still bound to real, freshly-issued buyer work (Part 3's native-")
    print("  code shortcut has no equivalent here, since there is no cheaper-")
    print("  than-honest way to satisfy ADR-0011's commit-then-challenge gate)")
    print("  -- but on the SPECIFIC axis this metric measures, it is a step")
    print("  backward from the memory-hard designs it is meant to improve on.")


def report_cost_context() -> None:
    print()
    print("=" * 78)
    print("PART 5 -- Cost context (secondary to the ratio, included for scale)")
    print("=" * 78)
    print("  Renting the GPU side of that 182x advantage costs, at bench/breakeven.py's")
    print(f"  own spot-price reference (${PI_MARKET_USD_PER_GFLOPS_HR:.0e}/GFLOPS-hour):")
    for name, gflops in sorted(PLACEHOLDER_TIERS.items(), key=lambda kv: kv[1]):
        cost_hr = gflops * PI_MARKET_USD_PER_GFLOPS_HR
        print(f"    {name:<14} {gflops:>8.0f} GFLOPS (placeholder, unmeasured) "
              f"-> ${cost_hr:.5f}/hr to rent equivalent throughput")
    print(f"    {'measured GPU':<14} {MEASURED_GPU_GFLOPS:>8.1f} GFLOPS (measured)              "
          f"-> ${MEASURED_GPU_GFLOPS * PI_MARKET_USD_PER_GFLOPS_HR:.5f}/hr")
    print()
    print("  All of these are fractions of a cent per hour -- consistent with")
    print("  Ormandy's own <1-cent/month figure for the SHA-256 case. The binding")
    print("  constraint on attacker advantage here is the THROUGHPUT ratio (Part 4),")
    print("  not dollar cost -- cloud GPU rental is cheap enough that cost was never")
    print("  going to be the deterrent.")


def report_mitigation_pointer() -> None:
    print()
    print("=" * 78)
    print("MITIGATION -- not solved here, pointed at explicitly")
    print("=" * 78)
    print("  BUILD.md's own primary-risk note names the fix: mix a memory-hard")
    print("  component into the shard commitment, rather than relying on the GEMM")
    print("  kernel alone for deterrence. Concretely, a next step worth scoping:")
    print("  require the row-hash commitment (merkle.js#hashRow, ADR-0011) to")
    print("  incorporate a memory-hard KDF over each row rather than a single")
    print("  SHA-256 pass -- this would raise the memory-hardness of the")
    print("  COMMITMENT step without changing the GEMM kernel or the useful-work")
    print("  claim, since the underlying matmul is still what gets sold. Sizing")
    print("  and benchmarking that change is out of scope for this measurement and")
    print("  is recorded as an open question rather than attempted here.")


def main() -> None:
    print()
    print("ZK-PoC / bench -- attacker-advantage-ratio measurement")
    print("M2 exit criterion 3 (docs/BUILD.md): does GEMM-based useful-PoW give")
    print("a GPU attacker more advantage than a memory-hard puzzle would?")
    print()

    measured_ratio = report_measured_ratio()
    mh_lo, mh_hi = report_memory_hard_control()
    report_anubis_precedent()
    report_comparison(measured_ratio, mh_lo, mh_hi)
    report_cost_context()
    report_mitigation_pointer()

    print()
    print("=" * 78)
    print("  Sources: Specops Software / Outpost24, 'Argon2id vs GPU cracking',")
    print("  Jul 2026 -- Argon2 PHC-era GPU benchmark discussion (Khovratovich)")
    print("  -- Tavis Ormandy on Anubis PoW bypass -- bench/dispatch_analysis.py")
    print("  and docs/BUILD.md sec.1 for this project's own measured figures.")
    print()

    assert measured_ratio > mh_hi, (
        "expected our measured ratio to exceed the memory-hard control's upper "
        "bound -- if this no longer holds, PART 4's finding text needs rewriting, "
        "not just the numbers")


if __name__ == "__main__":
    main()
