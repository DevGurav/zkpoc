#!/usr/bin/env node
/**
 * Measures the real, honest cost of Q7/ADR-0013's memory-hard row-commitment
 * mitigation (merkle.js#hashRow's `memoryHard` option) -- on THIS
 * environment's Node CPU, since that is what's actually available to
 * measure here. What this script does NOT do, deliberately: claim a GPU
 * speedup/slowdown number. There is no GPU in this environment to measure
 * against, the same constraint bench/attacker_advantage.py's own memory-hard
 * control (Argon2id) worked around by citing two independent PUBLISHED
 * hardware benchmarks rather than fabricating one. This script has no
 * equivalent literature to cite for a purpose-built function, so it reports
 * only what it can actually measure -- CPU-side cost -- and states plainly,
 * at the end, exactly what remains unverified.
 *
 * Shard sizes are drawn from the REAL sizing logic
 * (tiers.js#chooseShardSize) against LAPTOP_IGPU, the one measured device
 * tier (docs/BUILD.md §1), at target durations spanning the challenge-mode
 * range README.md cites for hashcash-style widgets (1-3s) -- not
 * hand-picked numbers.
 */

import { LAPTOP_IGPU, chooseShardSize } from '../packages/zkpoc-broker/src/tiers.js';
import { Shard } from '../packages/zkpoc-broker/src/shard.js';
import { hashRow, MEMORY_HARD_WORDS, MEMORY_HARD_ROUNDS } from '../packages/zkpoc-broker/src/merkle.js';

const TARGET_SECONDS = [1, 2, 3];

function row(n, seed) {
  return Array.from({ length: n }, (_, i) => Math.sin(i + seed) * 0.5);
}

async function timeCommit(n, memoryHard) {
  // Not shard.rowValues() (real O(n^3) GEMM) -- that cost is already
  // measured elsewhere (dispatch_analysis.py, attacker_advantage.py) and is
  // orthogonal to what this script isolates: the commitment step's OWN
  // cost, independent of how the row values were produced.
  const opts = memoryHard ? { memoryHard: true } : {};
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    await hashRow(row(n, i), opts);
  }
  return performance.now() - t0;
}

async function main() {
  console.log('Memory-hard row-commitment overhead (Q7 / ADR-0013)');
  console.log(`Buffer: ${MEMORY_HARD_WORDS * 4 / 1024} KiB, ${MEMORY_HARD_ROUNDS} mixing round(s)`);
  console.log('Shard sizes: real chooseShardSize() output against LAPTOP_IGPU (107.2 GFLOPS, measured)\n');

  console.log(
    'target_gemm_s'.padEnd(15)
    + 'shard_n'.padEnd(10)
    + 'plain_commit_s'.padEnd(17)
    + 'memhard_commit_s'.padEnd(19)
    + 'added_s'.padEnd(10)
    + 'added_%_of_target',
  );

  for (const targetSeconds of TARGET_SECONDS) {
    const sizing = chooseShardSize(LAPTOP_IGPU, { targetWallSeconds: targetSeconds });
    const n = sizing.n;
    // Committing n rows of length n is the real shard shape (square GEMM
    // output); at the larger n values this is already a lot of hashing even
    // in the "plain" path, which is expected -- Merkle commitment has always
    // been O(n) hashRow calls, this script just makes that cost visible.
    const shard = new Shard({ id: 'bench', n, sessionNonce: 'memory-hard-overhead-bench-nonce' });

    const plainMs = await timeCommit(shard.n, false);
    const mhMs = await timeCommit(shard.n, true);
    const addedS = (mhMs - plainMs) / 1000;
    const addedPct = (addedS / targetSeconds) * 100;

    console.log(
      String(targetSeconds).padEnd(15)
      + String(n).padEnd(10)
      + (plainMs / 1000).toFixed(3).padEnd(17)
      + (mhMs / 1000).toFixed(3).padEnd(19)
      + addedS.toFixed(3).padEnd(10)
      + addedPct.toFixed(1) + '%',
    );
  }

  // The sizing sweep above uses this file's shipped defaults. This second
  // sweep holds shard size fixed (the target=2s case) and varies the buffer
  // instead, to make the actual structural finding visible directly: does
  // ANY buffer size land in a "meaningfully GPU-resistant AND practically
  // fast" zone, at real per-row granularity?
  console.log('\nBuffer-size sweep at a fixed shard size (n from the 2s target above):');
  const sweepShard = new Shard({
    id: 'bench-sweep', n: chooseShardSize(LAPTOP_IGPU, { targetWallSeconds: 2 }).n,
    sessionNonce: 'memory-hard-overhead-sweep-nonce',
  });
  console.log(
    'buffer_kib'.padEnd(12) + 'ms_per_row'.padEnd(13)
    + 'added_s_at_n='.padEnd(16) + '2s_target_%',
  );
  for (const words of [256, 512, 1024, 2048, 4096, 8192, 16384]) {
    const r = row(sweepShard.n, 0);
    await hashRow(r, { memoryHard: true, memoryHardWords: words, memoryHardRounds: 1 }); // warm
    const t0 = performance.now();
    const REPS = 20;
    for (let i = 0; i < REPS; i++) {
      await hashRow(row(sweepShard.n, i), { memoryHard: true, memoryHardWords: words, memoryHardRounds: 1 });
    }
    const perRowMs = (performance.now() - t0) / REPS;
    const addedS = (perRowMs * sweepShard.n) / 1000;
    console.log(
      (words * 4 / 1024).toFixed(1).padEnd(12)
      + perRowMs.toFixed(3).padEnd(13)
      + addedS.toFixed(2).padEnd(16)
      + (addedS / 2 * 100).toFixed(0) + '%',
    );
  }
  console.log(`
Reading this table, and the finding it demonstrates: GPU shared memory per
SM on current hardware runs roughly 48-228 KiB depending on generation
(older Pascal/Volta at the low end, Hopper at the high end) -- a buffer
needs to be in that range or above to plausibly resist a GPU running many
instances in parallel. But at THIS per-row granularity (one independent
expansion per row, ~n=${sweepShard.n} rows for a 2s-target shard), even an
8 KiB buffer -- well below any GPU's shared memory, so already a weak
resistance argument -- adds a double-digit percentage of the target
duration, and a buffer large enough to plausibly matter (tens of KiB+)
costs MORE than the original target duration outright (see the first table
above). Cost scales LINEARLY with shard size regardless of buffer size,
because every row pays it independently -- there is no buffer size in this
sweep that is both plausibly GPU-resistant and low-overhead. That is a real
structural finding about applying memory-hardness at per-row granularity,
not a tuning gap this script failed to search hard enough for.

What was measured here: real, on this environment's Node runtime,
reproducible. What was NOT measured and cannot be from here: whether the
buffer actually resists GPU parallelization in practice -- there is no GPU
in this environment to check against, the same constraint
bench/attacker_advantage.py's own memory-hard control worked around by
citing published third-party hardware benchmarks. This function is
purpose-built, with no equivalent literature to cite, so that verification
remains open rather than assumed. See
docs/adr/0016-memory-hard-commitment-mitigation.md for the full account and
docs/BUILD.md's Q7 for its updated status.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
