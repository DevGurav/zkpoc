import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shard, resolveChallenge, ChallengeOutcome } from '../../zkpoc-broker/index.js';
import { solveChallenge } from '../index.js';

// A small, directly-constructed shard, not one sized via issueChallenge's
// real tier-based targetWallSeconds -- that sizing targets WebGPU wall-clock
// time on measured hardware (bench/attacker_advantage.py: 181.7x faster than
// this package's pure-JS reference solve path), so a shard sized for even a
// couple of GPU-seconds would take minutes to solve here. Same fixture
// pattern packages/zkpoc-broker/test/challenge.test.js already uses for the
// same reason.
const mkSmallShard = (o = {}) => new Shard({
  id: 'challenge-fixture', n: 32, sessionNonce: 'session-nonce-eeeeeeeeeeee', ...o,
});

test('solveChallenge produces a response the issuer admits', async () => {
  const shard = mkSmallShard();

  const response = await solveChallenge(shard.toJSON(), 'visitor-1');
  assert.equal(response.shardId, shard.id);
  assert.equal(response.workerId, 'visitor-1');

  const resolved = await resolveChallenge(shard, response, {});
  assert.equal(resolved.outcome, ChallengeOutcome.ADMIT, JSON.stringify(resolved.gate.failures));
});

test('solveChallenge is deterministic for a given shard descriptor', async () => {
  const shard = mkSmallShard();
  const a = await solveChallenge(shard.toJSON(), 'w1');
  const b = await solveChallenge(shard.toJSON(), 'w2');
  assert.equal(a.root, b.root, 'the same shard must commit to the same root regardless of workerId');
});

test('a response to the wrong shard is denied, not accidentally admitted', async () => {
  const shardA = mkSmallShard({ id: 'shard-a' });
  const shardB = mkSmallShard({ id: 'shard-b', sessionNonce: 'session-nonce-ffffffffffff' });

  const responseToA = await solveChallenge(shardA.toJSON(), 'visitor-1');
  const resolved = await resolveChallenge(shardB, responseToA, {});
  assert.equal(resolved.outcome, ChallengeOutcome.DENY);
});

// Small buffer, same reason packages/zkpoc-broker's own memory-hard tests
// use one -- this proves solveChallenge forwards the option correctly, not
// that the production-sized buffer is fast (see bench/memory_hard_overhead.py
// for the real cost).
test('solveChallenge forwards memoryHard through to the underlying commitment (Q7/ADR-0013)', async () => {
  const shard = mkSmallShard();
  const opts = { memoryHard: true, memoryHardWords: 256, memoryHardRounds: 1 };

  const response = await solveChallenge(shard.toJSON(), 'visitor-1', opts);
  const resolved = await resolveChallenge(shard, response, opts);
  assert.equal(resolved.outcome, ChallengeOutcome.ADMIT, JSON.stringify(resolved.gate.failures));

  // Confirms this genuinely went through the memory-hard path, not just that
  // the option was silently ignored: verifying without it must now fail.
  const resolvedWrong = await resolveChallenge(shard, response, {});
  assert.equal(resolvedWrong.outcome, ChallengeOutcome.DENY);
});
