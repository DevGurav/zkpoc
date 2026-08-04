# Device tiers — where the placeholder numbers come from

`DEFAULT_TIERS` in `bench/breakeven.py` carries `flops_gflops` and `watts_full`
for six device classes. **Every one is a placeholder** until real probe data
lands in `bench/device/measurements/`. This file records how each was derived
so the estimates can be argued with, and so it is obvious what changes when
measurements arrive.

## Method

`flops_gflops` is *achievable through the browser*, not silicon peak. Two
haircuts are applied to vendor figures:

1. **API efficiency.** WebGPU compute reaches roughly 40–60% of native CUDA/Metal
   on tiled GEMM workloads. WASM SIMD reaches roughly 30–50% of native AVX2.
2. **fp32, not tensor.** Consumer marketing figures usually quote tensor/fp16
   throughput. The kernel in `probe.html` is fp32 GEMM, so fp32 rates are used.

`watts_full` is the *marginal* power draw at 100% share — the delta above idle,
not total system power. This matters: the break-even model subtracts electricity
from compute value, and using total draw would overstate the cost.

## The tiers

| Tier | Path | GFLOPS | Watts | Basis |
| --- | --- | --- | --- | --- |
| `desktop-dgpu` | webgpu | 5000 | 180 | Mid-range desktop card, ~13 TFLOPS fp32 peak × ~40% API efficiency. Marginal draw dominated by the GPU under sustained load. |
| `laptop-dgpu` | webgpu | 5000 | 80 | Comparable silicon to the desktop tier but power-limited; same throughput at roughly half the marginal draw. |
| `laptop-igpu` | webgpu | **107.2** | **9.1** | **FULLY MEASURED** — Intel Gen-12LP (Iris Xe): F(d) from a 120s sustained N=1024 run, watts from WMI energy-counter differencing. First tier with no placeholder left. See below. |
| `laptop-cpu` | wasm-simd | 80 | 20 | ~200 GFLOPS AVX2 across cores × ~40% for WASM SIMD. |
| `mobile-gpu` | webgpu | 300 | 6 | Recent phone GPU, aggressively thermally limited in sustained use. |
| `mobile-cpu` | wasm-simd | 15 | 4 | Phone CPU under WASM SIMD, sustained rather than burst. |

## What the first real measurement changed

One tier is now **fully** measured — both F(d) and watts — for Intel Gen-12LP
(Iris Xe), Chrome 150, Windows. Getting there took two passes, and the second
pass overturned a conclusion the first pass looked confident about. Worth
reading both, because the failure mode in the middle is exactly the kind of
thing that produces a wrong number with a straight face.

### Pass 1 (7-rep quick sweep): 75.4 GFLOPS — wrong, and confidently so

The placeholder was 850 GFLOPS. A first measurement, sweeping N=256/512/1024
at 7 reps each, gave a "sustained" figure of 75.4 GFLOPS — 11× lower — and the
run's own samples decayed monotonically within every size (1.36× at N=1024, up
to 2.26× at N=256), which read as textbook thermal throttling: an integrated
GPU shares package power with the CPU, turbo is spent first, the clock settles.
Two real findings survived from this pass:

1. **Dispatch overhead is real and separable.** Fitting
   `t(N) = overhead + 2N³/throughput` across the three sizes gives a **fixed
   4.0 ms per-dispatch cost** and a **92.6 GFLOPS regression-fit throughput**.
   At N=256 that overhead is 91.6% of measured time — a small shard measures
   the `onSubmittedWorkDone()` fence, not the device. This holds regardless of
   what follows below, and it sets the shard-sizing floor
   (`python bench/dispatch_analysis.py`).
2. **The API-efficiency haircut in the original placeholder was too
   generous** — 850 GFLOPS assumed ~50% of peak; even the corrected figure
   below is closer to 6%.

### Pass 2 (120s sustained run): 107.2 GFLOPS, flat — the "decay" was warmup

A genuine 120-second sustained run at N=1024, bucketed every 2 seconds,
tells a different story. Throughput climbs from 57.5 to ~105 GFLOPS over the
**first ~16 seconds**, then holds: an OLS trend fit over the remaining 96
seconds gives a slope of **+2.4%/min**, statistically indistinguishable from
flat (tail stdev 4.08 GFLOPS on a mean of 107.2, i.e. 3.8% CV — consistent
with per-bucket dispatch-count jitter, not a real trend).

**The 7-rep run never got past the warmup ramp.** Seven dispatches at N=1024
is ~200 ms of GPU work; the 16-second warmup alone is 80× that. What looked
like thermal decay in Pass 1 was the tail end of a cold-start ramp, sampled
too briefly to see it finish. The hypothesis that this device throttles down
under sustained WebGPU load is **not supported** by 120 seconds of real data —
if anything the trend is very slightly positive.

This is why `bench/device/probe.html`'s plateau detector was rewritten from a
spread threshold (flagged this exact run as "not plateaued" at 8.76% spread)
to an OLS trend fit that separates *noisy-but-flat* from *genuinely
declining*. A spread threshold cannot make that distinction; a trend can.

### The watts side, and the verdict

Marginal draw was measured via WMI energy-counter differencing
(`bench/power/`): **9.1 W**, from a baseline that itself needed a dedicated
settle phase — the first attempt showed idle drifting 17 W → 34 W over three
minutes as the machine wound down from being touched, which would have
swamped the entire signal. See `bench/power/README.md` for why settling
matters and how it's detected.

With F(d) = 107.2 GFLOPS (up from the wrong 75.4), the break-even wattage `W*`
rises to **5.6 W** (up from 3.9 W). Measured draw is 9.1 W. **The tier remains
uneconomic at every share** — the conclusion from Pass 1 survives, but now on
numbers that are actually right rather than numbers that happened to point the
same direction for the wrong reason.

### What this means for the other five tiers

They are still placeholders, and this episode is a caution rather than a
license to trust them less arbitrarily. The FLOPS placeholder was wrong by
11× in one direction (too optimistic); the *decay* story built on top of a
too-short measurement was wrong in a way that would have made the placeholder
look "roughly corroborated" if the investigation had stopped after Pass 1.
Neither error announces itself — both produced clean-looking numbers. The only
fix is the one applied here: measure sustained, not quick; fit a trend, don't
eyeball a spread; and treat any single short run as a hypothesis, not a
result.

## Known weaknesses

These are the places the placeholders are most likely wrong, in rough order of
how much they would move the break-even surface.

- **Sustained vs burst is not modelled.** All figures are nominally sustained,
  but thermal throttling on laptops and phones can halve throughput within
  60–90 seconds. The probe's duty-cycle mode exists partly to expose this;
  a 5% duty cycle may sustain far better than the 100% number implies, which
  would help the low-share end of the surface.
- **`desktop-dgpu` and `laptop-dgpu` share a GFLOPS figure.** Deliberate, to
  isolate the effect of power draw — and it produces a genuinely
  counter-intuitive result, that the laptop tier is *more* economic than the
  desktop because energy cost scales with watts while revenue scales with
  FLOPS. If that survives measurement it is worth reporting on its own.
- **Cross-browser variance is not represented.** In-browser proving is reported
  at roughly 50% slower on Firefox than Chrome; the compute path is likely to
  show similar spread. Tiers should eventually split by engine.
- **fp16 / WebNN / NPU paths are ignored.** A quantized ONNX workload would
  realistically use int8 or fp16, where consumer silicon is several times
  faster than the fp32 rates above. This is the most likely source of *upward*
  revision, and the one most worth chasing — the break-even surface misses the
  5% ceiling by only 1.3×, so a 2× throughput gain on the right tier would
  close it.
- **`watts_full` is the least defensible column.** Marginal draw under a
  browser compute load is not published anywhere useful and genuinely needs
  host-side measurement. It cannot be probed from JS.

## Replacing them

Open `bench/device/probe.html` on the target device, run it, save the JSON to
`bench/device/measurements/<tier-name>.json`, and add a `watts_full` key from
host-side instrumentation. `bench/breakeven.py` picks it up on the next run and
drops the placeholder flag for that tier.
