# zk/ — M3 Track 1 toolchain

Circom + snarkjs + Hardhat, isolated in its own `package.json` and **not**
part of the root npm workspaces. Everything else in this monorepo is
deliberately zero-runtime-dependency (see `CONTRIBUTING.md`); this toolchain
is the one place that isn't, so it lives behind its own `npm install` rather
than adding weight to everyone else's. See [ADR-0014](../docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md)
for the full reasoning, including why circom2 (a WASM port) stands in for the
native Rust circom compiler, and why Hardhat 2 rather than Foundry/Anvil.

The circuit source (`circuits/quant_dot.circom`) and the committed Solidity
verifier (`contracts/ShardRowVerifier.sol`) live at the top level, alongside
the rest of the project's documented layout — only the heavy build tooling
lives here.

## What this proves

`circuits/quant_dot.circom` proves knowledge of a private witness — 8 pairs
of quantized integers — whose dot product equals a public output, without
revealing the witness. It's scoped to the same computation
`packages/zkpoc-broker/src/shard.js#referenceElement` performs (one output
element of the project's GEMM kernel), using the same value generator and
the same `QUANTIZE_SCALE` convention as `merkle.js`. See the circuit's own
docstring for exactly what equivalence is, and isn't, being claimed — in
particular, this is not a claim of bit-exact agreement with the row-hash
Merkle commitment `ADR-0011`'s audit path uses; it's a real, independently
verified proof of the same class of computation.

This is what a full replacement for `ADR-0011`'s row-reveal audit would look
like: `auditFull()` proves correctness today by disclosing every challenged
row in the clear. A ZK circuit like this one proves the same claim while
disclosing nothing. Wiring this circuit into the actual broker/audit flow
(replacing `auditFull()`'s disclosure with a proof) is future work, tracked
as Q4 in `docs/BUILD.md`'s open questions — this milestone establishes that
the mechanism works end-to-end, not that it's integrated yet.

## Build and test

```
cd zk
npm install
npm run build   # circom2 compile -> toy powers-of-tau -> groth16 setup ->
                 # verification_key.json + contracts/ShardRowVerifier.sol
npm test         # hardhat test: deploys the verifier, proves a real
                 # Shard-derived witness, verifies genuine + rejects tampered
```

`npm run build` must run before `npm test` — the test loads the wasm witness
generator and proving key `build` produces. Both `npm run build`'s output
(`zk/build/`) and the generated `contracts/ShardRowVerifier.sol` are
gitignored and fully reproducible from `circuits/quant_dot.circom`; nothing
in this pipeline's output is meant to be hand-edited.

## The trusted setup is a toy, on purpose

`zk/scripts/build.js` runs a single-party powers-of-tau ceremony with
script-generated entropy. That is fine for a proof-of-concept whose point is
demonstrating the pipeline and the verification property — it is **not**
production-grade. A real deployment needs either a genuine multi-party
ceremony (so no single party ever held the toxic waste) or reuse of an
existing public ceremony transcript (e.g. the Hermez/Polygon one). This is
called out here, in the build script's own docstring, and in
[ADR-0014](../docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md) —
three places, deliberately, matching this project's practice of flagging
non-production shortcuts everywhere they're visible rather than once.

## Two tooling bugs worked around here, worth knowing before touching this code

Both are documented in detail as comments at their fix site
(`zk/scripts/build.js`), summarized here:

1. **circom2's `-o` output path resolves relative to the *input file's*
   directory**, not cwd, whenever the input path contains `..`. Worked
   around by copying the circuit source into the build directory first and
   compiling with a bare filename, so cwd is unambiguously both directories.
2. **circom2's CLI process does not reliably exit** after printing its own
   "Everything went okay" success banner — `execSync` (which waits for the
   child to *exit*, not just finish its work) can hang indefinitely even
   though compilation is long done. Worked around with `spawn` + resolving
   on the success banner + an explicit `child.kill()`, instead of waiting
   for a natural exit. The parent process has the same issue for an
   unrelated reason (snarkjs's WASM curve implementation keeps worker
   threads alive) — `zk/scripts/build.js` calls `process.exit(0)` explicitly
   at the end for the same reason.

Neither is a correctness bug in the proof pipeline itself — both are about a
child or parent process refusing to terminate after its actual work is
done. If either "gets fixed" upstream someday, the workarounds are harmless
to keep, so they weren't made conditional on detecting the bug's presence.

## Track 2 (settlement-side zkVM measurement)

Not implemented in this environment. See
[ADR-0014](../docs/adr/0014-m3-track1-toolchain-and-track2-blocked.md) and
`docs/BUILD.md`'s M3 section for what would be needed (a Rust toolchain plus
the RISC Zero or SP1 CLI, neither of which has a WASM/npm-installable
distribution) and why the honest thing to do here was report the blocker
rather than fabricate proving-time numbers.
