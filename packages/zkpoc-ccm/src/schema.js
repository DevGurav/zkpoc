/**
 * Compute Consent Manifest -- structure and validation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Covert in-browser compute cannot be reliably detected. WASM diversification
 * evades MINOS in 100% of cases and VirusTotal in ~90% (arXiv:2403.15197), so
 * a detector that a miner escapes completely cannot certify that a legitimate
 * workload is *not* a miner. Detection is the wrong primitive.
 *
 * Legitimacy therefore has to come from DECLARATION: a signed, machine-readable
 * statement of what will run, how much of the device it may take, for how long,
 * and what it may touch -- verifiable by a third party who trusts neither the
 * publisher nor the broker.
 *
 * A declaration is worthless on its own, so the schema is built around three
 * properties that make it mean something:
 *
 *   1. CODE BINDING (`code`). Hashes of the worker script and every kernel.
 *      Without this you declare one thing and ship another. This is what
 *      connects the promise to the bytes that actually execute.
 *   2. ENFORCEABLE LIMITS (`limits`). Every field maps onto something the
 *      governor can actually cap at runtime. A limit nothing enforces is
 *      marketing, so the schema deliberately admits no such field.
 *   3. CONTAINMENT SCOPE (`data_access`). The reverse direction: what the
 *      platform promises NOT to touch. In M1 this is a declaration backed by
 *      structural enforcement (a Worker has no DOM, storage can be denied);
 *      M3 can back it with a proof.
 */

export const CCM_VERSION = 'zkpoc-ccm/1';

export const WORKLOAD_CLASSES = Object.freeze([
  'ml-inference', 'ml-training', 'render', 'scientific', 'benchmark',
]);

export const KERNEL_TYPES = Object.freeze(['wgsl', 'wasm', 'js']);

/** Access levels, ordered least to most privileged. */
export const ACCESS_LEVELS = Object.freeze(['none', 'session', 'persistent']);

const HASH_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;   // SRI-style base64 SHA-256
const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

/**
 * Ceilings the schema itself refuses to exceed, independent of what any
 * publisher asks for. A manifest declaring a 100% share for an hour is
 * well-formed JSON but is not a consent manifest in any useful sense, and
 * the schema should say so rather than leaving it to each verifier.
 */
export const HARD_CAPS = Object.freeze({
  cpu_share_max: 0.90,
  gpu_share_max: 0.90,
  duration_max_s: 3600,
  egress_bytes_max: 256 * 1024 * 1024,
});

/**
 * Validate manifest structure. Returns every problem found rather than
 * throwing on the first, so a verifier can present a complete report.
 *
 * @param {unknown} m
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateStructure(m) {
  const e = [];
  const push = (msg) => e.push(msg);

  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  if (m.v !== CCM_VERSION) push(`v must be "${CCM_VERSION}", got ${JSON.stringify(m.v)}`);

  // -- issuer ---------------------------------------------------------------
  const iss = m.issuer;
  if (!isObj(iss)) push('issuer must be an object');
  else {
    if (!ORIGIN_RE.test(iss.origin ?? '')) {
      push('issuer.origin must be an https origin');
    }
    if (typeof iss.key_id !== 'string' || !iss.key_id) {
      push('issuer.key_id must be a non-empty string');
    }
  }

  // -- workload -------------------------------------------------------------
  const w = m.workload;
  if (!isObj(w)) push('workload must be an object');
  else {
    if (!WORKLOAD_CLASSES.includes(w.class)) {
      push(`workload.class must be one of ${WORKLOAD_CLASSES.join('|')}`);
    }
    if (typeof w.description !== 'string' || w.description.length < 8) {
      push('workload.description must be a human-readable string (>=8 chars)');
    }
  }

  // -- code binding ---------------------------------------------------------
  const c = m.code;
  if (!isObj(c)) push('code must be an object');
  else {
    if (!HASH_RE.test(c.worker ?? '')) {
      push('code.worker must be an SRI-style sha256- digest');
    }
    if (!Array.isArray(c.kernels) || c.kernels.length === 0) {
      push('code.kernels must be a non-empty array');
    } else {
      c.kernels.forEach((k, i) => {
        if (!isObj(k)) { push(`code.kernels[${i}] must be an object`); return; }
        if (!KERNEL_TYPES.includes(k.type)) {
          push(`code.kernels[${i}].type must be one of ${KERNEL_TYPES.join('|')}`);
        }
        if (!HASH_RE.test(k.hash ?? '')) {
          push(`code.kernels[${i}].hash must be an SRI-style sha256- digest`);
        }
      });
    }
  }

  // -- limits ---------------------------------------------------------------
  const L = m.limits;
  if (!isObj(L)) push('limits must be an object');
  else {
    checkShare(L.cpu_share_max, 'limits.cpu_share_max', HARD_CAPS.cpu_share_max, push);
    checkShare(L.gpu_share_max, 'limits.gpu_share_max', HARD_CAPS.gpu_share_max, push);
    checkRange(L.duration_max_s, 'limits.duration_max_s', 1, HARD_CAPS.duration_max_s, push);
    if (L.energy_max_mwh !== undefined) {
      checkRange(L.energy_max_mwh, 'limits.energy_max_mwh', 0, 1e6, push);
    }
    const n = L.network;
    if (!isObj(n)) push('limits.network must be an object');
    else {
      checkRange(n.egress_bytes_max, 'limits.network.egress_bytes_max',
                 0, HARD_CAPS.egress_bytes_max, push);
      if (!Array.isArray(n.allowed_origins) || n.allowed_origins.length === 0) {
        push('limits.network.allowed_origins must be a non-empty array');
      } else {
        n.allowed_origins.forEach((o, i) => {
          if (!ORIGIN_RE.test(o)) {
            push(`limits.network.allowed_origins[${i}] must be an https origin`);
          }
        });
      }
    }
  }

  // -- data access (the containment claim) ----------------------------------
  const d = m.data_access;
  if (!isObj(d)) push('data_access must be an object');
  else {
    for (const f of ['storage', 'dom', 'sensors', 'cookies']) {
      if (!ACCESS_LEVELS.includes(d[f])) {
        push(`data_access.${f} must be one of ${ACCESS_LEVELS.join('|')}`);
      }
    }
  }

  // -- session --------------------------------------------------------------
  const s = m.session;
  if (!isObj(s)) push('session must be an object');
  else {
    if (typeof s.nonce !== 'string' || s.nonce.length < 16) {
      push('session.nonce must be a string of >=16 chars');
    }
    for (const f of ['issued_at', 'expires_at']) {
      if (!isIsoInstant(s[f])) push(`session.${f} must be an ISO-8601 instant`);
    }
    if (isIsoInstant(s.issued_at) && isIsoInstant(s.expires_at)
        && Date.parse(s.expires_at) <= Date.parse(s.issued_at)) {
      push('session.expires_at must be after session.issued_at');
    }
  }

  // -- revocation -----------------------------------------------------------
  const r = m.revocation;
  if (!isObj(r)) push('revocation must be an object');
  else if (r.user_revocable !== true) {
    // Non-negotiable. A consent manifest the user cannot withdraw is the
    // thing this project exists to be the opposite of.
    push('revocation.user_revocable must be true');
  }

  return { ok: e.length === 0, errors: e };
}

/**
 * Check the manifest against a verifier's OWN policy.
 *
 * Separate from structural validation on purpose: a manifest can be perfectly
 * well-formed and still ask for more than a given user is willing to give.
 * Structure is objective, policy is the user's.
 *
 * @param {object} m validated manifest
 * @param {object} policy e.g. {cpu_share_max: 0.05, duration_max_s: 360,
 *                             require_data_access: {storage:'none', dom:'none'}}
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkAgainstPolicy(m, policy = {}) {
  const e = [];
  const L = m.limits ?? {};

  for (const f of ['cpu_share_max', 'gpu_share_max', 'duration_max_s']) {
    if (policy[f] !== undefined && L[f] > policy[f]) {
      e.push(`${f}: manifest asks ${L[f]}, policy allows ${policy[f]}`);
    }
  }
  if (policy.energy_max_mwh !== undefined && L.energy_max_mwh > policy.energy_max_mwh) {
    e.push(`energy_max_mwh: manifest asks ${L.energy_max_mwh}, ` +
           `policy allows ${policy.energy_max_mwh}`);
  }

  const want = policy.require_data_access ?? {};
  for (const [field, maxLevel] of Object.entries(want)) {
    const got = m.data_access?.[field];
    if (ACCESS_LEVELS.indexOf(got) > ACCESS_LEVELS.indexOf(maxLevel)) {
      e.push(`data_access.${field}: manifest declares "${got}", ` +
             `policy allows at most "${maxLevel}"`);
    }
  }

  if (Array.isArray(policy.allowed_origins)) {
    for (const o of m.limits?.network?.allowed_origins ?? []) {
      if (!policy.allowed_origins.includes(o)) {
        e.push(`network origin ${o} is not in the policy allow-list`);
      }
    }
  }

  return { ok: e.length === 0, errors: e };
}

// -- helpers ----------------------------------------------------------------

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

function isIsoInstant(s) {
  if (typeof s !== 'string') return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(s);
}

function checkShare(v, name, cap, push) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    push(`${name} must be a number`); return;
  }
  if (v <= 0 || v > cap) push(`${name} must be in (0, ${cap}], got ${v}`);
}

function checkRange(v, name, lo, hi, push) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    push(`${name} must be a number`); return;
  }
  if (v < lo || v > hi) push(`${name} must be in [${lo}, ${hi}], got ${v}`);
}
