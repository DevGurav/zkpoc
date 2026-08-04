/**
 * Integration test for the flow demo/index.html actually performs.
 *
 * The demo hashes the worker source *as it exists on disk* and binds that hash
 * into the manifest. Testing against a fixture string would defeat the point,
 * so this reads the real files. If someone edits the worker without reissuing,
 * this test fails -- which is precisely the property the code binding is meant
 * to have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  generateIssuerKey, buildManifest, signManifest, verifyManifest, digest,
} from '../index.js';
import { MATMUL_WGSL } from '../../zkpoc-worker/src/kernels.js';

const workerPath = fileURLToPath(
  new URL('../../zkpoc-worker/src/worker.js', import.meta.url));

async function realCode() {
  return { worker: await readFile(workerPath, 'utf8'), kernels: [MATMUL_WGSL] };
}

async function issueForDemo(share = 0.05) {
  const code = await realCode();
  const key = await generateIssuerKey();
  const manifest = buildManifest({
    origin: 'https://publisher.example',
    keyId: key.keyId,
    workload: { class: 'ml-inference', description: 'quantized GEMM inference shard' },
    code: {
      worker: await digest(code.worker),
      kernels: [{ type: 'wgsl', hash: await digest(MATMUL_WGSL) }],
    },
    limits: {
      cpu_share_max: share, gpu_share_max: share,
      duration_max_s: 360, energy_max_mwh: 40,
      network: { egress_bytes_max: 1048576, allowed_origins: ['https://broker.example'] },
    },
    dataAccess: { storage: 'none', dom: 'none', sensors: 'none', cookies: 'none' },
    ttlSeconds: 900,
  });
  return { key, code, signed: await signManifest(manifest, key.privateKey) };
}

test('demo flow: a freshly issued manifest verifies against the real worker', async () => {
  const { key, code, signed } = await issueForDemo();
  const v = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode: code,
    policy: {
      cpu_share_max: 0.5, gpu_share_max: 0.5, duration_max_s: 600,
      require_data_access: { storage: 'none', dom: 'none' },
    },
  });
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('demo flow: every tamper button is actually detected', async () => {
  const { key, code, signed } = await issueForDemo();

  // Mirrors the TAMPERS table in demo/index.html.
  const tampers = {
    share:    (m) => { m.limits.gpu_share_max = 0.9; m.limits.cpu_share_max = 0.9; },
    duration: (m) => { m.limits.duration_max_s = 3000; },
    storage:  (m) => { m.data_access.storage = 'persistent'; },
    code:     (m) => { m.code.kernels[0].hash = 'sha256-' + 'A'.repeat(43) + '='; },
    expiry:   (m) => { m.session.expires_at = '2099-01-01T00:00:00.000Z'; },
  };

  for (const [name, mutate] of Object.entries(tampers)) {
    const t = structuredClone(signed);
    mutate(t);
    const v = await verifyManifest(t, { publicJwk: key.publicJwk, loadedCode: code });
    assert.equal(v.ok, false, `tamper "${name}" was NOT detected`);
    assert.ok(v.checks.some((c) => !c.ok),
      `tamper "${name}" produced no failing check`);
  }
});

test('demo flow: a validly signed manifest cannot cover for different served code', async () => {
  // The attack a signature cannot see: the publisher signs an honest manifest
  // and ships something else. Nothing is forged, so ECDSA is perfectly happy.
  // This is the case the code binding exists for, and the only one that
  // demonstrates it does independent work.
  const { key, signed } = await issueForDemo();
  const code = await realCode();

  const v = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode: { worker: code.worker + '\n// silently injected', kernels: code.kernels },
  });

  assert.equal(v.ok, false, 'served-code substitution was not detected');
  assert.equal(v.checks.find((c) => c.name === 'signature').ok, true,
    'the signature should still verify — nothing in the manifest was altered');
  assert.equal(v.checks.find((c) => c.name === 'code.worker').ok, false,
    'the code binding should be the check that catches this');

  // And the binding must be the ONLY thing that objects, otherwise the test
  // is passing for an unrelated reason.
  const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['code.worker'],
    `expected only code.worker to fail, got: ${failed.join(', ')}`);
});

test('demo flow: the worker source does not reach for the DOM', async () => {
  // data_access.dom = "none" is claimed structurally (a Worker has no DOM).
  // This is a cheap guard that the claim stays honest as the file evolves.
  const src = await readFile(workerPath, 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['document.', 'window.', 'localStorage', 'sessionStorage',
                           'indexedDB', 'document.cookie']) {
    assert.ok(!stripped.includes(forbidden),
      `worker.js references ${forbidden}, contradicting data_access`);
  }
});

test('demo flow: a manifest issued for 5% cannot silently authorise more', async () => {
  const { key, code, signed } = await issueForDemo(0.05);
  // A user policy stricter than the manifest must reject it...
  const strict = await verifyManifest(signed, {
    publicJwk: key.publicJwk, loadedCode: code, policy: { gpu_share_max: 0.01 },
  });
  assert.equal(strict.ok, false);
  assert.ok(strict.errors.some((e) => e.includes('gpu_share_max')));

  // ...while the declared value itself is what the governor will cap at.
  assert.equal(signed.limits.gpu_share_max, 0.05);
});
