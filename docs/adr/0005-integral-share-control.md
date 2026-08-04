# ADR-0005: Integral, not per-burst, share control law in the governor

Status: Accepted (2026-08-03)

## Context

The resource governor (`packages/zkpoc-worker/src/governor.js`) must keep a
session's *cumulative* device share at or below the ceiling a Compute Consent
Manifest declares (ADR-0002) — not just at some instant, but averaged over
the whole session, since that average is what the manifest's `energy_max_mwh`
and the user's expectation of "5% of my device" actually mean.

The naive approach — after a burst of length `busy`, sleep for
`busy * (1/target − 1)` — sets the *instantaneous* share to `target`, but has
no memory: if a burst overruns its intended budget (GPU driver latency, a
`postMessage` round-trip taking longer than expected, a momentary OS
scheduling delay), that overrun is never repaid. Each overrun permanently
inflates the session-long average above what was declared, and the error only
accumulates in one direction.

## Decision

The controller is integral rather than proportional. After each burst, the
governor computes the wall-clock time that *would* make cumulative
`busy/wall` equal the target share, and idles for the difference:

```js
// packages/zkpoc-worker/src/governor.js
export function nextIdleMs(busyTotalMs, wallElapsedMs, targetShare, maxIdleMs = 2000) {
  const target = Math.max(0.001, targetShare);
  const desiredWallMs = busyTotalMs / target;
  return clamp(desiredWallMs - wallElapsedMs, 0, maxIdleMs);
}
```

Because this recomputes from *cumulative* busy and wall time rather than the
most recent burst alone, an overrun in one burst is automatically repaid by
extra idle time afterward — the session average converges on the target from
below rather than drifting above it. `maxIdleMs` (2000ms) caps the worst case
so a single pathological burst cannot stall the session for minutes while it
"pays down" a large overrun in one go.

Extracted as a pure function specifically so the control law can be tested
without a browser, GPU, or timers — see Consequences.

## Consequences

- `packages/zkpoc-worker/test/share-control.test.js` simulates sessions under
  the real control law and asserts properties a per-burst controller cannot
  guarantee: convergence to the declared share under well-behaved bursts,
  recovery from a single 2-second pathological burst without permanently
  inflating the average, and a peak instantaneous share (post-warmup) within
  5% of the declared ceiling.
- Four independent throttle signals (interaction, dropped frames, thermal
  proxy, battery — see `governor.js`'s module docstring) modulate
  `targetShare` via a multiplicative `backoffFactor`, and the integral law
  applies to whatever the *current* target is, so back-off decisions compose
  correctly with the repayment mechanism rather than fighting it.
- The controller has no notion of a "session budget" beyond the manifest's
  `duration_max_s` and `energy_max_mwh` — it optimises for share, not for
  total work done. A session that spends most of its time preempted by user
  interaction will simply run for longer wall-clock time to get the same
  amount of work in, rather than trying to "catch up" by exceeding its share
  once interaction stops.
- Alternative considered and rejected: proportional (per-burst) sleep, as
  above. Rejected once the failure mode was named explicitly — see
  Context — since it fails silently: a session under proportional control
  that suffers periodic overruns *looks* correct in every individual
  telemetry tick (each burst's instantaneous share is at target) while its
  cumulative average drifts upward, which is exactly the property a consent
  ceiling exists to prevent.
