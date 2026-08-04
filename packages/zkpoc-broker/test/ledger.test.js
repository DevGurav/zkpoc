import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CreditLedger, ViolationReason, InsufficientStakeError } from '../src/ledger.js';

// --------------------------------------------------------------------------
// Stake and balance are separate on purpose -- see the module docstring.
// --------------------------------------------------------------------------

test('deposit increases stake and nothing else', () => {
  const l = new CreditLedger();
  l.deposit('w1', 100);
  assert.equal(l.stakeOf('w1'), 100);
  assert.equal(l.balanceOf('w1'), 0);
});

test('reward increases balance and never touches stake', () => {
  const l = new CreditLedger({ rewardPerShard: 1 });
  l.deposit('w1', 50);
  l.reward('w1', 3);
  assert.equal(l.balanceOf('w1'), 3);
  assert.equal(l.stakeOf('w1'), 50, 'earning a reward must not itself post or consume stake');
});

test('deposit is additive across multiple calls', () => {
  const l = new CreditLedger();
  l.deposit('w1', 10);
  l.deposit('w1', 5);
  assert.equal(l.stakeOf('w1'), 15);
});

test('an unknown worker has zero stake and zero balance, not an error', () => {
  const l = new CreditLedger();
  assert.equal(l.stakeOf('ghost'), 0);
  assert.equal(l.balanceOf('ghost'), 0);
  assert.equal(l.stakeShards('ghost'), 0);
});

test('deposit and reward reject non-positive amounts', () => {
  const l = new CreditLedger();
  assert.throws(() => l.deposit('w1', 0), RangeError);
  assert.throws(() => l.deposit('w1', -5), RangeError);
  assert.throws(() => l.reward('w1', 0), RangeError);
  assert.throws(() => l.deposit(null, 5), TypeError);
});

// --------------------------------------------------------------------------
// stakeShards() -- the unit audit.js#minAuditRate expects
// --------------------------------------------------------------------------

test('stakeShards converts raw stake into the unit minAuditRate expects', () => {
  const l = new CreditLedger({ rewardPerShard: 4 });
  l.deposit('w1', 400);
  assert.equal(l.stakeShards('w1'), 100);
});

test('rewardPerShard must be positive', () => {
  assert.throws(() => new CreditLedger({ rewardPerShard: 0 }), RangeError);
  assert.throws(() => new CreditLedger({ rewardPerShard: -1 }), RangeError);
});

// --------------------------------------------------------------------------
// Withdrawal
// --------------------------------------------------------------------------

test('withdraw reduces stake by the requested amount', () => {
  const l = new CreditLedger();
  l.deposit('w1', 100);
  l.withdraw('w1', 40);
  assert.equal(l.stakeOf('w1'), 60);
});

test('withdraw beyond the posted stake is rejected, not silently clamped', () => {
  const l = new CreditLedger();
  l.deposit('w1', 10);
  assert.throws(() => l.withdraw('w1', 11), InsufficientStakeError);
  assert.equal(l.stakeOf('w1'), 10, 'a rejected withdrawal must not partially apply');
});

// --------------------------------------------------------------------------
// Slashing -- the deterrence the inspection-game formula assumes exists
// --------------------------------------------------------------------------

test('slash forfeits the full stake by default (slashFraction=1.0)', () => {
  const l = new CreditLedger();
  l.deposit('w1', 100);
  const r = l.slash('w1', ViolationReason.GATE_FAILURE);
  assert.equal(r.slashed, 100);
  assert.equal(r.remainingStake, 0);
  assert.equal(l.stakeOf('w1'), 0);
});

test('slashFraction supports graduated penalties instead of total forfeiture', () => {
  const l = new CreditLedger({ slashFraction: 0.25 });
  l.deposit('w1', 100);
  const r = l.slash('w1', ViolationReason.MINORITY_ROOT);
  assert.equal(r.slashed, 25);
  assert.equal(l.stakeOf('w1'), 75);
});

test('slashFraction must be in (0, 1]', () => {
  assert.throws(() => new CreditLedger({ slashFraction: 0 }), RangeError);
  assert.throws(() => new CreditLedger({ slashFraction: 1.5 }), RangeError);
});

test('slash rejects an unrecognised reason rather than accepting an ad hoc string', () => {
  const l = new CreditLedger();
  l.deposit('w1', 100);
  assert.throws(() => l.slash('w1', 'because I said so'), TypeError);
  assert.equal(l.stakeOf('w1'), 100, 'a rejected slash must not partially apply');
});

test('slashing an already-empty stake does not throw and is still logged', () => {
  const l = new CreditLedger();
  const r = l.slash('never-staked', ViolationReason.FAILED_AUDIT);
  assert.equal(r.slashed, 0);
  assert.equal(r.remainingStake, 0);
  assert.equal(l.history('never-staked').length, 1);
});

test('every ViolationReason value is accepted by slash', () => {
  const l = new CreditLedger();
  for (const reason of Object.values(ViolationReason)) {
    l.deposit('w', 10);
    assert.doesNotThrow(() => l.slash('w', reason));
  }
});

// --------------------------------------------------------------------------
// History and summary
// --------------------------------------------------------------------------

test('history records deposit, reward, withdraw and slash in order', () => {
  const l = new CreditLedger();
  l.deposit('w1', 100);
  l.reward('w1', 2);
  l.withdraw('w1', 10);
  l.slash('w1', ViolationReason.NO_DISCLOSURE);
  const types = l.history('w1').map((e) => e.type);
  assert.deepEqual(types, ['deposit', 'reward', 'withdraw', 'slash']);
});

test('history returns a defensive copy, not the live array', () => {
  const l = new CreditLedger();
  l.deposit('w1', 10);
  const h = l.history('w1');
  h.push({ fabricated: true });
  assert.equal(l.history('w1').length, 1, 'mutating the returned array must not affect the ledger');
});

test('summary reports stake, stakeShards, balance and violation count together', () => {
  const l = new CreditLedger({ rewardPerShard: 2, slashFraction: 0.5 });
  l.deposit('w1', 20);
  l.reward('w1', 3);
  l.slash('w1', ViolationReason.GATE_FAILURE);
  l.slash('w1', ViolationReason.MINORITY_ROOT);

  const s = l.summary('w1');
  assert.equal(s.workerId, 'w1');
  assert.equal(s.stake, 5, '20 -> slash 50% (10) -> 10 -> slash 50% (5) -> 5');
  assert.equal(s.stakeShards, 2.5);
  assert.equal(s.balance, 6);
  assert.equal(s.violations, 2);
});
