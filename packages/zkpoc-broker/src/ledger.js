/**
 * Credit ledger: stake, reward, and slashing per worker.
 *
 * The inspection-game formula (audit.js#minAuditRate, ADR-0006) is just
 * arithmetic unless something real backs "k = stake in shards": a worker
 * who loses nothing by being caught cheating has no reason to behave, no
 * matter what audit rate the formula recommends. This module is that
 * something -- the deterrence the formula assumes actually exists.
 *
 * Two balances per worker, kept separate on purpose:
 *
 *   STAKE    at-risk collateral, posted before participating, forfeit
 *            (wholly or partially) on a confirmed violation. This is what
 *            `stakeShards()` feeds into minAuditRate() -- a worker's own
 *            posted stake determines how much audit scrutiny THEY need,
 *            not a global rate applied uniformly regardless of who is being
 *            checked.
 *   BALANCE  earned reward for confirmed work, withdrawable, never at risk.
 *
 * Conflating the two would mean a worker's payout for honest work also
 * funds their own deterrence bond, which breaks the incentive the stake is
 * supposed to provide.
 */

export const ViolationReason = Object.freeze({
  GATE_FAILURE: 'gate_failure',       // consensus.js Verdict.REJECTED
  MINORITY_ROOT: 'minority_root',     // consensus.js Verdict.MINORITY
  FAILED_AUDIT: 'failed_audit',       // audit.js#auditFull came back not-ok
  NO_DISCLOSURE: 'no_disclosure',     // selected for audit, never responded
});

export class InsufficientStakeError extends Error {
  constructor(workerId, requested, available) {
    super(`worker ${workerId} has ${available} staked, cannot withdraw ${requested}`);
    this.name = 'InsufficientStakeError';
    this.workerId = workerId;
  }
}

export class CreditLedger {
  /**
   * @param {object} [o]
   * @param {number} [o.rewardPerShard=1]  unit conversion between raw stake
   *   balance and "shards" as ADR-0006's k is expressed in -- stakeShards()
   *   divides by this, so stake and rewards share one consistent unit.
   * @param {number} [o.slashFraction=1.0]  fraction of current stake
   *   forfeit per violation. Default 1.0 matches the threat model this
   *   project's synopsis states: "Any deviation from the FL protocol
   *   results in the loss of the staked amount." A fractional value is
   *   supported for policies that want graduated penalties instead.
   */
  constructor(o = {}) {
    const { rewardPerShard = 1, slashFraction = 1.0 } = o;
    if (!(rewardPerShard > 0)) throw new RangeError('rewardPerShard must be > 0');
    if (!(slashFraction > 0 && slashFraction <= 1)) {
      throw new RangeError('slashFraction must be in (0, 1]');
    }
    this.rewardPerShard = rewardPerShard;
    this.slashFraction = slashFraction;
    /** @type {Map<string, number>} */
    this._stake = new Map();
    /** @type {Map<string, number>} */
    this._balance = new Map();
    /** @type {Map<string, Array<object>>} */
    this._history = new Map();
  }

  _log(workerId, event) {
    if (!this._history.has(workerId)) this._history.set(workerId, []);
    this._history.get(workerId).push(Object.freeze({ at: Date.now(), ...event }));
  }

  /** Post stake. The only way stake balance increases. */
  deposit(workerId, amount) {
    if (!workerId) throw new TypeError('deposit requires a workerId');
    if (!(amount > 0)) throw new RangeError('deposit amount must be > 0');
    this._stake.set(workerId, (this._stake.get(workerId) ?? 0) + amount);
    this._log(workerId, { type: 'deposit', amount });
    return this.stakeOf(workerId);
  }

  stakeOf(workerId) {
    return this._stake.get(workerId) ?? 0;
  }

  /** Stake expressed in shards, the unit ADR-0006's k and minAuditRate()
   * expect -- this is the value to pass to shouldAudit()/minAuditRate(). */
  stakeShards(workerId) {
    return this.stakeOf(workerId) / this.rewardPerShard;
  }

  /**
   * Withdraw stake back out. Not the common path (stake is meant to stay
   * posted while a worker is active) but present so a worker can exit
   * cleanly rather than the ledger only ever accumulating.
   */
  withdraw(workerId, amount) {
    const have = this.stakeOf(workerId);
    if (amount > have) throw new InsufficientStakeError(workerId, amount, have);
    this._stake.set(workerId, have - amount);
    this._log(workerId, { type: 'withdraw', amount });
    return this.stakeOf(workerId);
  }

  /** Credit a worker for confirmed work. Does not touch stake. */
  reward(workerId, shards = 1) {
    if (!(shards > 0)) throw new RangeError('reward shards must be > 0');
    const amount = shards * this.rewardPerShard;
    this._balance.set(workerId, (this._balance.get(workerId) ?? 0) + amount);
    this._log(workerId, { type: 'reward', amount, shards });
    return this.balanceOf(workerId);
  }

  balanceOf(workerId) {
    return this._balance.get(workerId) ?? 0;
  }

  /**
   * Forfeit stake for a confirmed violation. `reason` must be one of
   * ViolationReason -- an unrecognised reason is rejected rather than
   * silently accepted, so a caller cannot slash for an ad hoc string that
   * never gets audited for meaning.
   *
   * Slashing an already-empty stake is not an error: a worker with nothing
   * left to lose has already paid the maximum this mechanism can extract,
   * and the event is still logged so the history reflects the violation.
   *
   * @returns {{slashed:number, remainingStake:number}}
   */
  slash(workerId, reason, o = {}) {
    if (!Object.values(ViolationReason).includes(reason)) {
      throw new TypeError(`unrecognised violation reason: ${reason}`);
    }
    const have = this.stakeOf(workerId);
    const amount = have * this.slashFraction;
    this._stake.set(workerId, have - amount);
    this._log(workerId, { type: 'slash', reason, amount, shardId: o.shardId ?? null });
    return { slashed: amount, remainingStake: this.stakeOf(workerId) };
  }

  history(workerId) {
    return [...(this._history.get(workerId) ?? [])];
  }

  /** Snapshot for introspection/tests -- never mutate the returned object. */
  summary(workerId) {
    return {
      workerId,
      stake: this.stakeOf(workerId),
      stakeShards: this.stakeShards(workerId),
      balance: this.balanceOf(workerId),
      violations: this.history(workerId).filter((e) => e.type === 'slash').length,
    };
  }
}
