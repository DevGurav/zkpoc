import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize } from '../src/canonical.js';
import { validateStructure, checkAgainstPolicy, HARD_CAPS } from '../src/schema.js';
import {
  generateIssuerKey, buildManifest, signManifest, verifySignature,
  verifyManifest, digest, jwkThumbprint,
} from '../src/ccm.js';

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

const WORKER_SRC = 'self.onmessage = () => {/* zkpoc worker stand-in */};';
const KERNEL_SRC = '@compute @workgroup_size(16,16) fn main() {}';

async function makeSigned(overrides = {}) {
  const key = await generateIssuerKey();
  const manifest = buildManifest({
    origin: 'https://publisher.example',
    keyId: key.keyId,
    workload: { class: 'ml-inference', description: 'quantized resnet shard' },
    code: {
      worker: await digest(WORKER_SRC),
      kernels: [{ type: 'wgsl', hash: await digest(KERNEL_SRC) }],
    },
    limits: {
      cpu_share_max: 0.05,
      gpu_share_max: 0.05,
      duration_max_s: 360,
      energy_max_mwh: 40,
      network: {
        egress_bytes_max: 1048576,
        allowed_origins: ['https://broker.example'],
      },
    },
    dataAccess: { storage: 'none', dom: 'none', sensors: 'none', cookies: 'none' },
    ...overrides,
  });
  return { key, manifest, signed: await signManifest(manifest, key.privateKey) };
}

const loadedCode = { worker: WORKER_SRC, kernels: [KERNEL_SRC] };

// --------------------------------------------------------------------------
// canonicalisation
// --------------------------------------------------------------------------

test('canonicalize is independent of key insertion order', () => {
  const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
  const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), '{"a":2,"b":1,"c":{"y":4,"z":3}}');
});

test('canonicalize sorts by UTF-16 code unit, not locale', () => {
  // "Z" (0x5A) must sort before "a" (0x61); localeCompare would disagree.
  assert.equal(canonicalize({ a: 1, Z: 2 }), '{"Z":2,"a":1}');
});

test('canonicalize rejects unrepresentable values rather than dropping them', () => {
  assert.throws(() => canonicalize({ x: NaN }), /not serialisable/);
  assert.throws(() => canonicalize({ x: Infinity }), /not serialisable/);
  assert.throws(() => canonicalize({ x: undefined }), /undefined value/);
  assert.throws(() => canonicalize({ x: () => {} }), /function/);
  assert.throws(() => canonicalize({ x: 10n }), /bigint/);
});

test('canonicalize detects cycles', () => {
  const o = { a: 1 };
  o.self = o;
  assert.throws(() => canonicalize(o), /circular/);
});

test('canonicalize normalises -0 and escapes strings', () => {
  assert.equal(canonicalize({ z: -0 }), '{"z":0}');
  assert.equal(canonicalize({ s: 'a"b\n' }), '{"s":"a\\"b\\n"}');
});

// --------------------------------------------------------------------------
// signing
// --------------------------------------------------------------------------

test('sign/verify round trip', async () => {
  const { key, signed } = await makeSigned();
  assert.equal(signed.sig.alg, 'ECDSA-P256-SHA256');
  assert.equal(await verifySignature(signed, key.publicJwk), true);
});

test('signature survives key reordering but not mutation', async () => {
  const { key, signed } = await makeSigned();

  // Reordering keys must NOT invalidate: that is the whole point of JCS.
  const reordered = JSON.parse(JSON.stringify(signed));
  const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
  assert.equal(await verifySignature(shuffled, key.publicJwk), true);

  // Raising the resource ceiling must invalidate.
  const tampered = structuredClone(signed);
  tampered.limits.cpu_share_max = 0.9;
  assert.equal(await verifySignature(tampered, key.publicJwk), false);
});

test('every field is covered by the signature', async () => {
  const { key, signed } = await makeSigned();
  const mutations = [
    (m) => { m.limits.duration_max_s = 3600; },
    (m) => { m.data_access.storage = 'persistent'; },
    (m) => { m.code.worker = 'sha256-' + 'A'.repeat(43) + '='; },
    (m) => { m.limits.network.allowed_origins.push('https://evil.example'); },
    (m) => { m.workload.class = 'ml-training'; },
    (m) => { m.session.expires_at = '2099-01-01T00:00:00.000Z'; },
    (m) => { m.issuer.origin = 'https://evil.example'; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const t = structuredClone(signed);
    mutate(t);
    assert.equal(await verifySignature(t, key.publicJwk), false,
                 `mutation ${i} was not covered by the signature`);
  }
});

test('a different issuer key does not verify', async () => {
  const { signed } = await makeSigned();
  const other = await generateIssuerKey();
  assert.equal(await verifySignature(signed, other.publicJwk), false);
});

// --------------------------------------------------------------------------
// full third-party verification
// --------------------------------------------------------------------------

test('verifyManifest accepts a good manifest with matching code', async () => {
  const { key, signed } = await makeSigned();
  const r = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode,
    policy: { cpu_share_max: 0.05, duration_max_s: 600 },
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.checks.find((c) => c.name === 'signature').ok, true);
  assert.equal(r.checks.find((c) => c.name === 'key_binding').ok, true);
  assert.equal(r.checks.find((c) => c.name === 'code.worker').ok, true);
});

test('code binding catches declare-one-thing-ship-another', async () => {
  const { key, signed } = await makeSigned();
  const r = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode: { worker: WORKER_SRC + '\n/* miner */', kernels: [KERNEL_SRC] },
  });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name === 'code.worker');
  assert.equal(c.ok, false);
  assert.match(c.detail, /loaded worker hashes to/);
});

test('code binding catches a swapped kernel', async () => {
  const { key, signed } = await makeSigned();
  const r = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode: { worker: WORKER_SRC, kernels: ['@compute fn main(){ /* mine */ }'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((x) => x.name === 'code.kernels[0]').ok, false);
});

test('code binding catches an extra undeclared kernel', async () => {
  const { key, signed } = await makeSigned();
  const r = await verifyManifest(signed, {
    publicJwk: key.publicJwk,
    loadedCode: { worker: WORKER_SRC, kernels: [KERNEL_SRC, 'extra'] },
  });
  assert.equal(r.ok, false);
  assert.match(r.checks.find((x) => x.name === 'code.kernels').detail,
               /2 kernels loaded, 1 declared/);
});

test('omitting loaded code is reported as unverified, not as a pass', async () => {
  const { key, signed } = await makeSigned();
  const r = await verifyManifest(signed, { publicJwk: key.publicJwk });
  assert.equal(r.ok, false);
  assert.match(r.checks.find((c) => c.name === 'code_binding').detail,
               /unverified against what runs/);
});

test('expired manifests are rejected', async () => {
  const { key, signed } = await makeSigned({ ttlSeconds: 1 });
  const later = new Date(Date.parse(signed.session.expires_at) + 1000);
  const r = await verifyManifest(signed, {
    publicJwk: key.publicJwk, loadedCode, now: later,
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === 'validity_window').detail, 'expired');
});

test('nonce replay is detected across sessions', async () => {
  const { key, signed } = await makeSigned();
  const seen = new Set();
  const opts = () => ({ publicJwk: key.publicJwk, loadedCode, seenNonces: seen });

  const first = await verifyManifest(signed, opts());
  assert.equal(first.checks.find((c) => c.name === 'nonce_freshness').ok, true);

  const second = await verifyManifest(signed, opts());
  assert.equal(second.ok, false);
  assert.equal(second.checks.find((c) => c.name === 'nonce_freshness').ok, false);
});

test('key_binding catches a manifest naming someone else\'s key', async () => {
  const key = await generateIssuerKey();
  const impostor = await generateIssuerKey();
  const m = buildManifest({
    origin: 'https://publisher.example',
    keyId: impostor.keyId,                       // claims another party's id
    workload: { class: 'ml-inference', description: 'quantized resnet shard' },
    code: { worker: await digest(WORKER_SRC),
            kernels: [{ type: 'wgsl', hash: await digest(KERNEL_SRC) }] },
    limits: {
      cpu_share_max: 0.05, gpu_share_max: 0.05, duration_max_s: 360,
      network: { egress_bytes_max: 1024, allowed_origins: ['https://broker.example'] },
    },
    dataAccess: { storage: 'none', dom: 'none', sensors: 'none', cookies: 'none' },
  });
  const signed = await signManifest(m, key.privateKey);

  const r = await verifyManifest(signed, { publicJwk: key.publicJwk, loadedCode });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === 'key_binding').ok, false);
});

// --------------------------------------------------------------------------
// structure and policy
// --------------------------------------------------------------------------

test('structure validation reports all problems at once', () => {
  const r = validateStructure({ v: 'wrong', issuer: {}, workload: {} });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 4, 'expected several errors, got ' + r.errors.length);
  assert.ok(r.errors.some((e) => e.includes('zkpoc-ccm/1')));
});

test('a manifest the user cannot revoke is invalid', async () => {
  const { signed } = await makeSigned();
  const t = structuredClone(signed);
  t.revocation.user_revocable = false;
  const r = validateStructure(t);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('user_revocable')));
});

test('hard caps reject an absurd manifest even if well-formed', async () => {
  const { signed } = await makeSigned();
  const t = structuredClone(signed);
  t.limits.cpu_share_max = 0.99;
  t.limits.duration_max_s = HARD_CAPS.duration_max_s + 1;
  const r = validateStructure(t);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('cpu_share_max')));
  assert.ok(r.errors.some((e) => e.includes('duration_max_s')));
});

test('policy is the user\'s, and is checked separately from structure', async () => {
  const { signed } = await makeSigned();
  // Structurally fine, but asks for more than this user allows.
  assert.equal(validateStructure(signed).ok, true);

  const strict = checkAgainstPolicy(signed, {
    cpu_share_max: 0.01,
    require_data_access: { storage: 'none' },
    allowed_origins: ['https://trusted.example'],
  });
  assert.equal(strict.ok, false);
  assert.ok(strict.errors.some((e) => e.includes('cpu_share_max')));
  assert.ok(strict.errors.some((e) => e.includes('not in the policy allow-list')));

  const lenient = checkAgainstPolicy(signed, { cpu_share_max: 0.05 });
  assert.equal(lenient.ok, true);
});

test('policy catches a manifest asking for more data access than allowed', async () => {
  const { signed } = await makeSigned();
  const t = structuredClone(signed);
  t.data_access.storage = 'persistent';
  const r = checkAgainstPolicy(t, { require_data_access: { storage: 'session' } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /declares "persistent".*at most "session"/);
});

test('jwkThumbprint is stable and key-specific', async () => {
  const a = await generateIssuerKey();
  const b = await generateIssuerKey();
  assert.equal(await jwkThumbprint(a.publicJwk), a.keyId);
  assert.notEqual(a.keyId, b.keyId);
});
