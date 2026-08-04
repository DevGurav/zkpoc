import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../zkpoc-ccm/index.js';
import { MATMUL_WGSL } from '../../zkpoc-worker/src/kernels.js';
import { issueSession, attachGovernor, runSession } from '../index.js';

// Real source, not fixtures -- the same discipline demo-flow.test.js uses,
// since the whole point of code binding is hashing what actually runs.
const WORKER_SOURCE = '// pretend worker.js source for SDK integration tests\n';

function baseOptions(overrides = {}) {
  return {
    origin: 'https://publisher.example',
    code: { worker: WORKER_SOURCE, kernels: [{ type: 'wgsl', source: MATMUL_WGSL }] },
    limits: {
      cpu_share_max: 0.05, gpu_share_max: 0.05, duration_max_s: 360,
      network: { egress_bytes_max: 1048576, allowed_origins: ['https://broker.example'] },
    },
    ...overrides,
  };
}

test('issueSession wires buildManifest/signManifest/verifyManifest into a verified session', async () => {
  const { manifest, verification } = await issueSession(baseOptions());
  assert.equal(verification.ok, true, JSON.stringify(verification.errors));
  assert.equal(manifest.code.worker, await digest(WORKER_SOURCE));
  assert.equal(manifest.code.kernels[0].hash, await digest(MATMUL_WGSL));
  assert.equal(manifest.limits.cpu_share_max, 0.05);
});

test('issueSession reuses a supplied key instead of minting a fresh one', async () => {
  const { key: key1 } = await issueSession(baseOptions());
  const { key: key2, manifest } = await issueSession(baseOptions({ key: key1 }));
  assert.equal(key2, key1);
  assert.equal(manifest.issuer.key_id, key1.keyId);
});

test('issueSession reports a policy violation without touching structure or signature', async () => {
  const { verification } = await issueSession(baseOptions({
    policy: { cpu_share_max: 0.01, gpu_share_max: 0.01, duration_max_s: 600 },
  }));
  assert.equal(verification.ok, false);
  const failed = verification.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['policy']);
});

test('attachGovernor constructs a Governor wired to the issued session, unstarted', async () => {
  const session = await issueSession(baseOptions());
  const workerUrl = 'https://publisher.example/worker.js';
  const governor = attachGovernor(session, { workerUrl, path: 'cpu', matrixN: 128 });
  assert.equal(governor.manifest, session.manifest);
  assert.equal(governor.verification, session.verification);
  assert.equal(governor.workerUrl, workerUrl);
  assert.equal(governor.path, 'cpu');
  assert.equal(governor.matrixN, 128);
  assert.equal(governor.worker, null, 'construction must not start a real Worker');
});

test('runSession refuses and never constructs a governor when verification fails', async () => {
  let denied = null;
  const { session, governor } = await runSession(
    baseOptions({ policy: { cpu_share_max: 0.01, gpu_share_max: 0.01, duration_max_s: 600 } }),
    { onDenied: (v) => { denied = v; } },
  );
  assert.equal(governor, null);
  assert.equal(session.verification.ok, false);
  assert.equal(denied, session.verification, 'onDenied must receive the actual verification result');
});
