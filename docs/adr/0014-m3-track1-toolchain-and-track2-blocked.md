# ADR-0014: M3 Track 1 toolchain choices, dependency isolation, and Track 2 blocked

Status: Accepted (2026-08-04)

## Context

[ADR-0007](0007-tiered-zk-proving-plan.md) settled *what* M3 would build —
Circom/Groth16 in-browser (Track 1), a settlement-side zkVM measurement
(Track 2) — before any implementation existed. Implementing it raised three
further decisions ADR-0007 didn't cover: which concrete tools realize
"Circom/Groth16" and "Solidity verifier on Anvil/Hardhat" in an environment
with no native Rust toolchain and no `circom`/`snarkjs`/`anvil` binaries
pre-installed; where that tooling should live relative to a monorepo whose
other packages are deliberately dependency-free (`CONTRIBUTING.md`); and
what to do about Track 2, which turns out to need exactly the Rust toolchain
this environment lacks.

## Decision

**Toolchain: circom2 (WASM) + snarkjs + Hardhat 2, not native circom +
Foundry.** `circom2` is a WASM-compiled port of the circom compiler,
installable via npm with no Rust toolchain required; it was validated
end-to-end (compile → powers-of-tau → Groth16 setup → witness → proof →
on-chain verify, genuine proof true, tampered proof false) before being
adopted for the real circuit. Hardhat was pinned to `^2.22.0` rather than
using the default `npx hardhat` install (Hardhat 3, which requires
interactive `--init` and has an incompatible toolbox ecosystem in this
environment) — Hardhat 2's local EVM (`npx hardhat test`) substitutes for
Anvil, which is not installable here (no Foundry/Rust).

**Isolation: `zk/` is its own package, outside the root npm workspaces.**
`CONTRIBUTING.md` is explicit that this project's packages and scripts
should be auditable without a `node_modules` tree — "a break-even model and
a manifest verifier that need a `node_modules` tree to audit are harder to
trust than ones you can read start to finish." circom2, snarkjs,
`circomlib`, and Hardhat's toolbox are a genuinely heavy dependency tree with
no way to avoid pulling one in for a real Groth16 pipeline. Rather than
accreting that weight into the root `package.json` or a `packages/*`
workspace member, it lives in `zk/package.json`, requiring its own
`npm install`. A fresh clone's root `npm install` stays fast and
dependency-free for anyone not touching the ZK layer.

**Track 2: reported as environment-blocked, not attempted with substitute
numbers.** RISC Zero and SP1 are Rust-toolchain-based zkVMs with no
WASM/npm-installable distribution — confirmed by npm search, which surfaces
nothing beyond an unofficial third-party CLI for an unrelated zkVM (still
Rust-dependent) and RISC Zero's *remote* hosted-proving SDK (needs API
credentials this environment doesn't have). Building a Rust toolchain from
scratch inside this environment was judged out of scope for what M3 needs to
demonstrate. The `c_proof` range in `docs/BUILD.md` §1 (10³–10⁶, from the
ZKML literature survey) stays as a literature-anchored placeholder rather
than being replaced with a fabricated measurement — matching this project's
established pattern of labelling unmeasured values rather than guessing at
them (`docs/BUILD.md`'s "known-unmeasured" table; the M2.5 browser-walkthrough
caveat in `docs/testing-strategy.md`).

## Consequences

- Track 1 is fully real: `circuits/quant_dot.circom` compiles, proves, and
  verifies on-chain against `contracts/ShardRowVerifier.sol`, with a
  tampered public signal and a tampered proof point both rejected —
  `zk/test/verifier.test.js`, run against real `Shard`-derived inputs from
  `packages/zkpoc-broker`, not synthetic numbers.
- Two real tooling bugs surfaced during implementation and are worked around
  (not papered over) in `zk/scripts/build.js`, documented at their fix site
  and in `zk/README.md`: circom2's `-o` output path resolves relative to the
  *input* file's directory rather than cwd when given a `..`-relative input,
  and circom2's CLI process does not reliably terminate after finishing its
  work, which hangs a naive `execSync`-based caller indefinitely even though
  compilation is long done.
- The trusted setup ceremony `zk/scripts/build.js` runs is a single-party toy
  (script-generated entropy), explicitly not production-grade — flagged in
  the script's own docstring and in `zk/README.md`.
- Q2 in `docs/BUILD.md` §5 (what `c_proof` is in practice) stays open rather
  than resolved; §1's `c_proof` row keeps citing the literature range with
  its provenance unchanged.
- `zk/` is the first subtree in this project with a real, heavy dependency
  tree. `CONTRIBUTING.md` is updated to point to this ADR so the exception
  is documented at the point someone would otherwise wonder why one package
  breaks the project's own stated rule.
- Alternative considered and rejected: attempt Track 2 against a
  from-scratch Rust toolchain install inside this environment. Rejected as
  disproportionate — the environment constraint (no Rust, no network access
  to install one reliably validated in this session) is the same class of
  hard capability gap ADR-0007 already named for in-browser zkVMs, just
  discovered at the settlement side instead of the client side.
