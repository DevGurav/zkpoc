# @zkpoc/sdk

Publisher integration for consented browser compute: issue a signed
[Compute Consent Manifest](../zkpoc-ccm/SPEC.md), verify it, run the governed
worker session. This is what [`demo/index.html`](../../demo/index.html) does
by hand across ~40 lines, wrapped into five:

```js
import { runSession } from '@zkpoc/sdk';
import { MATMUL_WGSL } from '@zkpoc/worker/kernels';

await runSession({
  origin: 'https://publisher.example',
  workerUrl: new URL('./worker.js', import.meta.url),
  code: { worker: await (await fetch('./worker.js')).text(), kernels: [{ type: 'wgsl', source: MATMUL_WGSL }] },
  limits: { cpu_share_max: 0.05, gpu_share_max: 0.05, duration_max_s: 360,
            network: { egress_bytes_max: 1048576, allowed_origins: [] } },
}, { onTick: (t) => meter.update(t) });
```

That issues a manifest, verifies it, starts the resource governor, and calls
`onTick` on every telemetry update. If verification fails — a bad key, an
expired session, a policy the caller supplied that the limits don't
satisfy — `onDenied` fires instead and no `Worker` is ever constructed.

## The headless/browser split

`runSession()` needs a browser (`Governor.start()` constructs a real
`Worker`, which Node doesn't have). The two functions it's built from don't:

- **`issueSession(o)`** — builds, signs, and verifies the manifest. Pure
  enough to unit-test with real code source strings and no browser; see
  `test/session.test.js`.
- **`attachGovernor(session, o)`** — constructs a `Governor` from an issued
  session. Also safe in Node; it just doesn't `.start()`.

Use these two directly if you need to inspect what a manifest will say
before running it (a build step, a server-rendered preview), or if you're
composing your own event wiring instead of `runSession`'s handler object.

## Why relative imports internally, not `@zkpoc/ccm`/`@zkpoc/worker`

This package is the first one in the monorepo to depend on another package.
Bare specifiers would only resolve after `npm install` created workspace
symlinks — but the rest of this project runs with **no install step**
(`CONTRIBUTING.md`), and `demo/index.html` already established the pattern
of plain relative ES module imports for cross-package use. `src/session.js`
follows it, so `node --test` here works with nothing installed, same as
every other package in this repo.

## API

| Export | What it does | Needs a browser? |
| --- | --- | --- |
| `issueSession(o)` | Build + sign + verify a manifest | No |
| `attachGovernor(session, o)` | Construct a `Governor`, unstarted | No |
| `runSession(o, handlers)` | Both of the above, wired, started | Yes (`.start()`) |
| `loadCodeFromUrls(o)` | Fetch + hash worker/kernel source from URLs | Yes (`fetch`) |

See the JSDoc in [`src/session.js`](src/session.js) for exact parameter
shapes.
