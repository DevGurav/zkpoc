# ADR-0008: Use a corrected cryptojacking baseline, not the source paper's stated figure

Status: Accepted (2026-08-02)

## Context

Saad & Mohaisen (IEEE TDSC 2024, arXiv:2304.13253) is the reference economic
analysis this project is measured against, and its Section 6.1 reports a
cryptojacking yield of `$1.06 × 10⁻⁵ USD/second`. This figure is the natural
"floor" any useful-work substitution needs to clear — the F2 (valueless work)
baseline being replaced.

Recomputing from the paper's own Eq. (5) and its own stated parameters
(h = 21 hashes/sec, Δt = 85 min, Coinhive's stated payout rate, XMR = $200):

```
hashes = 21 × 85 × 60 = 107,100
P(XMR) = 2894e-8 × 107100 / 1e6 = 3.10e-6 XMR   ✓ matches the paper's stated 3.19e-6
P(USD) = 3.10e-6 × 200 = $6.20e-4               ✓ matches the paper's stated $6.38e-4
rate   = $6.20e-4 / 5100 s = $1.22e-7/sec        ✗ paper states $1.06e-5/sec
```

Every intermediate value in the paper's own worked example reproduces exactly.
The final per-second rate does not: it equals the paper's own profit figure
divided by 60, not by the 5100-second session length used everywhere else in
the same calculation — an **~87× overstatement**, isolated and confirmed in
`bench/tdsc_reproduction.py`.

## Decision

Use the corrected figure, **$1.22 × 10⁻⁷ USD/second ($0.00044/device-hour)**,
as `CRYPTOJACKING_BASELINE_USD_HR` in `bench/breakeven.py`, not the paper's
stated $1.06×10⁻⁵/sec. The correction is derived and asserted programmatically
in `bench/tdsc_reproduction.py`, which reproduces every other intermediate
from the source paper and treats this specific discrepancy as the one
divergence — with a runnable assertion (`PAPER_P_USD / 60` matches the paper's
stated rate to within 1%) that pins down exactly where the ~87× came from,
rather than asserting a vague "the paper seems off."

## Consequences

- The corrected baseline makes the paper's own conclusion (cryptojacking is
  economically infeasible vs. advertising) **stronger**, not weaker — the true
  gap between P and L (profit vs. loss from battery/energy cost) is ~87× wider
  than stated. This is presented as a reproduce-and-correct contribution, not
  as a criticism that undermines the source paper's usefulness as a reference.
- `bench/tdsc_reproduction.py` additionally reconciles the paper's Table 9 row
  by row (nine device/throttle combinations) and finds two rows — both at
  reduced throttle on the Windows device — do not close against a fixed
  per-device session length the way the α=0.1 rows do. This is reported as a
  reconciliation (the table doesn't print a per-row Δt, so a varying session
  length is a plausible innocent explanation) rather than a second error
  claim, since the evidence doesn't support the stronger claim.
- Every downstream figure that compares against "the mining baseline" —
  `bench/breakeven.py`'s "vs mining" column, the `W*` critical-wattage
  threshold, all of it — is built on the corrected number. Citing the paper's
  stated figure anywhere in this project would be citing a number this
  project's own tooling demonstrates is wrong by nearly two orders of
  magnitude.
- Alternative considered and rejected: cite the paper's stated figure as-is,
  since it's the published, peer-reviewed number. Rejected because the
  discrepancy is reproducible, mechanical (a specific division-by-wrong-number
  error, not a modelling disagreement), and directly affects a comparison this
  project's central result depends on — using a demonstrably incorrect
  input would be worse than the extra scrutiny of correcting it.
