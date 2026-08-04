/**
 * Resource governor.
 *
 * Holds the schedule, and therefore holds the power. The worker executes
 * bursts of a size dictated here and reports how long it was actually busy;
 * every limit in the Compute Consent Manifest is enforced by withholding time,
 * not by asking the workload to behave.
 *
 * The share controller is integral, not per-burst. Sleeping
 * `busy * (1/target - 1)` after each burst sets the *instantaneous* share to
 * the target but lets error accumulate: a burst that overshoots its budget is
 * never paid back, so the session-long share creeps above what the user
 * consented to. Instead the target wall-clock is recomputed from cumulative
 * busy time each cycle, so overshoot in one burst is repaid by the next and
 * cumulative share converges on the declared ceiling from below.
 *
 * Four independent conditions can throttle or stop execution:
 *
 *   interaction  the user did something; yield immediately and stay quiet
 *   frames       the page is dropping frames; reduce share
 *   thermal      sustained throughput has decayed; reduce share
 *   battery      discharging past the configured floor; reduce share or stop
 *
 * These compose multiplicatively rather than overriding one another, so a hot
 * laptop on battery while the user is scrolling ends up quieter than any one
 * signal would make it.
 */

/**
 * The share control law, as a pure function so it can be tested without a
 * browser. Returns how long to idle after a burst.
 *
 * Integral, not proportional: the idle time is whatever makes cumulative
 * busy/wall equal the target, so a burst that overran its budget is repaid
 * by the next idle instead of permanently inflating the session average.
 *
 * @param {number} busyTotalMs   cumulative busy time this session
 * @param {number} wallElapsedMs cumulative wall time this session
 * @param {number} targetShare   (0,1]
 * @param {number} [maxIdleMs]   clamp, so a pathological burst cannot stall
 *                               the session for minutes
 */
export function nextIdleMs(busyTotalMs, wallElapsedMs, targetShare, maxIdleMs = 2000) {
  const target = Math.max(0.001, targetShare);
  const desiredWallMs = busyTotalMs / target;
  return clamp(desiredWallMs - wallElapsedMs, 0, maxIdleMs);
}

const DEFAULTS = Object.freeze({
  burstMs: 12,              // ~1 frame; small enough to yield promptly
  tickMs: 250,              // telemetry cadence
  interactionQuietMs: 400,  // stay preempted this long after the last input
  longFrameMs: 50,          // a frame this long counts as dropped
  thermalWindow: 8,         // bursts averaged for throughput decay
  thermalTripRatio: 0.80,   // below this fraction of baseline => throttled
  batteryFloor: 0.20,       // stop below this charge when discharging
  wattsAtFull: 25,          // for the energy ESTIMATE; see note in tick()
});

export const State = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PREEMPTED: 'preempted',
  BACKOFF: 'backoff',
  STOPPED: 'stopped',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  DENIED: 'denied',
});

export class Governor extends EventTarget {
  /**
   * @param {object} o
   * @param {URL|string} o.workerUrl
   * @param {object} o.manifest      a manifest that has ALREADY been verified
   * @param {object} o.verification  the verifyManifest() result
   * @param {'gpu'|'cpu'} [o.path]
   * @param {number} [o.matrixN]
   * @param {object} [o.tuning]
   */
  constructor(o) {
    super();
    this.workerUrl = o.workerUrl;
    this.manifest = o.manifest;
    this.verification = o.verification;
    this.path = o.path ?? 'gpu';
    this.matrixN = o.matrixN ?? 256;
    this.cfg = { ...DEFAULTS, ...(o.tuning ?? {}) };

    this.state = State.IDLE;
    this.worker = null;
    this._stopFlag = false;

    // accounting
    this.startedAt = 0;
    this.busyMs = 0;
    this.wallMs = 0;
    this.shards = 0;
    this.flops = 0;
    this.energyMwh = 0;

    // throttle signals
    this.lastInteraction = 0;
    this.longFrames = 0;
    this.totalFrames = 0;
    this.throughputBaseline = null;
    this.recentGflops = [];
    this.thermalThrottled = false;
    this.battery = null;
    this.batteryStart = null;
    this.backoffFactor = 1.0;
    this.actualPath = null;
    this.denialReason = null;

    this._onInteraction = () => { this.lastInteraction = performance.now(); };
    this._rafHandle = 0;
    this._lastFrameAt = 0;
  }

  /** The ceiling this session may never exceed, taken from the manifest. */
  get declaredShare() {
    const L = this.manifest?.limits ?? {};
    return this.path === 'gpu' ? (L.gpu_share_max ?? 0) : (L.cpu_share_max ?? 0);
  }

  /** Declared ceiling reduced by whatever back-off is currently active. */
  get targetShare() {
    return this.declaredShare * this.backoffFactor;
  }

  get achievedShare() {
    return this.wallMs > 0 ? this.busyMs / this.wallMs : 0;
  }

  get elapsedS() {
    return this.wallMs / 1000;
  }

  // ------------------------------------------------------------------ start

  async start() {
    // A manifest that did not verify does not get to run. This is the whole
    // contract: refusing here is what makes the declaration worth anything.
    if (!this.verification?.ok) {
      this.denialReason =
        this.verification?.errors?.join('; ') ?? 'manifest not verified';
      this._setState(State.DENIED);
      return false;
    }
    if (this.declaredShare <= 0) {
      this.denialReason = `manifest declares no ${this.path} share`;
      this._setState(State.DENIED);
      return false;
    }

    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this._pending = new Map();
    this._nextId = 1;
    this.worker.onmessage = (ev) => {
      const { id, ok, ...rest } = ev.data ?? {};
      const p = this._pending.get(id);
      if (p) { this._pending.delete(id); ok ? p.resolve(rest) : p.reject(new Error(rest.error)); }
    };

    const init = await this._call('init', { n: this.matrixN, path: this.path });
    this.actualPath = init.path;
    if (init.fellBack) {
      this.dispatchEvent(new CustomEvent('fallback', { detail: init }));
    }

    await this._initBattery();
    this._attachInteractionListeners();
    this._startFrameMonitor();

    this.startedAt = performance.now();
    this._lastTick = 0;
    this._stopFlag = false;
    this._setState(State.RUNNING);
    this._loop();                       // deliberately not awaited
    return true;
  }

  /** User-initiated revocation. Must be instant and unconditional. */
  revoke() { this._stopFlag = true; this._finish(State.REVOKED); }

  stop() { this._stopFlag = true; this._finish(State.STOPPED); }

  // ------------------------------------------------------------- main loop

  async _loop() {
    while (!this._stopFlag) {
      const now = performance.now();
      this.wallMs = now - this.startedAt;

      // -- hard stops, checked before any work is scheduled
      const L = this.manifest.limits;
      if (this.elapsedS >= L.duration_max_s) return this._finish(State.EXPIRED);
      if (Date.now() >= Date.parse(this.manifest.session.expires_at)) {
        return this._finish(State.EXPIRED);
      }
      if (L.energy_max_mwh !== undefined && this.energyMwh >= L.energy_max_mwh) {
        return this._finish(State.EXPIRED);
      }
      if (this.battery && !this.battery.charging
          && this.battery.level < this.cfg.batteryFloor) {
        return this._finish(State.STOPPED);
      }

      // -- user interaction preempts everything else
      if (now - this.lastInteraction < this.cfg.interactionQuietMs) {
        if (this.state !== State.PREEMPTED) this._setState(State.PREEMPTED);
        await sleep(50);
        this._maybeTick();
        continue;
      }

      this._updateBackoff();
      if (this.state !== State.RUNNING && this.state !== State.BACKOFF) {
        this._setState(this.backoffFactor < 1 ? State.BACKOFF : State.RUNNING);
      }

      // -- one burst
      let r;
      try {
        r = await this._call('burst', { budgetMs: this.cfg.burstMs });
      } catch (err) {
        this.dispatchEvent(new CustomEvent('error', { detail: String(err) }));
        return this._finish(State.STOPPED);
      }
      if (this._stopFlag) break;

      this.busyMs += r.busyMs;
      this.shards += r.shardsDone;
      this.flops += r.flops;
      this._recordThroughput(r);

      // -- integral share control: repay cumulative overshoot, never average
      //    above the declared ceiling
      const idleMs = nextIdleMs(this.busyMs,
                                performance.now() - this.startedAt,
                                this.targetShare);

      this._maybeTick();
      if (idleMs > 0) await sleep(idleMs);
    }
  }

  // --------------------------------------------------------- throttle logic

  _updateBackoff() {
    let f = 1.0;

    // frame health: sustained long frames mean the user can see us
    if (this.totalFrames > 30) {
      const bad = this.longFrames / this.totalFrames;
      if (bad > 0.10) f *= 0.5;
      else if (bad > 0.03) f *= 0.75;
    }

    // thermal proxy: no browser API exposes temperature, so sustained
    // throughput decay stands in for it. Crude, but it is the only signal
    // available from inside a tab, and it is the one FibRace flagged as
    // unmeasured.
    if (this.thermalThrottled) f *= 0.6;

    // battery: discharging is a cost the user is paying in hardware
    if (this.battery && !this.battery.charging) {
      f *= this.battery.level < 0.4 ? 0.5 : 0.75;
    }

    this.backoffFactor = f;
  }

  _recordThroughput(r) {
    if (r.busyMs <= 0) return;
    const g = r.flops / (r.busyMs / 1000) / 1e9;
    this.recentGflops.push(g);
    if (this.recentGflops.length > this.cfg.thermalWindow * 3) {
      this.recentGflops.shift();
    }
    const w = this.cfg.thermalWindow;
    if (this.throughputBaseline === null && this.recentGflops.length >= w) {
      this.throughputBaseline = avg(this.recentGflops.slice(0, w));
    }
    if (this.throughputBaseline) {
      const recent = avg(this.recentGflops.slice(-w));
      this.thermalThrottled = recent < this.throughputBaseline * this.cfg.thermalTripRatio;
    }
  }

  // ------------------------------------------------------------- telemetry

  _maybeTick() {
    const now = performance.now();
    if (now - this._lastTick < this.cfg.tickMs) return;
    this._lastTick = now;
    this.wallMs = now - this.startedAt;

    // Energy is an ESTIMATE. Browsers expose no power draw, so this is
    // wattsAtFull * achievedShare * time, calibrated from host-side
    // measurement in bench/. Battery delta is reported alongside where the
    // Battery Status API is available, as a weak cross-check.
    this.energyMwh = this.cfg.wattsAtFull * this.achievedShare
                   * (this.wallMs / 3600000) * 1000;

    this.dispatchEvent(new CustomEvent('tick', { detail: this.telemetry() }));
  }

  telemetry() {
    const batteryDelta = (this.battery && this.batteryStart !== null)
      ? this.batteryStart - this.battery.level : null;
    return {
      state: this.state,
      path: this.actualPath,
      declaredShare: this.declaredShare,
      targetShare: this.targetShare,
      achievedShare: this.achievedShare,
      backoffFactor: this.backoffFactor,
      elapsedS: this.elapsedS,
      durationMaxS: this.manifest?.limits?.duration_max_s ?? null,
      busyMs: this.busyMs,
      shards: this.shards,
      gflops: this.busyMs > 0 ? this.flops / (this.busyMs / 1000) / 1e9 : 0,
      energyMwh: this.energyMwh,
      energyMaxMwh: this.manifest?.limits?.energy_max_mwh ?? null,
      longFrames: this.longFrames,
      totalFrames: this.totalFrames,
      thermalThrottled: this.thermalThrottled,
      battery: this.battery
        ? { level: this.battery.level, charging: this.battery.charging,
            deltaSinceStart: batteryDelta }
        : null,
      denialReason: this.denialReason,
    };
  }

  /** Ask the worker for a result sample so output can be checked, not trusted. */
  async sampleResult() {
    if (!this.worker) return null;
    const r = await this._call('sample', {});
    const rel = Math.abs(r.value - r.expected) / Math.max(1e-6, Math.abs(r.expected));
    return { ...r, relError: rel, correct: rel < 1e-3 };
  }

  // ---------------------------------------------------------------- plumbing

  _call(type, payload) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async _initBattery() {
    if (!navigator.getBattery) return;
    try {
      this.battery = await navigator.getBattery();
      this.batteryStart = this.battery.level;
      for (const ev of ['levelchange', 'chargingchange']) {
        this.battery.addEventListener(ev, () => this._updateBackoff());
      }
    } catch { /* not available; back-off simply loses one input */ }
  }

  _attachInteractionListeners() {
    const opts = { passive: true, capture: true };
    this._interactionEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'];
    for (const e of this._interactionEvents) {
      addEventListener(e, this._onInteraction, opts);
    }
  }

  _detachInteractionListeners() {
    const opts = { capture: true };
    for (const e of this._interactionEvents ?? []) {
      removeEventListener(e, this._onInteraction, opts);
    }
  }

  _startFrameMonitor() {
    const step = (t) => {
      if (this._lastFrameAt) {
        const dt = t - this._lastFrameAt;
        this.totalFrames++;
        if (dt > this.cfg.longFrameMs) this.longFrames++;
      }
      this._lastFrameAt = t;
      if (!this._stopFlag) this._rafHandle = requestAnimationFrame(step);
    };
    this._rafHandle = requestAnimationFrame(step);
  }

  _finish(state) {
    this._stopFlag = true;
    this._detachInteractionListeners();
    cancelAnimationFrame(this._rafHandle);
    if (this.worker) {
      try { this.worker.postMessage({ id: -1, type: 'stop' }); } catch {}
      // Terminate rather than wait: revocation has to be immediate, and a
      // worker mid-dispatch has no way to acknowledge promptly.
      this.worker.terminate();
      this.worker = null;
    }
    this._setState(state);
    this.dispatchEvent(new CustomEvent('stopped', { detail: this.telemetry() }));
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: this.telemetry() }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
