#!/usr/bin/env python3
"""
ZK-PoC break-even model.

Answers the question the literature has never answered: at what device
resource share, on what device class, against what advertising CPM, does
consented compute barter actually beat advertising?

    V_compute(d, s, dt) * eta_verify(a, r)  -  E_cost(d, s, dt)  >  R_ads(m, dt)

Solving for s gives sigma*(d, m), the break-even resource share. Publishing
that surface is the headline result of the project. A single yes/no verdict
(which is what Saad & Mohaisen produced for hash-based PoW) is strictly less
informative than the frontier.

TWO RESULTS FALL OUT OF THIS MODEL
----------------------------------
1. The <=5% ambient ceiling in the original ZK-PoC design cannot clear any
   realistic CPM on any device class. WASM-on-CPU at 5% is worse than the
   corrected cryptojacking baseline from bench/tdsc_reproduction.py. WebGPU
   is not an optional path, it is the whole project.

2. ZK auditing is only economically viable when paired with a large stake.
   Because proving costs 10^3-10^6x the work it proves, any audit rate high
   enough to deter free-riding on its own destroys the economics. The stake
   must do the deterrence work so the proof can stay rare. See
   verification_feasibility().

Run:  python bench/breakeven.py
Deps: none (stdlib only). Writes CSV to bench/out/ for plotting.
"""

import csv
import glob
import json
import os
from dataclasses import dataclass

# --------------------------------------------------------------------------
# Reference prices
# --------------------------------------------------------------------------

# Consumer-GPU cloud spot as the marginal price of compute. ~$0.30/hr for a
# card delivering ~30 TFLOPS fp32 usable => $1.0e-5 per GFLOPS-hour.
#
# This is the THEORETICAL CEILING. Real consumer-compute marketplaces (Salad,
# Vast.ai) clear at roughly $0.005-0.02/hr for an idle consumer GPU, i.e.
# BELOW spot parity, because buyers discount for churn and reliability. Use
# MARKET_DISCOUNT to model that gap.
PI_MARKET_USD_PER_GFLOPS_HR = 1.0e-5
MARKET_DISCOUNT = 1.0  # 1.0 = theoretical parity; ~0.3 = observed clearing

# Electricity, USD per watt-hour. Matches Saad & Mohaisen's C constant so the
# two models share a cost basis.
C_ELEC_USD_PER_WH = 6.418e-5

# Corrected cryptojacking baseline, USD per device-hour.
# Derived in bench/tdsc_reproduction.py -- NOT the figure printed in the paper.
CRYPTOJACKING_BASELINE_USD_HR = 0.000438


# --------------------------------------------------------------------------
# Device tiers
# --------------------------------------------------------------------------

@dataclass
class DeviceTier:
    """A device class.

    flops_gflops is the ACHIEVABLE rate through the given browser path, not
    the silicon's peak. These defaults are literature/spec-anchored estimates
    and are placeholders until the M0 device probe replaces them with measured
    values -- see bench/device/. Anything derived from a placeholder is marked
    in the output.
    """
    name: str
    path: str                 # "wasm-simd" | "webgpu"
    flops_gflops: float       # achievable GFLOPS through that path
    watts_full: float         # marginal watts at 100% share
    # Tracked separately because they are measured separately: the browser
    # probe can measure FLOPS but cannot measure power draw at all. A tier
    # with real FLOPS and a guessed wattage is not a measured tier, and the
    # output must not imply otherwise -- energy is half the break-even model.
    flops_measured: bool = False
    watts_measured: bool = False

    @property
    def marker(self) -> str:
        """Suffix flagging which columns are still placeholders."""
        return ("" if self.flops_measured else "*") + ("" if self.watts_measured else "w")


# Defaults. Rationale in docs/device-tiers.md.
DEFAULT_TIERS = [
    DeviceTier("desktop-dgpu",   "webgpu",     5000.0, 180.0),
    DeviceTier("laptop-dgpu",    "webgpu",     5000.0,  80.0),
    DeviceTier("laptop-igpu",    "webgpu",      850.0,  25.0),
    DeviceTier("laptop-cpu",     "wasm-simd",    80.0,  20.0),
    DeviceTier("mobile-gpu",     "webgpu",      300.0,   6.0),
    DeviceTier("mobile-cpu",     "wasm-simd",    15.0,   4.0),
]


MEASUREMENT_DIR = os.path.join(os.path.dirname(__file__), "device", "measurements")


def load_measured_tiers(directory: str = MEASUREMENT_DIR) -> list[DeviceTier]:
    """Override placeholder tiers with real probe output.

    Drop bench/device/probe.html output into bench/device/measurements/ named
    after the tier it represents, e.g. `laptop-dgpu.json`. The probe cannot
    measure power draw -- browsers expose none -- so add a "watts_full" key by
    hand from host-side RAPL / Intel Power Gadget / powermetrics. Without it
    the tier keeps its default wattage and stays flagged as unmeasured.
    """
    if not os.path.isdir(directory):
        return list(DEFAULT_TIERS)

    by_name = {t.name: t for t in DEFAULT_TIERS}
    for path in sorted(glob.glob(os.path.join(directory, "*.json"))):
        name = os.path.splitext(os.path.basename(path))[0]
        try:
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! skipping {os.path.basename(path)}: {exc}")
            continue

        results = payload.get("results", {})
        # Prefer the GPU path; it is the only one the economics can support.
        for key, path_label in (("gpu", "webgpu"), ("cpu", "wasm-simd")):
            entry = results.get(key) or {}
            gflops = entry.get("gflops")
            if not gflops or entry.get("error"):
                continue
            if entry.get("correct") is False:
                print(f"  ! {name}: {key} failed verification, ignoring")
                continue
            base = by_name.get(name)
            watts = payload.get("watts_full")
            by_name[name] = DeviceTier(
                name=name,
                path=path_label,
                flops_gflops=float(gflops),
                watts_full=float(watts) if watts is not None
                           else (base.watts_full if base else 50.0),
                flops_measured=True,
                watts_measured=watts is not None,
            )
            break
    return list(by_name.values())


# --------------------------------------------------------------------------
# Ad markets
# --------------------------------------------------------------------------

@dataclass
class Market:
    name: str
    cpm_usd: float
    impressions_per_session: float = 3.0


DEFAULT_MARKETS = [
    Market("US-display",        3.00),
    Market("EU-display",        1.50),
    Market("LATAM-display",     0.60),
    Market("India/SEA-display", 0.30),
    Market("long-tail",         0.10),
]


# --------------------------------------------------------------------------
# Verification overhead
# --------------------------------------------------------------------------

@dataclass
class VerificationPolicy:
    """Tiered verification: redundancy on the bulk, ZK proof on a sample.

    redundancy r  -- each shard executed r times for consensus. Useful output
                     is 1 unit per r units of work, so efficiency is 1/r.
    audit_rate a  -- fraction of shards additionally given a ZK proof.
    proof_cost    -- proving cost as a multiple of the proved computation.
                     The ZKML survey (arXiv:2502.18535) reports circuit
                     expansion factors of 10^3-10^4; zkVM proving time
                     multiples are commonly quoted at 10^5-10^6.
    """
    redundancy: float = 2.0
    audit_rate: float = 0.01
    proof_cost: float = 1000.0

    def eta(self) -> float:
        """Sellable output per unit of work actually performed.

        Total work per unit of accepted output = r + a * proof_cost.
        Note this is 1/(r + a*c), NOT 1 - (r-1) - a*c: at r=2 the correct
        efficiency is 0.5, not 0.
        """
        return 1.0 / (self.redundancy + self.audit_rate * self.proof_cost)


def min_audit_rate(penalty_multiple: float) -> float:
    """Minimum audit rate that makes free-riding non-profitable.

    Inspection game. A free-rider who fabricates a result gains g (the credit
    for one shard). Caught with probability a, forfeiting a stake worth
    k * g. Expected gain is non-positive when:

        (1 - a) * g  -  a * k * g  <=  0     =>     a >= 1 / (1 + k)

    So the required audit rate depends only on the penalty multiple. A large
    stake buys a small audit rate, which is what makes ZK proving affordable.
    """
    return 1.0 / (1.0 + penalty_multiple)


# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------

def compute_value_usd_per_hr(tier: DeviceTier, share: float,
                             eta: float, discount: float = MARKET_DISCOUNT) -> float:
    """Gross sellable value of the compute, USD per hour."""
    return (PI_MARKET_USD_PER_GFLOPS_HR * discount
            * tier.flops_gflops * share * eta)


def energy_cost_usd_per_hr(tier: DeviceTier, share: float) -> float:
    """Electricity cost borne by the user, USD per hour."""
    return C_ELEC_USD_PER_WH * tier.watts_full * share


def critical_watts(tier: DeviceTier, policy: VerificationPolicy,
                   discount: float = MARKET_DISCOUNT) -> float:
    """Marginal draw at which the compute is exactly worth its electricity.

    The honest way to handle an unmeasured parameter is to report the threshold
    rather than guess the value. Above this wattage the tier loses money at
    *every* share, so no scheduling policy can rescue it; below it, the tier is
    at least worth arguing about. A reader who knows their own hardware's draw
    can then decide the question without trusting the placeholder.
    """
    value_per_unit_share = (PI_MARKET_USD_PER_GFLOPS_HR * discount
                            * tier.flops_gflops * policy.eta())
    return value_per_unit_share / C_ELEC_USD_PER_WH


def ad_revenue_usd_per_hr(market: Market, session_minutes: float = 6.0) -> float:
    """Advertising yield expressed as an hourly rate for comparison."""
    per_session = market.cpm_usd / 1000.0 * market.impressions_per_session
    sessions_per_hour = 60.0 / session_minutes
    return per_session * sessions_per_hour


def breakeven_share(tier: DeviceTier, market: Market,
                    policy: VerificationPolicy,
                    session_minutes: float = 6.0,
                    discount: float = MARKET_DISCOUNT) -> float | None:
    """Solve for sigma*, the resource share at which barter matches ads.

    Returns None when no share can ever clear the bar -- which happens when
    the marginal energy cost per unit share exceeds the marginal compute
    value per unit share. In that regime the device burns more electricity
    than the work is worth and the answer is 'never', not 'a large share'.
    """
    eta = policy.eta()
    value_per_unit_share = (PI_MARKET_USD_PER_GFLOPS_HR * discount
                            * tier.flops_gflops * eta)
    cost_per_unit_share = C_ELEC_USD_PER_WH * tier.watts_full
    net_per_unit_share = value_per_unit_share - cost_per_unit_share

    if net_per_unit_share <= 0:
        return None

    target = ad_revenue_usd_per_hr(market, session_minutes)
    return target / net_per_unit_share


def fmt_share(s: float | None) -> str:
    if s is None:
        return "  never"
    if s > 100:
        return " >10000%"
    return f"{s * 100:7.1f}%"


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------

def report_yield_table(policy: VerificationPolicy,
                       tiers: list[DeviceTier]) -> None:
    """What each device class yields at fixed shares, vs the mining baseline."""
    print("=" * 78)
    print("PART 1 -- Yield per device-hour at fixed resource shares")
    print("=" * 78)
    print(f"  verification: r={policy.redundancy:g}, a={policy.audit_rate:g}, "
          f"c_proof={policy.proof_cost:g}  =>  eta={policy.eta():.4f}")
    print(f"  corrected cryptojacking baseline: "
          f"${CRYPTOJACKING_BASELINE_USD_HR:.5f}/hr")
    print()
    shares = [0.05, 0.25, 1.00]
    print(f"  {'device tier':<15} {'path':<10} "
          + "".join(f"{'@'+str(int(s*100))+'%':>12}" for s in shares)
          + f"{'vs mining':>11} {'W*':>7} {'W set':>7}")
    print("  " + "-" * 90)
    for t in tiers:
        cells = ""
        for s in shares:
            net = (compute_value_usd_per_hr(t, s, policy.eta())
                   - energy_cost_usd_per_hr(t, s))
            cells += f"{net:>12.5f}"
        net5 = (compute_value_usd_per_hr(t, 0.05, policy.eta())
                - energy_cost_usd_per_hr(t, 0.05))
        ratio = net5 / CRYPTOJACKING_BASELINE_USD_HR
        cw = critical_watts(t, policy)
        verdict = "" if t.watts_full < cw else "  <-- uneconomic at any share"
        print(f"  {t.name:<15} {t.path:<10}{cells}{ratio:>10.1f}x "
              f"{cw:>7.1f} {t.watts_full:>6.0f}{t.marker}{verdict}")
    print()
    print()
    print("  Net of electricity. 'vs mining' compares the 5% column against the")
    print("  corrected baseline.  * = placeholder FLOPS   w = placeholder watts")
    print()
    print("  W* is the marginal draw at which the compute exactly pays for its")
    print("  own electricity. Since no browser exposes power, this threshold is")
    print("  reported instead of a guessed value: if a device's real draw under")
    print("  sustained load exceeds W*, it loses money at EVERY share and no")
    print("  scheduling policy can rescue it.")


def report_breakeven_surface(policy: VerificationPolicy,
                             tiers: list[DeviceTier]) -> list[dict]:
    """The headline result: sigma*(device, market)."""
    print()
    print("=" * 78)
    print("PART 2 -- Break-even resource share  sigma*(device, market)")
    print("=" * 78)
    print("  The share of the device required for barter to match ad revenue.")
    print("  Values above 100% mean the whole device is not enough.")
    print()
    header = f"  {'device tier':<15}" + "".join(
        f"{m.name:>19}" for m in DEFAULT_MARKETS)
    print(header)
    print("  " + "-" * (len(header) - 2))

    rows = []
    for t in tiers:
        line = f"  {t.name:<15}"
        for m in DEFAULT_MARKETS:
            s = breakeven_share(t, m, policy)
            line += f"{fmt_share(s):>19}"
            rows.append({
                "device": t.name, "path": t.path, "market": m.name,
                "cpm": m.cpm_usd, "flops_gflops": t.flops_gflops,
                "watts_full": t.watts_full,
                "flops_measured": t.flops_measured,
                "watts_measured": t.watts_measured,
                "eta": round(policy.eta(), 6),
                "sigma_star": "" if s is None else round(s, 6),
            })
        print(line)

    print()
    print("  Read the 5% design ceiling against this table: a cell must be at")
    print("  or below 5% for the original ZK-PoC design to clear that market.")
    feasible = [r for r in rows
                if r["sigma_star"] != "" and r["sigma_star"] <= 0.05]
    if feasible:
        print(f"  Cells at or below 5%: {len(feasible)}")
        for r in feasible:
            print(f"    - {r['device']} x {r['market']} "
                  f"({r['sigma_star']*100:.1f}%)")
    else:
        print("  Cells at or below 5%: NONE.")
        print("  The <=5% ambient ceiling cannot clear any modelled market on")
        print("  any modelled device. This is the central negative result and")
        print("  it holds regardless of engineering quality.")
    return rows


def verification_feasibility() -> None:
    """Why the audit rate has to be tiny, and what has to make that safe."""
    print()
    print("=" * 78)
    print("PART 3 -- Verification feasibility: the audit rate / stake trade-off")
    print("=" * 78)
    print("  Proving costs 10^3-10^6x the work it proves, so the audit rate")
    print("  directly multiplies into total cost. eta = 1 / (r + a * c_proof).")
    print()
    audit_rates = [1.0, 0.1, 0.01, 0.001, 0.0001]
    proof_costs = [100.0, 1000.0, 10000.0, 1000000.0]
    print(f"  {'audit rate':>11} " + "".join(
        f"{'c=' + f'{c:.0e}':>13}" for c in proof_costs))
    print("  " + "-" * 63)
    for a in audit_rates:
        line = f"  {a:>11.4f} "
        for c in proof_costs:
            eta = VerificationPolicy(redundancy=2.0, audit_rate=a,
                                     proof_cost=c).eta()
            line += f"{eta:>13.6f}"
        print(line)
    print()
    print("  eta is sellable output per unit of work performed. Anything below")
    print("  ~0.1 makes the barter economics hopeless on its own, before the")
    print("  device even competes with advertising.")
    print()
    print("  The inspection game fixes the minimum safe audit rate from the")
    print("  stake, independently of proving cost:  a* = 1 / (1 + k)")
    print()
    print(f"  {'stake k (shards)':>18} {'a* required':>13} "
          f"{'eta @ c=1e3':>13} {'eta @ c=1e5':>13}")
    print("  " + "-" * 60)
    for k in [1, 9, 99, 999, 9999, 99999]:
        a = min_audit_rate(k)
        e3 = VerificationPolicy(2.0, a, 1e3).eta()
        e5 = VerificationPolicy(2.0, a, 1e5).eta()
        print(f"  {k:>18,} {a:>13.5f} {e3:>13.6f} {e5:>13.6f}")
    print()
    print("  RESULT. Deterrence and affordability pull in opposite directions,")
    print("  and the stake is what reconciles them. A small stake forces a high")
    print("  audit rate, which proving cost then makes unaffordable. A stake")
    print("  worth ~10^3-10^4 shards drops the required audit rate far enough")
    print("  that ZK proofs become a rounding error in the cost model.")
    print()
    print("  This is the re-scoped N4 claim: proof placement is not a design")
    print("  preference, it is the solution to an inspection game whose")
    print("  parameters come from the economics, not from anomaly detection.")


def write_csv(rows: list[dict]) -> str:
    out_dir = os.path.join(os.path.dirname(__file__), "out")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "breakeven_surface.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return path


def report_policy_sensitivity(tiers: list[DeviceTier]) -> None:
    """The verification policy, not the hardware, is the binding constraint."""
    print()
    print("=" * 78)
    print("PART 4 -- Sensitivity: policy choice and market discount")
    print("=" * 78)
    print("  sigma* for the best device class against the CHEAPEST inventory")
    print("  modelled -- i.e. the single most favourable cell in the surface.")
    print("  If the 5% ceiling fails here, it fails everywhere.")
    print()
    tier = min(
        (t for t in tiers),
        key=lambda t: breakeven_share(
            t, min(DEFAULT_MARKETS, key=lambda m: m.cpm_usd),
            VerificationPolicy(1.0, 0.0, 1000.0)) or float("inf"))
    market = min(DEFAULT_MARKETS, key=lambda m: m.cpm_usd)
    print(f"  best tier: {tier.name}    cheapest market: {market.name} "
          f"(CPM ${market.cpm_usd:.2f})")
    print()

    print(f"  {'verification policy':<34} {'eta':>8} {'sigma*':>10}")
    print("  " + "-" * 54)
    for label, pol in [
        ("naive: prove 1% of shards",   VerificationPolicy(2.0, 0.01,   1000.0)),
        ("designed: stake k=999",       VerificationPolicy(2.0, 0.001,  1000.0)),
        ("designed: stake k=9999",      VerificationPolicy(2.0, 0.0001, 1000.0)),
        ("no redundancy, stake k=9999", VerificationPolicy(1.0, 0.0001, 1000.0)),
        ("upper bound: no verification", VerificationPolicy(1.0, 0.0,   1000.0)),
    ]:
        s = breakeven_share(tier, market, pol)
        print(f"  {label:<34} {pol.eta():>8.4f} {fmt_share(s):>10}")

    print()
    print(f"  {'market discount':<34} {'sigma*':>19}")
    print("  " + "-" * 54)
    designed = VerificationPolicy(2.0, 0.001, 1000.0)
    for label, disc in [
        ("1.00  theoretical spot parity", 1.00),
        ("0.40  optimistic clearing",     0.40),
        ("0.20  observed (Salad/Vast.ai)", 0.20),
    ]:
        s = breakeven_share(tier, market, designed, discount=disc)
        print(f"  {label:<34} {fmt_share(s):>19}")

    upper = breakeven_share(tier, market, VerificationPolicy(1.0, 0.0, 1000.0))
    print()
    print("  ABSOLUTE UPPER BOUND")
    print(f"  Best device class, cheapest inventory, theoretical spot parity,")
    print(f"  zero redundancy and zero verification overhead: sigma* = "
          f"{upper * 100:.1f}%")
    print()
    if upper is not None and upper > 0.05:
        print(f"  Still above the 5% design ceiling, by {upper / 0.05:.1f}x.")
        print("  Every lever has been set to its most favourable value and the")
        print("  ceiling still cannot be met, so the negative result does not")
        print("  rest on any pessimistic assumption.")
        print()
        print("  But note the MARGIN. The ceiling misses by a small factor, not")
        print("  an order of magnitude. The constructive reading is that the")
        print(f"  design is nearly right and the ceiling is simply set too low:")
        print(f"  at ~{upper*100:.0f}-25% share, long-tail inventory is reachable on a")
        print("  discrete GPU. That is a recommendation, not a refutation.")
    else:
        print("  The ceiling is reachable in this corner -- re-examine.")


def main() -> None:
    # The designed policy, derived in PART 3: a large stake buys a low audit
    # rate, which is what makes ZK proving affordable. Using the economically
    # optimal policy for the headline surface is deliberate -- the negative
    # result is much stronger when stated under favourable assumptions.
    policy = VerificationPolicy(redundancy=2.0, audit_rate=0.001,
                                proof_cost=1000.0)
    print()
    print("ZK-PoC / bench -- break-even model")
    print("Does consented compute barter beat advertising, and where?")
    print()
    tiers = load_measured_tiers()
    n_flops = sum(1 for t in tiers if t.flops_measured)
    n_watts = sum(1 for t in tiers if t.watts_measured)
    if n_flops:
        print(f"  {n_flops}/{len(tiers)} tiers have measured FLOPS, "
              f"{n_watts}/{len(tiers)} have measured watts.")
        if n_watts < n_flops:
            print("  Wattage is still a placeholder where FLOPS are real. Energy")
            print("  is half this model, so treat those rows as provisional.")
    else:
        print("  No probe measurements found. All device tiers are")
        print("  literature-anchored PLACEHOLDERS -- open bench/device/probe.html")
        print("  on each target device and save the JSON to")
        print("  bench/device/measurements/<tier-name>.json before quoting these")
        print("  numbers anywhere.")
    print()
    print(f"  Headline surface uses the DESIGNED verification policy")
    print(f"  (r={policy.redundancy:g}, a={policy.audit_rate:g}, "
          f"c_proof={policy.proof_cost:g}, stake k=999) and theoretical spot")
    print("  parity for compute. Both are favourable to barter by construction.")
    print()
    report_yield_table(policy, tiers)
    rows = report_breakeven_surface(policy, tiers)
    verification_feasibility()
    report_policy_sensitivity(tiers)

    path = write_csv(rows)
    print()
    print("=" * 78)
    print(f"  surface written to {path}")
    print("  Replace the placeholder FLOPS in DEFAULT_TIERS with measured")
    print("  values from bench/device/ before quoting any of these numbers.")
    print()


if __name__ == "__main__":
    main()
