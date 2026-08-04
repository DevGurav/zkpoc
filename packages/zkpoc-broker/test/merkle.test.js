import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashRow, buildMerkleTree, proveInclusion, verifyInclusion,
  bytesEqual, toHex, fromHex, quantize,
  MEMORY_HARD_WORDS, MEMORY_HARD_ROUNDS,
} from '../src/merkle.js';

const row = (n, seed = 0) => Array.from({ length: n }, (_, i) => Math.sin(i + seed) * 3);

// --------------------------------------------------------------------------
// Row hashing: requires the full row, tolerates cross-implementation fp drift
// --------------------------------------------------------------------------

test('hashRow is deterministic for identical input', async () => {
  const r = row(64);
  assert.ok(bytesEqual(await hashRow(r), await hashRow(r)));
});

test('hashRow tolerates fp32-scale drift the way honest implementations produce it', async () => {
  const r = row(64);
  const drifted = r.map((v) => v + 1e-6);
  assert.ok(bytesEqual(await hashRow(r), await hashRow(drifted)),
    'quantization must absorb the kind of drift two honest GEMM implementations produce');
});

test('hashRow is sensitive to a real divergence in a single element', async () => {
  const r = row(64);
  const corrupted = [...r];
  corrupted[10] += 5;
  assert.ok(!bytesEqual(await hashRow(r), await hashRow(corrupted)));
});

test('hashRow distinguishes reordered rows', async () => {
  const r = row(64);
  const reversed = [...r].reverse();
  assert.ok(!bytesEqual(await hashRow(r), await hashRow(reversed)),
    'row hashing must be position-sensitive, unlike ShardResult.digest() which is not');
});

// --------------------------------------------------------------------------
// Memory-hard commitment (Q7/ADR-0013 mitigation) -- opt-in, off by default
// --------------------------------------------------------------------------
// A small buffer for these correctness tests: the property under test is
// "does the function behave correctly," not "is it expensive." The actual
// cost at production-sized buffers is measured separately in
// bench/memory_hard_overhead.py, not asserted on here -- timing assertions
// in a correctness suite are exactly the kind of flaky test this project's
// own conventions (docs/testing-strategy.md) avoid.
const MH_TEST_OPTS = { memoryHard: true, memoryHardWords: 256, memoryHardRounds: 1 };

test('hashRow defaults to memoryHard: false -- identical output to calling it with no options', async () => {
  const r = row(64);
  assert.ok(bytesEqual(await hashRow(r), await hashRow(r, { memoryHard: false })));
});

test('hashRow(memoryHard: true) differs from the plain hash of the same row', async () => {
  const r = row(64);
  assert.ok(!bytesEqual(await hashRow(r), await hashRow(r, MH_TEST_OPTS)),
    'the memory-hard path must not silently collapse to the plain digest');
});

test('hashRow(memoryHard: true) is deterministic for identical input', async () => {
  const r = row(64);
  assert.ok(bytesEqual(await hashRow(r, MH_TEST_OPTS), await hashRow(r, MH_TEST_OPTS)),
    'prover and verifier must reproduce the identical commitment for the same row');
});

test('hashRow(memoryHard: true) is sensitive to a real divergence in a single element', async () => {
  const r = row(64);
  const corrupted = [...r];
  corrupted[10] += 5;
  assert.ok(!bytesEqual(await hashRow(r, MH_TEST_OPTS), await hashRow(corrupted, MH_TEST_OPTS)),
    'the memory-hard path must still bind to the row\'s actual values, not just its length');
});

test('hashRow(memoryHard: true) respects overridden word/round counts', async () => {
  const r = row(64);
  const a = await hashRow(r, { memoryHard: true, memoryHardWords: 256, memoryHardRounds: 1 });
  const b = await hashRow(r, { memoryHard: true, memoryHardWords: 512, memoryHardRounds: 1 });
  assert.ok(!bytesEqual(a, b), 'different buffer sizes must produce different commitments');
});

test('the exported defaults are what the module docstring claims', () => {
  assert.equal(MEMORY_HARD_WORDS, 1 << 14);
  assert.equal(MEMORY_HARD_ROUNDS, 2);
});

test('quantize rounds to the documented scale', () => {
  assert.equal(quantize(1.00001), Math.round(1.00001 * 1e4));
});

// --------------------------------------------------------------------------
// Tree construction and inclusion proofs -- the core protocol
// --------------------------------------------------------------------------

async function leavesFor(rows) {
  return Promise.all(rows.map(hashRow));
}

test('every leaf in a power-of-two tree has a valid inclusion proof', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(16, i));
  const leaves = await leavesFor(rows);
  const { root, layers } = await buildMerkleTree(leaves);

  for (let i = 0; i < leaves.length; i++) {
    const proof = proveInclusion(layers, i);
    assert.ok(await verifyInclusion(leaves[i], proof, root),
      `leaf ${i} failed to verify against the root`);
  }
});

test('every leaf in an odd-sized tree has a valid inclusion proof', async () => {
  // Odd leaf counts exercise the last-node duplication path.
  for (const n of [1, 3, 5, 7, 9]) {
    const rows = Array.from({ length: n }, (_, i) => row(8, i));
    const leaves = await leavesFor(rows);
    const { root, layers } = await buildMerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = proveInclusion(layers, i);
      assert.ok(await verifyInclusion(leaves[i], proof, root),
        `n=${n}: leaf ${i} failed to verify`);
    }
  }
});

test('a tree sized like a real matmul shard (1024 rows) verifies end to end', async () => {
  // Cheap to run: this is n leaf hashes and O(n log n) internal hashes, not
  // the O(n^3) GEMM the commitment stands in for.
  const n = 1024;
  const leaves = await leavesFor(Array.from({ length: n }, (_, i) => row(n, i)));
  const { root, layers } = await buildMerkleTree(leaves);
  for (const i of [0, 1, 511, 512, 1022, 1023]) {
    const proof = proveInclusion(layers, i);
    assert.ok(await verifyInclusion(leaves[i], proof, root));
  }
});

test('two workers who honestly computed the same shard produce the same root', async () => {
  // The property that makes cross-worker root comparison meaningful in
  // consensus (M2.3): independent honest computation converges, small fp
  // differences and all.
  const honest = Array.from({ length: 16 }, (_, i) => row(32, i));
  const alsoHonest = honest.map((r) => r.map((v) => v + 1e-6)); // simulated GPU drift

  const rootA = (await buildMerkleTree(await leavesFor(honest))).root;
  const rootB = (await buildMerkleTree(await leavesFor(alsoHonest))).root;
  assert.ok(bytesEqual(rootA, rootB));
});

// --------------------------------------------------------------------------
// Forgery must fail
// --------------------------------------------------------------------------

test('a tampered leaf fails inclusion against the original root', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(16, i));
  const leaves = await leavesFor(rows);
  const { root, layers } = await buildMerkleTree(leaves);

  const forgedLeaf = await hashRow(row(16, 99)); // a row that was never in the tree
  const proof = proveInclusion(layers, 3);
  assert.ok(!(await verifyInclusion(forgedLeaf, proof, root)),
    'a leaf that was never committed must not verify');
});

test('a proof from one tree does not verify against a different root', async () => {
  const rowsA = Array.from({ length: 8 }, (_, i) => row(16, i));
  const rowsB = Array.from({ length: 8 }, (_, i) => row(16, i + 100));
  const leavesA = await leavesFor(rowsA);
  const leavesB = await leavesFor(rowsB);
  const treeA = await buildMerkleTree(leavesA);
  const treeB = await buildMerkleTree(leavesB);

  const proof = proveInclusion(treeA.layers, 2);
  assert.ok(!(await verifyInclusion(leavesA[2], proof, treeB.root)),
    'a valid proof for one root must not also verify against an unrelated root');
});

test('proveInclusion rejects an out-of-range index', async () => {
  const leaves = await leavesFor([row(8), row(8, 1)]);
  const { layers } = await buildMerkleTree(leaves);
  assert.throws(() => proveInclusion(layers, -1), RangeError);
  assert.throws(() => proveInclusion(layers, 2), RangeError);
});

test('buildMerkleTree rejects an empty leaf set', async () => {
  await assert.rejects(() => buildMerkleTree([]), RangeError);
});

// --------------------------------------------------------------------------
// Encoding helpers
// --------------------------------------------------------------------------

test('toHex/fromHex round-trip', async () => {
  const h = await hashRow(row(32));
  assert.ok(bytesEqual(fromHex(toHex(h)), h));
});

test('fromHex rejects odd-length input', () => {
  assert.throws(() => fromHex('abc'), TypeError);
});
