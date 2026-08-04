/**
 * Publisher integration: issue a signed manifest, verify it, run the
 * governed worker session. Wraps `@zkpoc/ccm` + `@zkpoc/worker` into the
 * five-line integration `demo/index.html` does by hand across ~40 lines.
 *
 * WHY RELATIVE IMPORTS, NOT BARE `@zkpoc/...` SPECIFIERS
 * ---------------------------------------------------------
 * This is the first package in the monorepo that depends on another
 * package. Bare specifiers would resolve only after `npm install` created
 * the workspace symlinks in the root `node_modules/` -- but
 * CONTRIBUTING.md's whole point is "no install step" (see its Setup
 * section), and `demo/index.html` already establishes the pattern of
 * cross-package relative imports for exactly this reason. Following it here
 * keeps `node --test` working with nothing installed, same as every other
 * package in this repo.
 *
 * THE SPLIT THIS FILE IS DESIGNED AROUND
 * -----------------------------------------
 * `issueSession()` is pure enough to test headlessly: given real code
 * source strings, it builds, signs, and verifies a manifest with no browser
 * involved (WebCrypto is available in Node). `attachGovernor()` merely
 * constructs a `Governor` -- also safe in Node. Only `Governor.start()`
 * touches a real `Worker`, which Node does not have; that limitation is
 * `@zkpoc/worker`'s, not introduced here, and is already documented in
 * `docs/testing-strategy.md`'s manual-vs-automated split. `runSession()`
 * is the one function in this file that needs a browser, and it says so.
 */

import {
  generateIssuerKey, buildManifest, signManifest, verifyManifest, digest,
} from '../../zkpoc-ccm/index.js';
import { Governor } from '../../zkpoc-worker/src/governor.js';

/**
 * Build, sign, and verify a Compute Consent Manifest for one session.
 *
 * @param {object} o
 * @param {string} o.origin                    publisher origin
 * @param {{worker:string, kernels:{type:string, source:string}[]}} o.code
 * @param {object} o.limits                    cpu_share_max, gpu_share_max,
 *                                              duration_max_s, etc.
 * @param {object} [o.workload]                defaults to ml-inference
 * @param {object} [o.dataAccess]               defaults to fully contained
 * @param {number} [o.ttlSeconds]
 * @param {object} [o.policy]                   the verifier's own limits;
 *                                               omit to skip the policy check
 * @param {{privateKey,publicJwk,keyId}} [o.key] reuse an issuer key instead
 *                                               of minting a fresh one
 * @returns {Promise<{key:object, manifest:object, verification:object}>}
 */
export async function issueSession(o) {
  const key = o.key ?? await generateIssuerKey();

  const workerHash = await digest(o.code.worker);
  const kernelDecls = await Promise.all(
    o.code.kernels.map(async (k) => ({ type: k.type, hash: await digest(k.source) })),
  );

  const manifest = buildManifest({
    origin: o.origin,
    keyId: key.keyId,
    workload: o.workload ?? {
      class: 'ml-inference',
      description: 'quantized GEMM inference shard',
    },
    code: { worker: workerHash, kernels: kernelDecls },
    limits: o.limits,
    dataAccess: o.dataAccess ?? {
      storage: 'none', dom: 'none', sensors: 'none', cookies: 'none',
    },
    ttlSeconds: o.ttlSeconds ?? 900,
  });

  const signed = await signManifest(manifest, key.privateKey);

  const verification = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode: {
      worker: o.code.worker,
      kernels: o.code.kernels.map((k) => k.source),
    },
    policy: o.policy,
  });

  return { key, manifest: signed, verification };
}

/**
 * Construct a `Governor` from an issued session. Not started -- the caller
 * decides when and owns event wiring. Safe to call in Node (construction
 * does not touch `Worker`); `.start()` does and needs a browser.
 *
 * @param {{manifest:object, verification:object}} session
 * @param {object} o
 * @param {URL|string} o.workerUrl
 * @param {'gpu'|'cpu'} [o.path]
 * @param {number} [o.matrixN]
 * @param {object} [o.tuning]
 * @returns {Governor}
 */
export function attachGovernor(session, o) {
  return new Governor({
    workerUrl: o.workerUrl,
    manifest: session.manifest,
    verification: session.verification,
    path: o.path,
    matrixN: o.matrixN,
    tuning: o.tuning,
  });
}

/**
 * The five-line integration: issue, attach, wire handlers, start.
 * Browser-only, because `Governor.start()` needs a real `Worker` -- use
 * `issueSession`/`attachGovernor` directly if you need the headlessly
 * testable pieces on their own (e.g. in a build step or a server-rendered
 * preview of what the manifest will say).
 *
 * If verification fails, the governor is never constructed -- refusal
 * happens at the same point `Governor.start()` itself would refuse, just
 * without paying for a `Worker` that was never going to run.
 *
 * @param {object} o                same shape as issueSession's `o`, plus
 *                                  attachGovernor's `workerUrl`/`path`/etc.
 * @param {object} [handlers]
 * @param {(v:object)=>void} [handlers.onDenied]
 * @param {(t:object)=>void} [handlers.onTick]
 * @param {(t:object)=>void} [handlers.onState]
 * @param {(t:object)=>void} [handlers.onStopped]
 * @param {(d:object)=>void} [handlers.onFallback]
 * @returns {Promise<{session:object, governor:Governor|null}>}
 */
export async function runSession(o, handlers = {}) {
  const session = await issueSession(o);
  if (!session.verification.ok) {
    handlers.onDenied?.(session.verification);
    return { session, governor: null };
  }

  const governor = attachGovernor(session, o);
  if (handlers.onTick) governor.addEventListener('tick', (e) => handlers.onTick(e.detail));
  if (handlers.onState) governor.addEventListener('state', (e) => handlers.onState(e.detail));
  if (handlers.onStopped) governor.addEventListener('stopped', (e) => handlers.onStopped(e.detail));
  if (handlers.onFallback) governor.addEventListener('fallback', (e) => handlers.onFallback(e.detail));

  await governor.start();
  return { session, governor };
}

/**
 * Fetch and hash worker/kernel source from URLs. Browser-only (uses
 * `fetch` against same-origin module files) -- not exercised by this
 * package's own tests, the same manual-verification gap `demo/index.html`'s
 * `loadCode()` already carries. Kept separate from `issueSession` so the
 * headlessly-testable path never depends on `fetch` being available.
 *
 * @param {object} o
 * @param {URL|string} o.workerUrl
 * @param {{type:string, url:URL|string}[]} o.kernels
 * @returns {Promise<{worker:string, kernels:{type:string, source:string}[]}>}
 */
export async function loadCodeFromUrls(o) {
  const worker = await (await fetch(o.workerUrl)).text();
  const kernels = await Promise.all(
    o.kernels.map(async (k) => ({ type: k.type, source: await (await fetch(k.url)).text() })),
  );
  return { worker, kernels };
}
