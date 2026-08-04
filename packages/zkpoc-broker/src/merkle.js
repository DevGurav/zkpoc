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

/**
 * Q7's mitigation for ADR-0013's finding (GPU-equipped challenge-mode
 * attackers get 41x-271x more advantage than a memory-hard puzzle would
 * give them): an optional, GPU-hostile memory cost mixed into the row
 * commitment itself, so that computing a valid `hashRow` output -- not just
 * the underlying GEMM -- has a real, deliberately-parallel-unfriendly cost.
 *
 * WHY A CUSTOM CONSTRUCTION, NOT ARGON2ID ITSELF
 * -------------------------------------------------
 * Argon2id's actual security target (resisting offline password-cracking,
 * with side-channel and tradeoff-attack resistance) is not what this needs
 * -- there is no secret being protected here, only a computational tax being
 * imposed. What IS needed is the specific architectural property Argon2id
 * happens to share with scrypt: a working set too large for a GPU thread's
 * fast (shared/L1) memory, touched in a data-dependent order a compiler or
 * SIMT scheduler cannot prefetch or vectorize around. Reimplementing full
 * Argon2id correctly (its block-shuffling, its side-channel-hardening) is a
 * materially harder and riskier undertaking than this narrower goal needs,
 * and this project does not add cryptographic dependencies without a
 * specific reason (CONTRIBUTING.md) -- so this is a small, honestly-scoped,
 * purpose-built function instead, not a claim of Argon2id-equivalent
 * security.
 *
 * WHY 64 KiB, AND THE HONEST TENSION IN THAT NUMBER
 * -----------------------------------------------------
 * Bigger is a stronger GPU-resistance argument and a worse honest-user
 * latency cost -- there is no size that wins on both axes, and this file
 * does not pretend otherwise. 256 KiB would exceed even NVIDIA Hopper's
 * documented per-SM shared-memory ceiling (up to 228 KiB), but measured
 * ~14ms/row in this environment's Node runtime -- multiplied across a
 * real shard's ~1000+ rows, that alone would exceed most challenge-mode
 * target durations (README.md: 1-3s, matching the hashcash-style widgets
 * this is meant to substitute for). 64 KiB (measured ~1.3ms/row here)
 * exceeds older/typical GPU shared-memory configurations (Pascal/Volta:
 * 48-96 KiB) but NOT the largest current ones -- a deliberately weaker
 * GPU-resistance argument, traded for keeping the added latency
 * proportionate. Both constants are exported and overridable per call;
 * finding the actual right point on this tradeoff needs calibration
 * against real target hardware and a real target challenge duration, which
 * this environment cannot provide (no GPU access) -- see
 * docs/adr/0016-memory-hard-commitment-mitigation.md for the honest line
 * between what was measured (CPU-side overhead, real) and what is reasoned
 * from published hardware limits (GPU resistance, a design argument, not a
 * hardware measurement of this specific function).
 *
 * WHY MIX32, NOT SHA-256, FOR THE INNER LOOP
 * ---------------------------------------------
 * The same reason scrypt uses Salsa20/8 rather than a cryptographic hash for
 * its own mixing core: `words` iterations of a real digest would make the
 * memory-hard step orders of magnitude slower than the GEMM it is meant to
 * add a proportionate tax on top of, on every device, honest ones included.
 * `mix32` (the same non-cryptographic spreading function shard.js already
 * uses, for the same reason) makes each step cheap; the deterrence property
 * comes from the SIZE of the buffer and the UNPREDICTABILITY of which word
 * gets touched next, not from the mixer's cryptographic strength -- and
 * determinism is required anyway, since prover and verifier must both
 * reproduce the identical result to agree on a commitment.
 */
export const MEMORY_HARD_WORDS = 1 << 14;   // 16384 * 4 bytes = 64 KiB
export const MEMORY_HARD_ROUNDS = 2;

function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Fold arbitrary bytes to a 32-bit seed -- same non-cryptographic folding
 * idiom shard.js#seedFromBytes uses, for the same reason: cheap, and every
 * input byte influences the result, which is all that's needed here. */
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
 * Expand a seed into a `words`-sized buffer, then mix it for `rounds` passes
 * via a data-dependent random walk: which word is touched next depends on
 * the value just written, not a fixed stride, so the access pattern cannot
 * be precomputed or vectorized. Returns the final buffer contents, meant to
 * be folded into a real digest by the caller (see `hashRow`), not used as
 * an output hash on its own.
 */
function memoryHardExpand(seedBytes, words = MEMORY_HARD_WORDS, rounds = MEMORY_HARD_ROUNDS) {
  const buf = new Uint32Array(words);
  let s = seedFromBytes(seedBytes);
  for (let i = 0; i < words; i++) {
    s = mix32(s + 0x9e3779b1);
    buf[i] = s;
  }
  let idx = s % words;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < words; i++) {
      const v = mix32(buf[idx] ^ s);
      buf[idx] = v;
      s = v;
      idx = v % words;
    }
  }
  return new Uint8Array(buf.buffer);
}

/**
 * Hash one output row. Requires the full row -- there is no cheaper path.
 *
 * @param {ArrayLike<number>} values
 * @param {object} [o]
 * @param {boolean} [o.memoryHard]        mix in the Q7/ADR-0013 memory-hard
 *                                        cost (see block comment above).
 *                                        Default false: barter mode already
 *                                        has stake/audit deterrence
 *                                        (ADR-0006) and does not need this;
 *                                        it is meant for challenge mode
 *                                        (ADR-0012), where it is opt-in per
 *                                        call, not a silent global change.
 * @param {number} [o.memoryHardWords]
 * @param {number} [o.memoryHardRounds]
 */
export async function hashRow(values, o = {}) {
  const buf = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) buf[i] = quantize(values[i]);
  const rowBytes = new Uint8Array(buf.buffer);
  if (!o.memoryHard) return sha256(rowBytes);
  const expanded = memoryHardExpand(rowBytes, o.memoryHardWords, o.memoryHardRounds);
  return sha256(concatBytes(rowBytes, expanded));
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
