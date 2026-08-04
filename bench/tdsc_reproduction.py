#!/usr/bin/env python3
"""
Reproduction of the economic model in:

    M. Saad and D. Mohaisen, "Analyzing In-Browser Cryptojacking,"
    IEEE Transactions on Dependable and Secure Computing, 2024.
    Open access: arXiv:2304.13253v1

This is the quantitative baseline that ZK-PoC is measured against, so it is
reproduced from first principles rather than cited.

WHAT THIS SCRIPT ESTABLISHES
----------------------------
1. Eq. (5) and Eq. (6) reproduce exactly from the paper's stated parameters.
   Every intermediate value in the worked example matches.

2. The per-second yield reported in Section 6.1 is inconsistent with Eq. (5)
   by a factor of ~85. The paper states $1.06e-5 USD/second; the correct value
   derived from its own numbers is $1.22e-7 USD/second. The discrepancy is
   exactly a division by 60 rather than by the 5100-second session length.

   This does not weaken the paper's conclusion -- it strengthens it. The real
   cryptojacking yield is ~85x smaller than reported, so the profit/loss gap
   the paper identifies is correspondingly wider.

3. Table 9's P column does not reconcile with Eq. (5) under a session length
   held constant per device. Reported here as a reconciliation report, NOT as
   a claimed error: the table does not print a per-row Delta-t, and a varying
   session length would explain it. See reconcile_table9().

Run:  python bench/tdsc_reproduction.py
Deps: none (stdlib only)
"""

from dataclasses import dataclass

# --------------------------------------------------------------------------
# Constants exactly as stated in the paper (Section 6.1)
# --------------------------------------------------------------------------

XMR_PER_MILLION_HASHES = 2894e-8  # Coinhive payout, "2,894x10^-8 XMR per 1e6 hashes"
USD_PER_XMR = 200.0               # "1 XMR equals 200 USD"
C_ELEC = 6.418e-5                 # USD per watt-hour
T_RECHARGE_1PCT_WINDOWS = 0.015   # hours to recharge 1% on the Windows test device

# The worked example in Section 6.1 (Windows i7, alpha = 0.1, from Figure 7)
EX_HASHRATE = 21.0    # hashes/second
EX_DT_MIN = 85.0      # minutes
EX_W = 65.0           # watt-hours
EX_BN = 82.0          # battery % without cryptojacking
EX_BC = 10.0          # battery % with cryptojacking

# Values the paper itself reports for that example, used as assertions.
PAPER_P_XMR = 3.19e-6
PAPER_P_USD = 6.38e-4
PAPER_L_USD = 4.5e-3
PAPER_RATE_PER_SEC = 1.06e-5   # <-- the figure this script disputes
PAPER_HASHES_PER_XMR = 3.45e10
PAPER_YEARS_TO_1_XMR = 52.0


# --------------------------------------------------------------------------
# The paper's model
# --------------------------------------------------------------------------

def profit_xmr(hashrate_hps: float, dt_seconds: float) -> float:
    """Eq. (5): P(XMR) = (2894e-8 * h * dt) / 1e6

    h is in hashes/second, so dt must be in SECONDS for the units to close.
    Total hashes = h * dt; payout is XMR_PER_MILLION_HASHES per 1e6 hashes.
    """
    total_hashes = hashrate_hps * dt_seconds
    return XMR_PER_MILLION_HASHES * total_hashes / 1e6


def loss_usd(watt_hours: float, t_recharge: float, bn: float, bc: float,
             c_elec: float = C_ELEC) -> float:
    """Eq. (6): L(USD) = C * W * tr * (bn - bc)

    Energy cost to the *user* of recharging the battery delta caused by mining.
    """
    return c_elec * watt_hours * t_recharge * (bn - bc)


def hashes_for_one_xmr() -> float:
    """Hashes required to earn 1 XMR at the stated payout rate."""
    return 1e6 / XMR_PER_MILLION_HASHES


def years_to_mine_one_xmr(hashrate_hps: float) -> float:
    seconds = hashes_for_one_xmr() / hashrate_hps
    return seconds / (365.25 * 24 * 3600)


# --------------------------------------------------------------------------
# Part 1 -- reproduce the worked example
# --------------------------------------------------------------------------

def reproduce_worked_example() -> dict:
    dt_seconds = EX_DT_MIN * 60.0
    total_hashes = EX_HASHRATE * dt_seconds

    p_xmr = profit_xmr(EX_HASHRATE, dt_seconds)
    p_usd = p_xmr * USD_PER_XMR
    l_usd = loss_usd(EX_W, T_RECHARGE_1PCT_WINDOWS, EX_BN, EX_BC)

    print("=" * 74)
    print("PART 1 -- Worked example, Section 6.1 (Windows i7, alpha = 0.1)")
    print("=" * 74)
    print(f"  hash rate h            = {EX_HASHRATE:g} hashes/second")
    print(f"  session Delta-t        = {EX_DT_MIN:g} min = {dt_seconds:g} s")
    print(f"  total hashes           = {total_hashes:,.0f}")
    print()
    print(f"  Eq.(5) P               = {p_xmr:.4e} XMR"
          f"     [paper: {PAPER_P_XMR:.2e}]")
    print(f"  Eq.(5) P               = ${p_usd:.4e}"
          f"        [paper: ${PAPER_P_USD:.2e}]")
    print(f"  Eq.(6) L               = ${l_usd:.4e}"
          f"        [paper: ${PAPER_L_USD:.1e}]")
    print(f"  gap L - P              = ${l_usd - p_usd:.4e}"
          f"        [paper: L is ~7x P]")
    print(f"  ratio L/P              = {l_usd / p_usd:.2f}x"
          f"                 [paper: 'seven times']")
    print()
    print(f"  hashes per 1 XMR       = {hashes_for_one_xmr():.3e}"
          f"       [paper: {PAPER_HASHES_PER_XMR:.2e}]")
    print(f"  years to mine 1 XMR    = {years_to_mine_one_xmr(EX_HASHRATE):.1f}"
          f"                [paper: ~{PAPER_YEARS_TO_1_XMR:g}]")

    # These all reconcile to within stated rounding.
    assert abs(p_xmr - PAPER_P_XMR) / PAPER_P_XMR < 0.05, "P(XMR) diverged"
    assert abs(p_usd - PAPER_P_USD) / PAPER_P_USD < 0.05, "P(USD) diverged"
    assert abs(l_usd - PAPER_L_USD) / PAPER_L_USD < 0.05, "L(USD) diverged"
    assert abs(hashes_for_one_xmr() - PAPER_HASHES_PER_XMR) / PAPER_HASHES_PER_XMR < 0.02
    print()
    print("  -> Eq.(5) and Eq.(6) reproduce. All intermediates match.")

    return {"p_usd": p_usd, "l_usd": l_usd, "dt_seconds": dt_seconds}


# --------------------------------------------------------------------------
# Part 2 -- the per-second rate discrepancy
# --------------------------------------------------------------------------

def analyse_rate_discrepancy(p_usd: float, dt_seconds: float) -> float:
    """The paper reports '$1.06e-5 USD/second'. Test every reading of that."""
    per_second = p_usd / dt_seconds
    per_minute = p_usd / (dt_seconds / 60.0)
    # The paper divided ITS OWN stated P by 60, so test against that figure --
    # this isolates the arithmetic slip from our sub-1% rounding difference in P.
    paper_p_over_60 = PAPER_P_USD / 60.0

    print()
    print("=" * 74)
    print("PART 2 -- The per-second rate discrepancy")
    print("=" * 74)
    print(f"  Paper states                        : ${PAPER_RATE_PER_SEC:.4e} / second")
    print()
    print(f"  P / session length ({dt_seconds:g} s)      : ${per_second:.4e} / second")
    print(f"  P / session length ({dt_seconds/60:g} min)      : ${per_minute:.4e} / minute")
    print(f"  (paper's own P) / 60                : ${paper_p_over_60:.4e}"
          f"   <-- reproduces their figure to {abs(paper_p_over_60/PAPER_RATE_PER_SEC - 1)*100:.2f}%")
    print()
    print(f"  Overstatement factor                : {PAPER_RATE_PER_SEC / per_second:.1f}x")
    print()
    print("  The reported figure is their own P divided by 60, not by the 5100 s")
    print("  session. Under no consistent reading of Delta-t does $1.06e-5")
    print("  represent a per-second rate:")
    print(f"    - as USD/second it should be ${per_second:.3e}")
    print(f"    - as USD/minute it should be ${per_minute:.3e}")
    print()
    print("  CORRECTED BASELINE")
    print(f"    per second : ${per_second:.4e}")
    print(f"    per hour   : ${per_second * 3600:.6f}")
    print(f"    per 6-min session : ${per_second * 360:.8f}")
    print()
    print("  This makes the paper's negative conclusion STRONGER, not weaker.")
    print("  Any framework claiming to beat advertising must clear the corrected")
    print(f"  bar of ${per_second * 3600:.5f}/hour, not the ~85x inflated figure.")

    # The claim this section rests on: their reported rate is their own P / 60.
    assert abs(paper_p_over_60 - PAPER_RATE_PER_SEC) / PAPER_RATE_PER_SEC < 0.01, \
        "reported rate is not (paper's P)/60 -- re-examine the discrepancy"
    # And it is ~85x larger than any defensible per-second reading.
    assert PAPER_RATE_PER_SEC / per_second > 50, "overstatement factor collapsed"

    return per_second


# --------------------------------------------------------------------------
# Part 3 -- Table 9 reconciliation
# --------------------------------------------------------------------------

@dataclass
class Row:
    """One row of Table 9. Delta-t and bn are printed once per device and
    span that device's three throttling rows."""
    device: str
    dt_min: float
    bn: float
    alpha: float
    h: float
    bc: float
    w: float
    p_e4: float      # reported P, units of 1e-4 USD
    l_e3: float      # reported L, units of 1e-3 USD
    gap_e3: float    # reported L - P, units of 1e-3 USD
    t_years: float


# Transcribed from Table 9 via coordinate-aware PDF extraction (page 10).
# Column order: Device | dt | bn | alpha | h | bc | W | P | L | L-P | T
TABLE9 = [
    Row("Windows", 85, 82, 0.1, 21, 10, 65, 6.4, 4.5, 3.8, 50),
    Row("Windows", 85, 82, 0.5, 14, 19, 65, 3.1, 3.7, 3.4, 104),
    Row("Windows", 85, 82, 0.9, 5, 57, 65, 0.44, 1.6, 1.5, 367),
    Row("Linux", 71, 70, 0.1, 26, 3, 41, 6.6, 5.5, 4.8, 40),
    Row("Linux", 71, 70, 0.5, 16, 22, 41, 4.1, 4.2, 3.8, 66),
    Row("Linux", 71, 70, 0.9, 5, 54, 41, 1.3, 2.6, 2.5, 214),
    Row("Android", 163, 76, 0.1, 5, 11, 9.9, 2.8, 0.95, 0.67, 220),
    Row("Android", 163, 76, 0.5, 3, 32, 9.9, 1.7, 0.72, 0.55, 369),
    Row("Android", 163, 76, 0.9, 2, 49, 9.9, 1.1, 0.54, 0.43, 574),
]


def reconcile_table9() -> None:
    """Recompute each Table 9 row and report agreement.

    Deliberately framed as a reconciliation report, not an error claim. The
    table prints Delta-t once per device; if the session length actually varies
    with the throttling parameter (which is physically expected -- more
    throttling means slower battery drain means a longer session) then the P
    column may be internally consistent in a way the printed table cannot show.
    """
    print()
    print("=" * 74)
    print("PART 3 -- Table 9 reconciliation")
    print("=" * 74)
    print()
    print("  P column: Eq.(5) recomputed with the device's printed Delta-t.")
    print("  'h from P' and 'h from T' invert the reported P and T back to the")
    print("  hash rate each one implies, to test whether the row is self-consistent.")
    print(f"  {'device':<9} {'a':>4} {'h rep':>6} {'P rep':>8} {'P calc':>9} "
          f"{'h from P':>9} {'h from T':>9}  status")
    print("  " + "-" * 74)

    for r in TABLE9:
        p_calc = profit_xmr(r.h, r.dt_min * 60.0) * USD_PER_XMR
        p_rep = r.p_e4 * 1e-4
        ratio = p_calc / p_rep
        # Invert Eq.(5) for h, holding the printed Delta-t.
        h_from_p = (p_rep / USD_PER_XMR) * 1e6 / (XMR_PER_MILLION_HASHES * r.dt_min * 60.0)
        # Invert the T definition for h.
        h_from_t = hashes_for_one_xmr() / (r.t_years * 365.25 * 24 * 3600)
        ok = "match" if abs(ratio - 1.0) < 0.06 else "DIVERGES"
        print(f"  {r.device:<9} {r.alpha:>4} {r.h:>6.0f} {p_rep:>8.2e} "
              f"{p_calc:>9.2e} {h_from_p:>9.1f} {h_from_t:>9.1f}  {ok}")

    print()
    print("  Reading: where 'h from P' and 'h from T' agree with each other but")
    print("  not with the printed h, the row is internally consistent and the")
    print("  printed h is the outlier. Windows alpha=0.5 is the clearest case --")
    print("  P and T both imply h ~ 10.5 against a printed 14. Windows alpha=0.9")
    print("  does not resolve to any single h, so that row is genuinely")
    print("  under-specified. Linux and Android reconcile throughout.")
    print()
    print("  Reported as a reconciliation report, not an error claim: the table")
    print("  prints Delta-t once per device, and h may be a peak rather than the")
    print("  session average that Eq.(5) requires.")

    print()
    print("  L column: Eq.(6) solved for the implied recharge time t_r")
    print("  (the paper states t_r = 0.015 h for the Windows device only)")
    print(f"  {'device':<9} {'a':>4} {'bn-bc':>6} {'L rep':>9} {'implied t_r':>12}")
    print("  " + "-" * 48)
    for r in TABLE9:
        delta_b = r.bn - r.bc
        l_rep = r.l_e3 * 1e-3
        implied_tr = l_rep / (C_ELEC * r.w * delta_b)
        print(f"  {r.device:<9} {r.alpha:>4} {delta_b:>6.0f} {l_rep:>9.2e} "
              f"{implied_tr:>12.4f} h")

    print()
    print("  Windows implied t_r ~ 0.015 h, matching the stated value, so")
    print("  Eq.(6) reproduces. Linux and Android imply different t_r, which")
    print("  is expected -- recharge rate is device-specific and the paper")
    print("  only states it for the Windows machine.")

    print()
    print("  T column: years to mine 1 XMR at the row's hash rate")
    print(f"  {'device':<9} {'a':>4} {'h':>4} {'T rep':>7} {'T calc':>8} {'status':>10}")
    print("  " + "-" * 48)
    for r in TABLE9:
        t_calc = years_to_mine_one_xmr(r.h)
        ok = "match" if abs(t_calc / r.t_years - 1.0) < 0.10 else "DIVERGES"
        print(f"  {r.device:<9} {r.alpha:>4} {r.h:>4.0f} {r.t_years:>7.0f} "
              f"{t_calc:>8.0f} {ok:>10}")

    print()
    print("  Linux and Android reconcile. The two throttled Windows rows do")
    print("  not, by the same margin as their P values -- again consistent")
    print("  with an unprinted per-row Delta-t.")


# --------------------------------------------------------------------------

def main() -> None:
    print()
    print("ZK-PoC / bench -- reproduction of Saad & Mohaisen (IEEE TDSC 2024)")
    print("arXiv:2304.13253v1, Section 6 'Economics of Cryptojacking'")
    print()

    ex = reproduce_worked_example()
    corrected = analyse_rate_discrepancy(ex["p_usd"], ex["dt_seconds"])
    reconcile_table9()

    print()
    print("=" * 74)
    print("SUMMARY")
    print("=" * 74)
    print(f"  Corrected cryptojacking baseline : ${corrected * 3600:.5f} / device-hour")
    print(f"  As reported in the paper         : ${PAPER_RATE_PER_SEC * 3600:.5f} / device-hour")
    print(f"  Overstatement                    : {PAPER_RATE_PER_SEC / corrected:.0f}x")
    print()
    print("  ZK-PoC uses the corrected figure as the F2 baseline that useful")
    print("  work must beat. See bench/breakeven.py for the target it must")
    print("  actually clear, which is advertising yield, not mining yield.")
    print()


if __name__ == "__main__":
    main()
