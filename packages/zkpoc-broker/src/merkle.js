/**
 * Row-level Merkle commitment over SHA-256.
 *
 * Exists to close a specific hole: `sampleIndices` derived a challenge set
 * from public shard data alone (n, sessionNonce), which meant a worker could
 * compute the challenge locally the instant it received the shard -- before
 * doing any real work -- and answer only those few O(n) points, passing
 * verification while skipping the O(n^3) computation entirely. See
 * shard.js's module docstring and docs/BUILD.md for the fuller account.
 *
 * The fix is standard commit-then-challenge: a worker hashes each output row
 * (an operation that requires having the row, i.e. having actually computed
 * it), builds a Merkle root over those row hashes, and only THEN -- via
 * Fiat-Shamir, deriving the challenge from the committed root -- learns which
 * rows will be checked. A worker cannot choose a favourable challenge by
 * choosing what to compute, because the challenge is a function of a root
 * they must already have committed to.
 *
 * Security argument, stated plainly: if a worker genuinely computed fraction
 * f of the rows and forged the rest, the chance that k independently-chosen
 * challenge rows all land in the honest fraction is f^k. At k=8, skipping
 * even 20% of the work (f=0.8) succeeds with probability 0.8^8 ~= 0.168 --
 * not negligible on a SINGLE submission, which is exactly why consensus
 * (comparing roots across independent submissions, not just accepting one)
 * still matters even after this fix. Raising k tightens a single submission's
 * guarantee at the cost of more per-submission verification work; that
 * trade-off is a broker policy choice, not fixed here.
 */

const subtle = globalThis.crypto?.subtle;
if (!subtle) {
  throw new Error('zkpoc-broker/merkle requires WebCrypto (globalThis.crypto.subtle)');
}

/** Quantization step shared with ShardResult -- see shard.js for why this
 * exists: independent implementations (WGSL vs JS, different GPUs) do not
 * produce bit-identical fp32 GEMM output, so committing raw bits would make
 * two honest workers' roots disagree. Quantizing before hashing is what lets
 * them agree. */
export const QUANTIZE_SCALE = 1e4;

export function quantize(v) {
  return Math.round(v * QUANTIZE_SCALE);
}

async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/** Hash one output row. Requires the full row -- there is no cheaper path. */
export async function hashRow(values) {
  const buf = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) buf[i] = quantize(values[i]);
  return sha256(new Uint8Array(buf.buffer));
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Build a full Merkle tree from leaf hashes.
 *
 * Odd layers duplicate the last node (standard Bitcoin-style handling) rather
 * than leaving it unpaired, so every layer above the leaves has an even
 * layer below it to pair from.
 *
 * @param {Uint8Array[]} leaves
 * @returns {Promise<{root: Uint8Array, layers: Uint8Array[][]}>}
 */
export async function buildMerkleTree(leaves) {
  if (leaves.length === 0) throw new RangeError('cannot build a tree with zero leaves');
  const layers = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(await sha256(concatBytes(left, right)));
    }
    layers.push(next);
    current = next;
  }
  return { root: current[0], layers };
}

/**
 * Inclusion proof for one leaf: the sibling hash at each layer, plus which
 * side the sibling sits on (needed to reproduce concatenation order on the
 * verifying side without re-deriving it from the index alone).
 */
export function proveInclusion(layers, index) {
  if (index < 0 || index >= layers[0].length) {
    throw new RangeError(`leaf index ${index} out of range for ${layers[0].length} leaves`);
  }
  const proof = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : Math.min(idx + 1, layer.length - 1);
    proof.push({ hash: layer[siblingIdx], isRight: !isRight });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify a leaf's inclusion proof against a root, without the rest of the tree.
 *
 * This is what makes the scheme cheap on the broker side: verifying one row's
 * membership costs O(log n) hashes, not O(n) tree rebuilds.
 */
export async function verifyInclusion(leafHash, proof, root) {
  let current = leafHash;
  for (const { hash, isRight } of proof) {
    current = isRight
      ? await sha256(concatBytes(current, hash))
      : await sha256(concatBytes(hash, current));
  }
  return bytesEqual(current, root);
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new TypeError('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
