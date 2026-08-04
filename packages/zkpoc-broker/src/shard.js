/**
 * Shard definition and commit-then-challenge result verification.
 *
 * A shard is one unit of assignable work. Three properties matter:
 *
 *   1. DETERMINISTIC INPUTS -- given the same descriptor, any party can
 *      recompute the same inputs. Without this, nobody has a ground truth to
 *      check a result against.
 *   2. FRESH -- inputs are bound to a session nonce, so a result cannot be
 *      replayed from a previous session or precomputed before assignment.
 *      This is the property that makes useful work defensible in a challenge
 *      slot where SHA-256 hashcash is already broken: real buyer data is
 *      unpredictable by construction, whereas a hash puzzle's search space
 *      is not.
 *   3. CHEAPLY VERIFIABLE, WITHOUT A CHEAP SHORTCUT TO PRODUCE -- this is the
 *      one that took two attempts to get right; see below.
 *
 * THE VULNERABILITY THIS FILE CLOSES
 * -----------------------------------
 * An earlier version derived a handful of "challenge" output points directly
 * from the shard's public nonce (`sampleIndices(shard)`), on the theory that
 * a worker "cannot know which elements will be demanded until it holds the
 * shard." That claim was false: the challenge was a deterministic function of
 * data the worker already had the instant it received the shard, before
 * doing any real work. Since any single output element of an n x n GEMM costs
 * only O(n) to compute directly, a worker could compute the ~8 points that
 * would be checked and skip the O(n^3) computation entirely -- passing
 * verification with a mathematically perfect score while doing none of the
 * work being paid for. Redundancy did not catch this either: two workers
 * both taking the shortcut compute the *same* correct answers on the cheap
 * subset and agree with each other.
 *
 * THE FIX: COMMIT, THEN CHALLENGE
 * --------------------------------
 * A worker now hashes every output ROW (`merkle.js#hashRow` -- an operation
 * that requires having the row, i.e. having computed it), builds a Merkle
 * root over all n row hashes, and only THEN learns which rows will be
 * checked: `challengeRows()` derives the challenge from (shard, the worker's
 * OWN submitted root) via Fiat-Shamir. A worker cannot pick a favourable
 * challenge by choosing what to compute, because the challenge is a function
 * of a root it must already have committed to -- and building any valid root
 * requires hashing every row, which requires having every row's true values,
 * which costs the same O(n^3) as just doing the honest computation.
 *
 * This is a probabilistic guarantee, not an absolute one: a worker that
 * genuinely computes fraction f of the rows and forges the rest evades
 * detection on any single submission with probability f^k, where k is the
 * number of challenged rows. That is why consensus (comparing roots across
 * independently-submitted results for the same shard, not trusting a lone
 * submission) still matters on top of this fix, not instead of it.
 */

import {
  hashRow, buildMerkleTree, proveInclusion, verifyInclusion,
  toHex, fromHex, bytesEqual,
} from './merkle.js';

/** Deterministic 32-bit mix -- not cryptographic, and not used as if it were.
 * Its only job is spreading already-chosen entropy (a CSPRNG nonce upstream,
 * or a real SHA-256 root here) across indices cheaply and identically in
 * every implementation. */
function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Stable 32-bit seed from a string nonce. */
export function seedFromNonce(nonce) {
  let h = 0x811c9dc5;
  for (let i = 0; i < nonce.length; i++) {
    h = Math.imul(h ^ nonce.charCodeAt(i), 0x01000193) >>> 0;
  }
  return mix32(h);
}

/** Fold a byte array down to a 32-bit seed, for mixing a Merkle root into the
 * same mix32-based derivation used elsewhere. Collision-cheapness here is
 * fine -- the unpredictability this scheme needs comes from the SHA-256 root
 * being unknown in advance, not from this folding step being cryptographic. */
function seedFromBytes(bytes) {
  let s = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = (bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) |
                 ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    s = mix32(s ^ word);
  }
  return s >>> 0;
}

/**
 * One assignable unit of work.
 *
 * Frozen on construction: a shard descriptor that can be mutated after
 * assignment would let a client negotiate its own difficulty downward, which
 * is exactly the free-riding path the verification layer exists to close.
 */
export class Shard {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {number} o.n           matrix dimension
   * @param {string} o.sessionNonce  freshness binding
   * @param {string} [o.tierName]  tier this was sized for
   * @param {number} [o.issuedAt]
   */
  constructor({ id, n, sessionNonce, tierName = null, issuedAt = Date.now() }) {
    if (!id) throw new TypeError('shard requires an id');
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`shard ${id}: n must be a positive integer`);
    }
    if (typeof sessionNonce !== 'string' || sessionNonce.length < 16) {
      throw new TypeError(`shard ${id}: sessionNonce must be a string of >=16 chars`);
    }
    this.id = id;
    this.n = n;
    this.sessionNonce = sessionNonce;
    this.tierName = tierName;
    this.issuedAt = issuedAt;
    this.seed = seedFromNonce(sessionNonce);
    Object.freeze(this);
  }

  get flops() {
    return 2 * this.n ** 3;
  }

  /**
   * Element (i, j) of input matrix A. Derived from the shard's nonce-seed, so
   * two shards with different nonces have different inputs even at identical
   * dimensions -- which is what stops a result being replayed across sessions.
   */
  elemA(i, j) {
    return (mix32(this.seed ^ Math.imul(i, 0x9e3779b1) ^ j) % 2048) / 1024 - 1;
  }

  elemB(i, j) {
    return (mix32((this.seed + 0x5bf03635) ^ Math.imul(j, 0x9e3779b1) ^ i) % 2048) / 1024 - 1;
  }

  /** Full input matrices, row-major. Only needed by whoever executes. */
  materialize() {
    const { n } = this;
    const A = new Float32Array(n * n);
    const B = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        A[i * n + j] = this.elemA(i, j);
        B[i * n + j] = this.elemB(i, j);
      }
    }
    return { A, B };
  }

  /**
   * Recompute one output element in O(n) rather than O(n^3). The ground truth
   * every verification in this file ultimately checks against.
   */
  referenceElement(i, j) {
    let acc = 0;
    for (let k = 0; k < this.n; k++) acc += this.elemA(i, k) * this.elemB(k, j);
    return acc;
  }

  /**
   * Full row i, O(n) elements each costing O(n) -- O(n^2) for one row, O(n^3)
   * across all n rows, matching real GEMM cost. This is what a worker (honest
   * or trying to shortcut) must produce n times to build any valid Merkle
   * root; see buildRowCommitment().
   */
  rowValues(i) {
    const out = new Float32Array(this.n);
    for (let j = 0; j < this.n; j++) out[j] = this.referenceElement(i, j);
    return out;
  }

  /** Serialisable form for assignment over the wire. */
  toJSON() {
    return {
      id: this.id,
      n: this.n,
      sessionNonce: this.sessionNonce,
      tierName: this.tierName,
      issuedAt: this.issuedAt,
    };
  }
}

/** How many rows a submission must reveal by default. See the module
 * docstring: evasion probability on one submission is f^k for a worker
 * honest on fraction f of rows. Both broker and worker must agree on k --
 * it is not something a worker may unilaterally choose, or revealing fewer
 * rows would trivially weaken its own guarantee. */
export const DEFAULT_CHALLENGE_ROWS = 8;

/**
 * Derive the challenge row indices for a submitted root, via Fiat-Shamir.
 *
 * Deterministic in (shard, root, k) so the broker can independently recompute
 * exactly which rows a given root is required to reveal, rather than trusting
 * the worker's choice of what to reveal.
 *
 * @param {Shard} shard
 * @param {Uint8Array|string} root  raw bytes or hex string
 * @param {number} [k]
 * @returns {number[]} distinct row indices, ascending
 */
export function challengeRows(shard, root, k = DEFAULT_CHALLENGE_ROWS) {
  const rootBytes = typeof root === 'string' ? fromHex(root) : root;
  let s = mix32(shard.seed ^ seedFromBytes(rootBytes));
  const count = Math.min(k, shard.n);
  const out = [];
  const seen = new Set();
  while (out.length < count && seen.size < shard.n) {
    s = mix32(s + 0x9e3779b1);
    const row = s % shard.n;
    if (!seen.has(row)) { seen.add(row); out.push(row); }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Compute every row honestly and commit to it.
 *
 * This is the ONLY way to obtain a root that will pass `verifyRowSubmission`
 * with high probability: hashing every row requires having every row, which
 * requires the full O(n^3) computation. There is no partial-computation
 * shortcut to a valid root the way there was to a valid point-sample.
 *
 * @param {Shard} shard
 * @returns {Promise<{root: Uint8Array, layers: Uint8Array[][], rows: Float32Array[]}>}
 */
export async function commitFullResult(shard) {
  const rows = [];
  const leaves = [];
  for (let i = 0; i < shard.n; i++) {
    const row = shard.rowValues(i);
    rows.push(row);
    leaves.push(await hashRow(row));
  }
  const { root, layers } = await buildMerkleTree(leaves);
  return { root, layers, rows };
}

/**
 * A result submitted by a client: a root commitment plus revealed proof for
 * exactly the rows that root's own challenge derivation demands.
 */
export class ShardResult {
  /**
   * @param {object} o
   * @param {string} o.shardId
   * @param {string} o.workerId
   * @param {string} o.root      hex-encoded Merkle root, 64 chars (32 bytes)
   * @param {Array<{index:number, values:number[], proof:Array<{hash:string,isRight:boolean}>}>} o.rows
   * @param {number} [o.reportedMs]
   * @param {number} [o.submittedAt]
   */
  constructor({ shardId, workerId, root, rows, reportedMs = null, submittedAt = Date.now() }) {
    if (!shardId) throw new TypeError('result requires a shardId');
    if (!workerId) throw new TypeError('result requires a workerId');
    if (typeof root !== 'string' || root.length !== 64) {
      throw new TypeError('result requires a 64-char hex Merkle root (32-byte SHA-256)');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new TypeError(`result for ${shardId}: rows must be a non-empty array`);
    }
    for (const r of rows) {
      if (!Number.isInteger(r.index) || r.index < 0) {
        throw new TypeError(`result for ${shardId}: row entries need a non-negative integer index`);
      }
      if (!Array.isArray(r.values) && !ArrayBuffer.isView(r.values)) {
        throw new TypeError(`result for ${shardId}: row ${r.index} missing values`);
      }
      if (!Array.isArray(r.proof)) {
        throw new TypeError(`result for ${shardId}: row ${r.index} missing a proof array`);
      }
    }
    this.shardId = shardId;
    this.workerId = workerId;
    this.root = root;
    this.rows = rows;
    this.reportedMs = reportedMs;
    this.submittedAt = submittedAt;
    Object.freeze(this);
  }
}

/**
 * Build a fully-formed, honestly-computed submission.
 *
 * Convenience for tests and for the eventual real worker integration: does
 * the full commit, derives its own required challenge from the resulting
 * root (exactly as the broker will), and reveals those rows with proofs.
 *
 * @param {Shard} shard
 * @param {string} workerId
 * @param {object} [o]
 * @param {number} [o.k]
 * @returns {Promise<ShardResult>}
 */
export async function buildHonestSubmission(shard, workerId, o = {}) {
  const k = o.k ?? DEFAULT_CHALLENGE_ROWS;
  const { root, layers, rows } = await commitFullResult(shard);
  const required = challengeRows(shard, root, k);
  const revealed = required.map((idx) => ({
    index: idx,
    values: Array.from(rows[idx]),
    proof: proveInclusion(layers, idx).map((p) => ({ hash: toHex(p.hash), isRight: p.isRight })),
  }));
  return new ShardResult({
    shardId: shard.id, workerId, root: toHex(root), rows: revealed,
  });
}

/** Default tolerance for fp32 GEMM accumulation across implementations. */
export const DEFAULT_TOLERANCE = 1e-2;

/**
 * Verify a submitted result: that it reveals exactly the rows its own root
 * requires, that each revealed row is genuinely bound to that root, and that
 * a spot-check within each revealed row matches ground truth.
 *
 * Three independent failure classes, reported separately so a caller can
 * tell "wrong reveal set" (evasive) from "bad proof" (forged/corrupted) from
 * "wrong values" (wrong computation, possibly innocent) rather than a single
 * opaque ok:false.
 *
 * @param {Shard} shard
 * @param {ShardResult} result
 * @param {object} [o]
 * @param {number} [o.k]                    must match what the submitter used
 * @param {number} [o.elementsPerRow=4]      ground-truth spot-check density
 * @param {number} [o.tolerance]
 * @returns {Promise<{ok:boolean, checkedRows:number[], failures:Array,
 *                     worstError:number}>}
 */
export async function verifyRowSubmission(shard, result, o = {}) {
  const k = o.k ?? DEFAULT_CHALLENGE_ROWS;
  const elementsPerRow = o.elementsPerRow ?? 4;
  const tolerance = o.tolerance ?? DEFAULT_TOLERANCE;
  const failures = [];
  let worstError = 0;

  if (result.shardId !== shard.id) {
    return { ok: false, checkedRows: [], worstError: 0,
      failures: [{ reason: 'result is for a different shard' }] };
  }

  let rootBytes;
  try {
    rootBytes = fromHex(result.root);
  } catch {
    return { ok: false, checkedRows: [], worstError: 0,
      failures: [{ reason: 'malformed root encoding' }] };
  }

  // The broker derives the requirement itself -- it does not trust the
  // worker's choice of which rows to reveal.
  const required = challengeRows(shard, rootBytes, k);
  const revealedByIndex = new Map(result.rows.map((r) => [r.index, r]));

  for (const idx of required) {
    const entry = revealedByIndex.get(idx);
    if (!entry) {
      failures.push({ index: idx, reason: 'required row was not revealed' });
      continue;
    }
    if (entry.values.length !== shard.n) {
      failures.push({ index: idx, reason: `row has ${entry.values.length} values, expected ${shard.n}` });
      continue;
    }

    const leafHash = await hashRow(entry.values);
    const proof = entry.proof.map((p) => ({ hash: fromHex(p.hash), isRight: p.isRight }));
    const included = await verifyInclusion(leafHash, proof, rootBytes);
    if (!included) {
      failures.push({ index: idx, reason: 'row is not included under the submitted root' });
      continue;
    }

    // Ground-truth spot-check within the row -- cheap (O(1) per element),
    // and this is what catches a row that is internally consistent with the
    // root but simply wrong.
    const cols = spotColumns(shard, idx, elementsPerRow);
    for (const j of cols) {
      const expected = shard.referenceElement(idx, j);
      const got = entry.values[j];
      if (!Number.isFinite(got)) {
        failures.push({ index: idx, j, reason: 'non-finite value' });
        continue;
      }
      const err = Math.abs(got - expected) / Math.max(1, Math.abs(expected));
      if (err > worstError) worstError = err;
      if (err > tolerance) {
        failures.push({
          index: idx, j, expected, got, relError: err,
          reason: 'value does not match ground truth',
        });
      }
    }
  }

  // Extra revealed rows beyond the requirement are harmless (ignored above)
  // but rows revealed with an index the requirement never asked for are not
  // evidence of anything either way, so they are not penalised or trusted.

  return {
    ok: failures.length === 0,
    checkedRows: required,
    worstError,
    failures,
  };
}

/** Deterministic column sub-sample within one row, for the O(1)-per-element
 * ground-truth spot-check. Same nonce-free derivation style as elsewhere in
 * this file -- unpredictability here is not load-bearing the way the row
 * challenge is, since the row is already bound to the root by this point. */
function spotColumns(shard, rowIndex, count) {
  const n = shard.n;
  const c = Math.min(count, n);
  let s = mix32(shard.seed ^ Math.imul(rowIndex, 0x2545f491));
  const out = [];
  const seen = new Set();
  while (out.length < c && seen.size < n) {
    s = mix32(s + 0x9e3779b1);
    const j = s % n;
    if (!seen.has(j)) { seen.add(j); out.push(j); }
  }
  return out;
}
