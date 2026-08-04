/**
 * Compute Consent Manifest -- issuing, signing, and third-party verification.
 *
 * Uses WebCrypto ECDSA P-256 / SHA-256, which is available unflagged in every
 * current browser and in Node >= 16. Ed25519 would be a slightly better fit but
 * is still gated on some engines, and a manifest nobody can verify defeats the
 * purpose.
 */

import { canonicalBytes } from './canonical.js';
import { validateStructure, checkAgainstPolicy, CCM_VERSION } from './schema.js';

const subtle = globalThis.crypto?.subtle;
if (!subtle) {
  throw new Error('zkpoc-ccm requires WebCrypto (globalThis.crypto.subtle)');
}

const ALG = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN_ALG = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
export const SIG_ALG_ID = 'ECDSA-P256-SHA256';

// -- key management ---------------------------------------------------------

/** Generate an issuer keypair. The public JWK is what verifiers need. */
export async function generateIssuerKey() {
  const kp = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const publicJwk = await subtle.exportKey('jwk', kp.publicKey);
  delete publicJwk.key_ops;
  delete publicJwk.ext;
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicJwk,
    keyId: await jwkThumbprint(publicJwk),
  };
}

/** RFC 7638 JWK thumbprint, used as the stable key_id. */
export async function jwkThumbprint(jwk) {
  // RFC 7638 fixes both the member set and their order for EC keys.
  const input = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
}

export async function importPublicJwk(jwk) {
  return subtle.importKey('jwk', jwk, ALG, true, ['verify']);
}

// -- hashing ----------------------------------------------------------------

/** SRI-style digest of a resource: "sha256-<standard base64>". */
export async function digest(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input)
                                          : new Uint8Array(input);
  const d = await subtle.digest('SHA-256', bytes);
  return `sha256-${b64std(new Uint8Array(d))}`;
}

// -- issuing ----------------------------------------------------------------

/**
 * Build a manifest. Everything except the signature; call signManifest next.
 *
 * @param {object} p
 * @param {string} p.origin           issuer https origin
 * @param {string} p.keyId
 * @param {object} p.workload         {class, description, buyer?}
 * @param {object} p.code             {worker, kernels:[{type,hash}]}
 * @param {object} p.limits
 * @param {object} p.dataAccess       {storage,dom,sensors,cookies}
 * @param {number} [p.ttlSeconds=600]
 * @param {string} [p.nonce]
 * @param {string} [p.revocationEndpoint]
 */
export function buildManifest(p) {
  const now = new Date();
  const ttl = p.ttlSeconds ?? 600;
  return {
    v: CCM_VERSION,
    issuer: { origin: p.origin, key_id: p.keyId },
    workload: { ...p.workload },
    code: { worker: p.code.worker, kernels: p.code.kernels.map((k) => ({ ...k })) },
    limits: { ...p.limits },
    data_access: { ...p.dataAccess },
    session: {
      nonce: p.nonce ?? b64url(globalThis.crypto.getRandomValues(new Uint8Array(18))),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    },
    revocation: {
      user_revocable: true,
      ...(p.revocationEndpoint ? { endpoint: p.revocationEndpoint } : {}),
    },
  };
}

/** Sign a manifest, returning a new object with `sig` attached. */
export async function signManifest(manifest, privateKey) {
  const { sig, ...unsigned } = manifest;      // never sign over an existing sig
  const bytes = canonicalBytes(unsigned);
  const raw = await subtle.sign(SIGN_ALG, privateKey, bytes);
  return { ...unsigned, sig: { alg: SIG_ALG_ID, value: b64url(new Uint8Array(raw)) } };
}

/** Verify only the signature. Prefer verifyManifest for real use. */
export async function verifySignature(manifest, publicJwkOrKey) {
  if (!manifest?.sig?.value || manifest.sig.alg !== SIG_ALG_ID) return false;
  const { sig, ...unsigned } = manifest;
  const key = publicJwkOrKey instanceof CryptoKey
    ? publicJwkOrKey : await importPublicJwk(publicJwkOrKey);
  try {
    return await subtle.verify(SIGN_ALG, key, unb64url(sig.value),
                               canonicalBytes(unsigned));
  } catch {
    return false;
  }
}

// -- third-party verification ----------------------------------------------

/**
 * Full verification, as an independent party would perform it.
 *
 * The caller is assumed to trust neither the publisher nor the broker. Each
 * check is reported separately so a UI can explain precisely what failed
 * rather than showing an opaque pass/fail.
 *
 * @param {object} manifest
 * @param {object} opts
 * @param {object|CryptoKey} opts.publicJwk   issuer key, obtained out of band
 * @param {object} [opts.policy]              the verifier's own limits
 * @param {object} [opts.loadedCode]          {worker: string|ArrayBuffer,
 *                                             kernels: (string|ArrayBuffer)[]}
 * @param {Date}   [opts.now]
 * @param {Set<string>} [opts.seenNonces]     replay detection across sessions
 * @returns {Promise<{ok:boolean, checks:object[], errors:string[]}>}
 */
export async function verifyManifest(manifest, opts = {}) {
  const checks = [];
  const errors = [];
  const now = opts.now ?? new Date();
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok && detail) errors.push(`${name}: ${detail}`);
  };

  // 1. structure
  const st = validateStructure(manifest);
  add('structure', st.ok, st.ok ? 'well-formed' : st.errors.join('; '));
  if (!st.ok) return { ok: false, checks, errors };

  // 2. signature. Checked before anything semantic -- an unsigned manifest's
  //    contents are not evidence of anything.
  let sigOk = false;
  if (!opts.publicJwk) {
    add('signature', false, 'no issuer key supplied; cannot verify');
  } else {
    sigOk = await verifySignature(manifest, opts.publicJwk);
    add('signature', sigOk, sigOk ? SIG_ALG_ID : 'signature did not verify');
  }

  // 2b. the key must actually be the one the manifest names
  if (opts.publicJwk && !(opts.publicJwk instanceof CryptoKey)) {
    const tp = await jwkThumbprint(opts.publicJwk);
    const bound = tp === manifest.issuer.key_id;
    add('key_binding', bound, bound
      ? 'issuer.key_id matches key thumbprint'
      : `issuer.key_id ${manifest.issuer.key_id} != thumbprint ${tp}`);
  }

  // 3. temporal validity
  const iat = Date.parse(manifest.session.issued_at);
  const exp = Date.parse(manifest.session.expires_at);
  const t = now.getTime();
  const SKEW = 60_000;                     // tolerate a minute of clock skew
  const fresh = t >= iat - SKEW && t < exp;
  add('validity_window', fresh, fresh
    ? `valid until ${manifest.session.expires_at}`
    : t < iat - SKEW ? 'issued in the future' : 'expired');

  // 4. replay
  if (opts.seenNonces) {
    const replayed = opts.seenNonces.has(manifest.session.nonce);
    add('nonce_freshness', !replayed,
        replayed ? 'nonce already used' : 'nonce unseen');
    if (!replayed) opts.seenNonces.add(manifest.session.nonce);
  }

  // 5. code binding -- the check that stops "declare one thing, ship another"
  if (opts.loadedCode) {
    const wHash = await digest(opts.loadedCode.worker);
    const wOk = wHash === manifest.code.worker;
    add('code.worker', wOk, wOk ? wHash
      : `loaded worker hashes to ${wHash}, manifest declares ${manifest.code.worker}`);

    const loaded = opts.loadedCode.kernels ?? [];
    if (loaded.length !== manifest.code.kernels.length) {
      add('code.kernels', false,
          `${loaded.length} kernels loaded, ${manifest.code.kernels.length} declared`);
    } else {
      for (let i = 0; i < loaded.length; i++) {
        const h = await digest(loaded[i]);
        const ok = h === manifest.code.kernels[i].hash;
        add(`code.kernels[${i}]`, ok, ok ? h
          : `loaded ${h}, declared ${manifest.code.kernels[i].hash}`);
      }
    }
  } else {
    add('code_binding', false,
        'no loaded code supplied; declaration is unverified against what runs');
  }

  // 6. the verifier's own policy
  if (opts.policy) {
    const pol = checkAgainstPolicy(manifest, opts.policy);
    add('policy', pol.ok, pol.ok ? 'within policy' : pol.errors.join('; '));
  }

  return { ok: checks.every((c) => c.ok), checks, errors };
}

// -- base64 helpers ---------------------------------------------------------

function b64std(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64url(bytes) {
  return b64std(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
               .padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
