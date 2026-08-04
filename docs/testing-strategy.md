# Testing strategy

## Coverage map

34 automated tests, zero test-runner dependencies (`node --test`, stdlib
`node:assert/strict`) — deliberate, see [CONTRIBUTING.md](../CONTRIBUTING.md).

| File | Tests | What it actually verifies |
| --- | --- | --- |
| `packages/zkpoc-ccm/test/ccm.test.js` | 23 | Canonicalisation invariants (key-order independence, cycle/NaN/undefined rejection), sign/verify round trips, that **every field** is covered by the signature (mutation testing, one case per manifest field), structural validation, hard caps, policy checks independent of structure, JWK thumbprint stability |
| `packages/zkpoc-ccm/test/demo-flow.test.js` | 5 | The exact flow `demo/index.html` performs, against the **real files on disk** (not fixtures) — including the case that isolates the code-binding check from the signature check (see below) |
| `packages/zkpoc-worker/test/share-control.test.js` | 6 | The share-control law (`nextIdleMs`) in isolation: convergence, overshoot recovery, peak-share bound, proportionality — as a pure function, with no browser |

Run everything: `npm test` from the repo root (workspaces-aware).
Run one package: `npm test --prefix packages/zkpoc-ccm`.

## The test that matters most, and why

`demo-flow.test.js`'s `"a validly signed manifest cannot cover for different
served code"` is the load-bearing test in this repo. Every other
tamper test mutates the *signed manifest*, so the signature alone catches it
— which only proves ECDSA works, not that the Compute Consent Manifest format
does anything the signature doesn't already give you for free.

This test does something different: it leaves the manifest untouched and
validly signed, and changes what the page *serves* instead. Nothing is
forged, so the signature verifies. The assertion isn't just "verification
fails" — it asserts the failing check is `code.worker` **and no other check**:

```js
const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
assert.deepEqual(failed, ['code.worker'],
  `expected only code.worker to fail, got: ${failed.join(', ')}`);
```

If the signature check were also failing here, the test would be passing for
the wrong reason. This is the concrete demonstration behind
[ADR-0002](adr/0002-legitimacy-by-declaration-not-detection.md) — see the demo's
"Serve different code" tamper button for the same case walked through
interactively.

## Testing patterns used deliberately

- **Extract the control law as a pure function, test it without the thing it
  controls.** `Governor`'s share-control logic lives inline in a browser
  event loop with `performance.now()` and real timers — untestable directly
  without a browser. `nextIdleMs()` is pulled out
  (`packages/zkpoc-worker/src/governor.js`) purely so
  `share-control.test.js` can simulate hundreds of session-cycles in
  milliseconds and assert properties (convergence, overshoot recovery) a
  browser test could only approximate. See
  [ADR-0005](adr/0005-integral-share-control.md).
- **Test against real files, not fixtures, when the property under test is
  "this matches what's on disk."** `demo-flow.test.js` reads
  `packages/zkpoc-worker/src/worker.js` from disk with `readFile`, hashes it,
  and builds a manifest from that hash — exactly what `demo/index.html` does.
  A fixture string would defeat the point: if someone edits the worker
  without reissuing the manifest, this test must fail, and a hardcoded
  fixture can't detect that.
- **Assert the specific failing check, not just pass/fail.** Any test that
  tampers with one field and checks `verifyManifest().ok === false` is weak —
  it passes even if the wrong check caught it, or if multiple unrelated
  checks failed together for the wrong reasons. Prefer asserting exactly
  which check(s) failed (see the mutation-coverage test in `ccm.test.js` and
  the code-binding isolation test above).
- **Simulate adversarial inputs the control law must survive, not just happy
  paths.** `share-control.test.js` includes a burst that overruns its budget
  4× on every cycle, and a single pathological 2-second burst injected into
  an otherwise well-behaved session — both are the failure modes
  [ADR-0005](adr/0005-integral-share-control.md) exists to fix, tested
  directly rather than inferred from the fix compiling.

## Verified manually, not automated

Documented because "not tested" and "not checked" are different claims, and
these were checked — see the M1 build session's browser walkthrough.

- **WebGPU execution path**, including the CPU fallback badge when WebGPU is
  unavailable in-worker.
- **Frame-drop behaviour under load** — confirmed via the demo's `long
  frames` counter staying near-zero (1/2070 in the recorded session) while
  the share meter holds under the declared ceiling.
- **Interaction preemption** — scrolling/moving the mouse during a run flips
  state to `preempted` and the share bar visibly drops.
- **Instant revocation mid-dispatch** — `Revoke now` during an active burst.
- **All six tamper-panel buttons**, each expected to be rejected by both
  `verifyManifest()` and a `Governor` constructed from the rejected
  verification (`State.DENIED`).

None of this is automated yet. A headless-browser harness (Playwright driving
Chrome with `--enable-unsafe-webgpu`) is the natural next step and is not
started — flagged here rather than silently left off the coverage map.

## Not tested at all (by design — not yet built)

- **The broker** (`packages/zkpoc-broker/`) — shard queue, redundancy
  consensus, audit sampling, credit ledger. M2 scope; see [roadmap.md](roadmap.md).
- **The useful-PoW challenge protocol**, including the attacker-advantage
  ratio measurement named as the flagship's primary technical risk. M2 scope.
- **The Circom circuit and Solidity verifier.** M3 scope; see
  [ADR-0007](adr/0007-tiered-zk-proving-plan.md).
- **`bench/*.py` scripts have no unit tests**, but they are self-verifying by
  construction: `tdsc_reproduction.py` asserts its own reconstructed values
  against the source paper's stated figures and fails loudly (`assert`) if
  they diverge beyond tolerance. Treat "the script runs to completion without
  an AssertionError" as the test.

## Conventions for adding a test

- One `test()` block per behaviour, named as a sentence describing what must
  be true, not what function is called (`'demo flow: editing the worker on
  disk invalidates the binding'`, not `'test verifyManifest 2'`).
- When testing a rejection, assert *which* check failed, not just that
  something failed.
- Prefer a pure-function extraction over mocking browser globals when the
  logic under test doesn't inherently need `performance.now()`, a real
  `Worker`, or DOM APIs.
- New device-measurement or economic-model code belongs in `bench/`, runs via
  `python bench/<script>.py`, and should assert its own numeric claims
  (`assert`, not just `print`) wherever the source of truth is external
  (a paper, a prior measurement) — see `tdsc_reproduction.py` for the
  pattern.
