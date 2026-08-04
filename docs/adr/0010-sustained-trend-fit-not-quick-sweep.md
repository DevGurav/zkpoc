# ADR-0010: F(d) comes from a sustained OLS trend fit, not a short sweep's spread threshold

Status: Accepted (2026-08-03)

## Context

`bench/breakeven.py`'s device-tier throughput figure, `F(d)`, needs to
represent achievable GFLOPS over a **minutes-long session**, not a burst — the
economic model that consumes it (ADR-0001, ADR-0003) is explicitly about
sustained resource sharing, not peak capability.

A first measurement of the project's one real device (Intel Gen-12LP / Iris
Xe) used a 7-repetition quick sweep across matrix sizes N=256/512/1024. Every
run's samples decayed monotonically within it — 1.36× at N=1024, up to 2.26×
at N=256 — which read as textbook thermal throttling on an integrated GPU
sharing a power budget with the CPU. This produced a "sustained" figure of
75.4 GFLOPS, 11× below the original literature-anchored placeholder (850
GFLOPS), and was initially accepted as a corrected, defensible number.

A genuine 120-second sustained run at N=1024, bucketed into 2-second windows,
told a different story: throughput climbs from 57.5 to ~105 GFLOPS over the
**first ~16 seconds** (pipeline/shader warmup), then holds — an ordinary
least-squares trend fit over the remaining 96 seconds gives a slope of
**+2.4%/min**, statistically indistinguishable from flat given a tail standard
deviation of 4.08 GFLOPS on a mean of 107.2 (3.8% coefficient of variation,
consistent with per-2-second-bucket dispatch-count jitter, not a real trend).

The 7-rep run — ~200 ms of total GPU work — never got past the 16-second
warmup ramp. What looked like thermal decay was the tail end of a cold start,
sampled far too briefly to see it finish. The original spread-based plateau
check in `probe.html` (flag "not plateaued" if the last-third bucket spread
exceeds 5%) made this worse, not better: it flagged the genuinely-flat 120s
run as unplateaued too, at 8.76% spread, because a spread threshold cannot
distinguish bucket-level sampling noise from a real downward trend.

## Decision

1. **F(d) is measured via a sustained run** (`probe.html`'s "sustained"
   mode, 60–300s, bucketed), never from a short multi-repetition sweep. The
   quick-sweep mode is retained only for `bench/dispatch_analysis.py`'s
   separate purpose — fitting dispatch overhead vs. throughput across matrix
   sizes — which is a different, less thermally-sensitive quantity (a fixed
   per-dispatch cost, not a sustained rate).
2. **Plateau detection is a trend fit, not a spread threshold.**
   `summariseSustained()` in `probe.html` excludes an initial warmup window
   (the first ~15s or first quarter of the tail, whichever is smaller) and
   fits an OLS slope against elapsed time over the remainder, classifying the
   run as `rising`, `falling`, or `plateaued` (|slope| < 2%/min) — able to
   distinguish "noisy but flat" from "still declining," which a spread
   threshold structurally cannot do.
3. **A downgrade guard in `dispatch_analysis.py` prevents regression.** Since
   both the quick-sweep script and the sustained-run workflow write to the
   same per-tier measurement file, the writer ranks the *statistic* attached
   to any existing `results.gpu` entry (`sustained-steady-ols` outranks
   `sustained (slowest sample at largest N)` outranks `median`) and refuses
   to overwrite a better measurement with a worse one on a later run — see
   `bench/dispatch_analysis.py`'s `STAT_RANK`/`rank()`.

## Consequences

- `laptop-igpu`'s F(d) moved from 75.4 to **107.2 GFLOPS** — the direction
  matters as much as the magnitude: the *wrong* number in Pass 1 happened to
  point the same direction (economically weak) as the *corrected* number in
  Pass 2, which is a coincidence worth flagging, not a validation of the
  first method. A device where warmup contamination pointed the *other*
  direction would have produced a wrong and misleadingly optimistic figure.
- The break-even wattage `W*` for this tier moved from 3.9 W to 5.6 W
  accordingly (`bench/breakeven.py`'s `critical_watts()`); the tier's
  bottom-line verdict (uneconomic at any share) survived the correction, but
  on the corrected numbers rather than the wrong ones.
- `docs/device-tiers.md` documents both passes explicitly, including the
  wrong number and why it looked right, rather than only publishing the final
  corrected figure — the failure mode (short measurement, plausible-sounding
  physical story, confidently wrong) is exactly the kind of thing worth
  keeping visible for the remaining five placeholder tiers, which have not
  yet been measured at all and are flagged accordingly on every
  `bench/breakeven.py` run.
- Alternative considered and rejected: keep the spread-based plateau check
  and simply run it for longer, hoping spread would eventually drop below
  5%. Rejected because the 120s run's actual spread (8.76%) reflects
  irreducible per-bucket sampling noise from dispatch-count jitter at 2-second
  boundaries, not a shrinking thermal transient — no realistic run length
  would have satisfied that threshold, so the check itself needed to change,
  not just the run duration.
