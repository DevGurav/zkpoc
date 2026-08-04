# ADR-0003: WebGPU is mandatory; WASM-on-CPU is a fallback only

Status: Accepted (2026-08-02)

## Context

The original synopsis treated the compute path (WASM SIMD on CPU vs WebGPU)
as an implementation detail, with WASM as the primary path and WebGPU as a
possible enhancement. `bench/breakeven.py`'s device-tier table shows this is
backwards:

| Device @ 5% share | Value/hr | vs. corrected mining baseline |
| --- | --- | --- |
| Laptop CPU, WASM SIMD | $0.00004 | **~10× worse** |
| Integrated GPU, WebGPU | $0.00042 | roughly at parity |
| Discrete GPU, WebGPU | $0.0025–0.005 | 6–10× better |

WASM-on-CPU at any realistic share is economically *worse* than the corrected
cryptojacking baseline (ADR-0008) — the exact comparison the project exists to
beat. This isn't a close call that better engineering narrows; it's a ~2
order-of-magnitude gap driven by FLOPS/watt, and it held up even after the
first real device measurement corrected the WebGPU-side numbers upward
(ADR-0010).

## Decision

WebGPU is the primary and economically load-bearing compute path. WASM SIMD
on CPU is retained only as:

- a **fallback** when WebGPU is unavailable (`worker.js`'s `init` handler
  falls back and reports `fellBack: true` rather than failing outright), and
- a **lower-bound reference** in benchmarking, explicitly labelled as such
  (`kernels.js`'s `cpuMatmul` docstring, `bench/dispatch_analysis.py`'s CPU
  column).

No further investment goes into optimising the CPU path (e.g. an
AssemblyScript/Rust SIMD kernel) until a use case is identified where WebGPU
is unavailable but the economics still need to close — which, per the table
above, is not expected to happen.

## Consequences

- The CPU kernel in `packages/zkpoc-worker/src/kernels.js` stays a plain JS
  typed-array implementation rather than the originally-planned Rust→WASM
  SIMD kernel. This is a deliberate scope cut, not an oversight — see
  `kernels.js`'s module docstring for the marked seam if it's ever needed.
- Every device-tier benchmark, shard-sizing calculation (ADR-0007's overhead
  amortisation), and break-even figure is WebGPU-specific. A device without
  WebGPU is out of the addressable market for this design, not merely
  disadvantaged within it.
- Browser/platform coverage becomes a real constraint worth tracking:
  WebGPU availability varies by browser, OS, and (per `bench/device/probe.html`'s
  notes) can differ ~50% in throughput between Chrome and Firefox even where
  both support it.
- Alternative considered and rejected: treat WASM and WebGPU as co-equal
  paths and let the broker route shards to whichever is available. Rejected
  because it would let an economically-dead path (WASM-CPU) silently
  participate in aggregate figures, masking rather than surfacing the gap.
