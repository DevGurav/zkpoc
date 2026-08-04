/**
 * Canonical JSON serialisation, following RFC 8785 (JCS).
 *
 * A signature over a JSON document is meaningless unless both parties agree
 * byte-for-byte on what was signed. `JSON.stringify` does not: key order
 * follows insertion order, so two semantically identical manifests can
 * produce different bytes and therefore different signatures.
 *
 * This matters more than usual here. The Compute Consent Manifest is designed
 * to be verified by a THIRD PARTY -- a browser extension, an auditor, a
 * researcher -- who received the manifest over an untrusted path and did not
 * observe how it was constructed. They must be able to recompute the exact
 * signing input from the parsed object alone.
 *
 * Restrictions vs full RFC 8785, all enforced rather than silently tolerated:
 *   - no NaN or Infinity (not representable in JSON)
 *   - no -0 (normalised to 0)
 *   - integers must be within Number.MAX_SAFE_INTEGER
 *   - undefined values and functions are rejected, not dropped
 */

/** @param {unknown} value @returns {string} */
export function canonicalize(value) {
  return serialize(value, new Set(), '$');
}

function serialize(value, seen, path) {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') return serializeNumber(value, path);

  if (t === 'string') return JSON.stringify(value);

  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalize: ${t} is not serialisable at ${path}`);
  }

  if (t === 'bigint') {
    throw new TypeError(`canonicalize: bigint is not serialisable at ${path}`);
  }

  if (Array.isArray(value)) {
    guardCycle(value, seen, path);
    const out = value.map((v, i) => serialize(v, seen, `${path}[${i}]`));
    seen.delete(value);
    return `[${out.join(',')}]`;
  }

  if (t === 'object') {
    guardCycle(value, seen, path);
    // RFC 8785 sorts by UTF-16 code unit. Array.prototype.sort on strings is
    // already a UTF-16 code-unit ordering, so the default comparator is correct
    // -- do NOT substitute localeCompare, which is locale-dependent.
    const keys = Object.keys(value).sort();
    const out = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) {
        throw new TypeError(`canonicalize: undefined value at ${path}.${k}`);
      }
      out.push(`${JSON.stringify(k)}:${serialize(v, seen, `${path}.${k}`)}`);
    }
    seen.delete(value);
    return `{${out.join(',')}}`;
  }

  throw new TypeError(`canonicalize: unsupported type ${t} at ${path}`);
}

function guardCycle(value, seen, path) {
  if (seen.has(value)) {
    throw new TypeError(`canonicalize: circular reference at ${path}`);
  }
  seen.add(value);
}

function serializeNumber(n, path) {
  if (!Number.isFinite(n)) {
    throw new TypeError(`canonicalize: ${n} is not serialisable at ${path}`);
  }
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
    throw new TypeError(
      `canonicalize: integer ${n} exceeds safe range at ${path}`);
  }
  // ES Number::toString is what RFC 8785 specifies for the common cases.
  return String(n);
}

/** UTF-8 bytes of the canonical form -- the actual signing input. */
export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}
