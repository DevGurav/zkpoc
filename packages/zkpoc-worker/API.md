# @zkpoc/worker — API reference

Resource governor and sandboxed shard worker for consented browser compute.
The governor holds the schedule; the worker only executes what it's told and
reports measured results. See
[docs/architecture.md](../../docs/architecture.md) for how this fits with
`@zkpoc/ccm`, and [ADR-0005](../../docs/adr/0005-integral-share-control.md)
for why the share controller is built the way it is.

## `Governor`

```js
import { Governor, State, nextIdleMs } from '@zkpoc/worker';
```

An `EventTarget` that owns one session's worker lifecycle: starting it inside
a verified manifest's limits, enforcing the resource ceiling, applying
back-off, and reporting telemetry.

### `new Governor(options)`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `workerUrl` | `URL \| string` | yes | Path to `worker.js`, loaded as a module Worker. |
| `manifest` | `object` | yes | A Compute Consent Manifest that has **already been verified** — the governor does not call `verifyManifest()` itself. |
| `verification` | `object` | yes | The result of `verifyManifest(manifest, ...)` from `@zkpoc/ccm`. If `verification.ok` is falsy, `start()` returns `false` and the worker never launches. |
| `path` | `'gpu' \| 'cpu'` | no, default `'gpu'` | Which compute path to request. Falls back to `'cpu'` automatically if WebGPU is unavailable (see `fallback` event). |
| `matrixN` | `number` | no, default `256` | Shard matrix size. See `bench/dispatch_analysis.py` for how to choose this against dispatch-overhead amortisation for a given device. |
| `tuning` | `object` | no | Overrides for the internal `DEFAULTS` (see Tuning below). |

The constructor does not start anything — call `start()`.

### Properties (getters, read after `start()`)

| Property | Type | Meaning |
| --- | --- | --- |
| `.state` | `State` | Current lifecycle state — see State enum below. |
| `.declaredShare` | `number` | The manifest's ceiling for the active `path` (`gpu_share_max` or `cpu_share_max`), 0 if none declared. |
| `.targetShare` | `number` | `declaredShare * backoffFactor` — what the controller is actually holding to right now. |
| `.achievedShare` | `number` | `busyMs / wallMs` — the real, measured cumulative share. Compare against `declaredShare`, not `targetShare`, to check ceiling compliance. |
| `.elapsedS` | `number` | Wall-clock seconds since `start()`. |
| `.backoffFactor` | `number` | `(0, 1]` — current multiplicative back-off from the four throttle signals (see below). |
| `.busyMs`, `.shards`, `.flops` | `number` | Cumulative measured work. |
| `.energyMwh` | `number` | **Estimated** energy use (`wattsAtFull × achievedShare × time`) — browsers expose no real power draw; see [ADR-0009](../../docs/adr/0009-energy-counter-not-instant-rate.md) for how to measure `wattsAtFull` for a real device. |
| `.actualPath` | `'gpu' \| 'cpu' \| null` | The path actually running, which may differ from the requested `path` after a fallback. |
| `.denialReason` | `string \| null` | Set when `state === State.DENIED`. |

### Methods

#### `async start(): Promise<boolean>`

Verifies `verification.ok` and `declaredShare > 0` before doing anything else
— if either fails, transitions to `State.DENIED`, sets `.denialReason`, and
returns `false` without ever constructing a `Worker`. This is the entire
enforcement contract: a manifest that didn't verify does not get to run,
independent of what it claims about itself.

On success: spins up the `Worker`, initialises it (`path`, `matrixN`),
starts battery/interaction/frame monitoring, transitions to
`State.RUNNING`, and begins the burst loop (not awaited — runs until
stopped). Returns `true`.

#### `revoke(): void`

User-initiated stop. Sets state to `State.REVOKED` and **terminates the
worker immediately** — does not wait for the current burst to finish. This
is deliberate: a revocation that waits for an in-flight unit of work isn't
really instant, and instant is the property a "stop taking my compute right
now" control needs.

#### `stop(): void`

Same immediate-termination behaviour as `revoke()`, but sets
`State.STOPPED` — for programmatic/system-initiated stops (expiry, battery
floor) rather than user action. Internally, expiry and battery-floor
conditions call this via `_finish()`.

#### `async sampleResult(): Promise<object | null>`

Asks the worker for its current shard result and compares it against an
independently-computable reference value (`referenceC00()` from
`kernels.js`). Returns `null` if no worker is running, otherwise:

```js
{ value, expected, shards, relError, correct }  // correct: relError < 1e-3
```

Exists so a page can spot-check that work is actually happening correctly,
rather than trusting the worker's self-report of busy time alone.

#### `telemetry(): object`

Synchronous snapshot of everything above, plus frame/battery/thermal detail.
This is the payload attached to every `tick`, `state`, and `stopped` event —
call it directly if you need a snapshot outside an event handler.

### Events

All are `CustomEvent`s with `.detail` set as noted.

| Event | `.detail` | Fired when |
| --- | --- | --- |
| `'tick'` | `telemetry()` | Every `cfg.tickMs` (default 250ms) while running. |
| `'state'` | `telemetry()` | On every state transition. |
| `'stopped'` | `telemetry()` | On any terminal transition (`STOPPED`, `REVOKED`, `EXPIRED`, `DENIED`). |
| `'fallback'` | `{ path: 'cpu', fellBack: true, reason: string }` | When `init` requested `'gpu'` but WebGPU was unavailable in the worker. |
| `'error'` | `string` | When a burst call to the worker throws; the governor stops immediately afterward. |

### `State` enum

```js
State.IDLE | RUNNING | PREEMPTED | BACKOFF | STOPPED | REVOKED | EXPIRED | DENIED
```

`PREEMPTED` = user interacted recently, work is fully paused.
`BACKOFF` = running, but `backoffFactor < 1` from frame/thermal/battery
signals. `DENIED` is terminal and only reachable from `start()` — verification
or share-declaration failure.

### Throttle signals and back-off

Four signals modulate `backoffFactor` **multiplicatively** each cycle
(`_updateBackoff()`), so e.g. a hot device on battery while the user is
scrolling ends up quieter than any single signal would produce alone:

| Signal | Trigger | Effect |
| --- | --- | --- |
| Interaction | Any of `pointerdown/pointermove/keydown/wheel/scroll/touchstart` within `cfg.interactionQuietMs` (400ms) | Full preemption — burst loop pauses entirely, not just backed off |
| Frame health | `longFrames / totalFrames` over the session | `>10%` → ×0.5, `>3%` → ×0.75 |
| Thermal proxy | Sustained throughput vs. a rolling baseline (`cfg.thermalWindow` bursts) drops below `cfg.thermalTripRatio` (80%) | ×0.6 while triggered |
| Battery | Discharging (not charging) | `<40%` → ×0.5, else ×0.75 |

There is no browser API for temperature; the "thermal" signal is a proxy
based on measured throughput decay, which is the same category of signal
[ADR-0010](../../docs/adr/0010-sustained-trend-fit-not-quick-sweep.md) had to
build a proper trend fit for at the measurement-tooling level — the governor's
version is a simpler rolling-average heuristic, not the OLS fit used in
`bench/device/probe.html`.

### `nextIdleMs(busyTotalMs, wallElapsedMs, targetShare, maxIdleMs = 2000): number`

The share-control law, exported standalone so it can be tested (and reused)
without a `Governor` instance — see
[ADR-0005](../../docs/adr/0005-integral-share-control.md) and
`test/share-control.test.js`. Returns how long to idle, in ms, to make
cumulative `busy/wall` equal `targetShare`. Integral: repays overshoot from a
previous burst rather than only reacting to the current one.

### Tuning defaults

Override via the `tuning` constructor option; all keys optional.

```js
{
  burstMs: 12,              // work requested per burst — ~1 frame
  tickMs: 250,              // telemetry event cadence
  interactionQuietMs: 400,  // ms to stay preempted after last input
  longFrameMs: 50,          // a frame this slow counts as "dropped"
  thermalWindow: 8,         // bursts averaged for the thermal proxy
  thermalTripRatio: 0.80,   // throughput floor (fraction of baseline)
  batteryFloor: 0.20,       // stop outright below this charge level
  wattsAtFull: 25,          // for the energy ESTIMATE only — not measured
}
```

---

## Worker message protocol

`worker.js` runs as a module Worker and speaks a simple `postMessage`
request/response protocol. **You should not need to talk to it directly** —
`Governor` owns this — but it's documented here because the protocol is the
actual sandbox boundary: everything the worker is capable of doing is
expressed in these four message types, and nothing else.

Every message: `{ id: number, type: string, payload: object }`.
Every reply: `{ id, ok: boolean, ...data }` — `ok: false` replies include
`{ error: string }`.

| `type` | `payload` | Success reply | Behaviour |
| --- | --- | --- | --- |
| `'init'` | `{ n: number, path: 'gpu'\|'cpu' }` | `{ path, fellBack: boolean }` | Allocates buffers/pipeline for the given matrix size and path. Falls back to CPU (reporting `fellBack: true`) rather than throwing if WebGPU is requested but unavailable. |
| `'burst'` | `{ budgetMs: number }` | `{ busyMs, shardsDone, flops }` | Executes shards in a tight loop until `budgetMs` elapses (capped at 64 shards/burst) or one has run. **`busyMs` is measured, not the requested budget** — the governor's share accounting depends on this being real. |
| `'sample'` | `{}` | `{ value, expected, shards }` | Reads back `C[0][0]` from the current shard buffers plus the independently-computable reference value. |
| `'stop'` | `{}` | `{ stopped: true, shards }` | Destroys the GPU device (if any) and releases buffers. |

The worker never initiates a message and never decides its own schedule — it
only responds to `burst` requests with whatever budget it's given. This is
what makes the share ceiling enforceable: a compromised kernel can return
wrong *values*, but it cannot grant itself more scheduling time, because it
never controls when it's called.

---

## `kernels.js`

Shard computation kernels. Exported as source (not compiled/bundled) because
the Compute Consent Manifest binds a SHA-256 hash of exactly these bytes —
anything that rewrites the source between hashing and execution breaks the
binding, which is the property [ADR-0002](../../docs/adr/0002-legitimacy-by-declaration-not-detection.md)
depends on.

| Export | Signature | Purpose |
| --- | --- | --- |
| `MATMUL_WGSL` | `string` | Tiled fp32 GEMM compute shader (WGSL), 16×16 workgroups. |
| `shardMatrix(n, seed=0)` | `(number, number) => Float32Array` | Deterministic shard input — same `(n, seed)` always produces the same matrix, so any party can recompute and check a result. |
| `cpuMatmul(n, A, B, C)` | mutates `C` in place | Blocked fp32 GEMM in plain JS. **Not the WASM SIMD kernel the design calls for** — see [ADR-0003](../../docs/adr/0003-webgpu-mandatory.md) for why that build was scoped out, and why it doesn't matter economically. |
| `flopsPerShard(n)` | `number => number` | `2n³` — FLOP count for one `n×n` GEMM. |
| `referenceC00(n, seedA=0, seedB=0)` | `(number, number, number) => number` | Closed-form value of `C[0][0]` for the deterministic inputs above, computed independently of `cpuMatmul`/the WGSL kernel — this is what `sampleResult()` checks against. |

The kernel is a stand-in for a quantized ONNX inference shard: GEMM is where
inference actually spends its time, and unlike an opaque black-box kernel it
has an exactly checkable result, which is what makes `sampleResult()` and the
demo's tamper-panel result verification possible at all.
