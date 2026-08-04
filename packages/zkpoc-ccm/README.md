# @zkpoc/ccm

Compute Consent Manifest — a signed, machine-readable declaration of what a
page intends to compute on a visitor's device: which workload, how much of
the machine, for how long, and what it may touch. Verifiable by a party who
trusts neither the publisher nor the broker.

Part of [ZK-PoC](https://github.com/DevGurav/zkpoc), a consent-governed,
verifiable browser-compute project. Zero runtime dependencies.

```js
import { generateIssuerKey, buildManifest, signManifest, verifyManifest, digest } from '@zkpoc/ccm';

const key = await generateIssuerKey();
const manifest = buildManifest({
  origin: 'https://publisher.example',
  keyId: key.keyId,
  workload: { class: 'ml-inference', description: 'quantized GEMM inference shard' },
  code: { worker: await digest(workerSource), kernels: [{ type: 'wgsl', hash: await digest(kernelSource) }] },
  limits: {
    cpu_share_max: 0.05, gpu_share_max: 0.05, duration_max_s: 360,
    network: { egress_bytes_max: 1048576, allowed_origins: [] },
  },
  dataAccess: { storage: 'none', dom: 'none', sensors: 'none', cookies: 'none' },
});
const signed = await signManifest(manifest, key.privateKey);

const verification = await verifyManifest(signed, {
  publicJwk: key.publicJwk,
  loadedCode: { worker: workerSource, kernels: [kernelSource] },
});
// verification.ok, verification.checks -- eight independent checks, each reported by name
```

## Why declaration, not detection

Covert in-browser compute cannot be reliably detected — WASM binary
diversification evades the MINOS detector in **100%** of cases and
VirusTotal in ~90% (arXiv:2403.15197). A detector a miner can evade
completely cannot certify a *legitimate* workload isn't one either. So
legitimacy here is **asserted and bound** — code hashes, enforceable
limits, a containment scope — not inferred from behavior.

Full format spec, hard caps, and the verification-check table:
[SPEC.md](https://github.com/DevGurav/zkpoc/blob/main/packages/zkpoc-ccm/SPEC.md).
Reference resource governor that enforces a verified manifest at runtime:
[`@zkpoc/worker`](https://www.npmjs.com/package/@zkpoc/worker).

## Status

Experimental. `zkpoc-ccm/1` is not stable and is expected to change.

## License

MIT OR Apache-2.0.
