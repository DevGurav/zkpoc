# @zkpoc/challenge

Client-side solver for the useful-PoW anti-bot challenge protocol — the
useful-work drop-in for hashcash-style widgets (Cloudflare Turnstile,
Friendly Captcha, ALTCHA, mCaptcha, Anubis). The server half —
issue a shard, verify a response — is
[`packages/zkpoc-broker/src/challenge.js`](../zkpoc-broker/src/challenge.js);
this package is what runs in the visitor's browser.

```js
import { runChallenge } from '@zkpoc/challenge';

const { outcome } = await runChallenge({
  issueUrl: '/api/challenge',   // your backend, wrapping issueChallenge()
  verifyUrl: '/api/verify',     // your backend, wrapping resolveChallenge()
});

if (outcome === 'admit') proceedPastTheGate();
```

Three lines once your backend has the two endpoints. See
[`docs/adr/0012-challenge-mode-single-submission-gate.md`](../../docs/adr/0012-challenge-mode-single-submission-gate.md)
for why challenge mode is a single-submission gate rather than the barter
pipeline (no redundancy, no stake, no reward — an anonymous visitor gets one
shot and nothing to lose by trying).

## Why this is the reference solve path, not the fast one

`solveChallenge()` computes every row via `shard.js#referenceElement` — the
same O(n) reference computation `packages/zkpoc-broker/test/challenge.test.js`
already validates, correct on every device, no WebGPU required. It is also
the *slow* path: `bench/attacker_advantage.py` measured a **181.7×**
throughput gap between this and a GPU-accelerated solve, which is exactly
why `chooseShardSize` sizes challenges against a *reference device tier's*
wall-clock rather than against this implementation's own speed — see
[ADR-0013](../../docs/adr/0013-measured-attacker-advantage-exceeds-memory-hard-control.md).

A production widget wanting the fastest *honest* solve time on capable
devices would substitute `@zkpoc/worker`'s WGSL kernel for the inner loop
here and keep this path as the CPU fallback. That substitution is real,
useful future work, not done in this package yet — tracked in
[docs/roadmap.md](../../docs/roadmap.md).

## The headless/browser split

`solveChallenge(shardDescriptor, workerId)` has no network dependency —
it's pure computation, tested directly in `test/solve.test.js` against a
real `resolveChallenge()` call from `@zkpoc/broker`. `runChallenge(o)` adds
`fetch` on top for the actual issue/solve/submit round trip and is the
browser-only convenience; use `solveChallenge` directly if your own
transport doesn't look like two URLs.

## API

| Export | What it does | Needs a browser? |
| --- | --- | --- |
| `solveChallenge(shardDescriptor, workerId)` | Compute an honest response to an issued shard | No |
| `runChallenge(o)` | Fetch a challenge, solve it, submit it, return the outcome | Yes (`fetch`) |
