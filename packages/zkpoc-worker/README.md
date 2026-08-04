# @zkpoc/worker

Resource governor and sandboxed shard worker for consented browser compute.
The governor holds the schedule and enforces a verified
[Compute Consent Manifest](https://www.npmjs.com/package/@zkpoc/ccm)'s
resource ceiling by withholding scheduling time; the worker only executes
what it's told and reports *measured* results, never self-granted compute.

Part of [ZK-PoC](https://github.com/DevGurav/zkpoc), a consent-governed,
verifiable browser-compute project. Zero runtime dependencies.

```js
import { Governor, State } from '@zkpoc/worker';

const gov = new Governor({
  workerUrl: new URL('./worker.js', import.meta.url), // re-export @zkpoc/worker/worker
  manifest, verification,   // an already-verified Compute Consent Manifest
  path: 'gpu', matrixN: 256,
});
gov.addEventListener('tick', (e) => updateMeter(e.detail));
await gov.start();   // refuses (returns false) if verification.ok is falsy
```

Four throttle signals — user interaction, dropped frames, a thermal proxy
(sustained throughput decay; no browser exposes real temperature), and
battery discharge — compose multiplicatively, and share control is
**integral, not per-burst**: a burst that overruns its budget is repaid by
the next idle period instead of permanently inflating the session average.
See [ADR-0005](https://github.com/DevGurav/zkpoc/blob/main/docs/adr/0005-integral-share-control.md).

Full API reference (options, events, tuning, `nextIdleMs`'s share-control
law): [API.md](https://github.com/DevGurav/zkpoc/blob/main/packages/zkpoc-worker/API.md).

## Status

Experimental — API surface may still change.

## License

MIT OR Apache-2.0.
