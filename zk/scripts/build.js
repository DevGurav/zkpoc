#!/usr/bin/env node
/**
 * Builds circuits/quant_dot.circom into a deployable Groth16 verifier.
 *
 * Pipeline: circom compile -> powers-of-tau (toy ceremony) -> phase-2 setup
 * -> zkey contribution -> export verification key + Solidity verifier.
 *
 * CIRCOM2's OUTPUT-PATH QUIRK, WORKED AROUND DELIBERATELY
 * -----------------------------------------------------------
 * circom2 (the WASM port of the circom compiler this toolchain uses instead
 * of the native Rust binary -- there is no Rust toolchain in this project's
 * build environment, and no way to install one; circom2 is what makes
 * Track 1 possible at all here) resolves its `-o` output path relative to
 * the INPUT file's directory, not the process's cwd, whenever the input is
 * given as a relative path containing `..`. Compiling `../circuits/x.circom`
 * with `-o build/` silently writes output files back into `circuits/`
 * instead of `build/`. Confirmed by direct experiment, not documentation --
 * circom2's own CLI wrapper does not surface this as an error in every case,
 * it just writes to the wrong place.
 *
 * The fix: copy the circuit source into the build directory first, so
 * compilation is always invoked with a bare filename and cwd IS both the
 * input and output directory -- no `..` anywhere in the invocation. This is
 * a workaround for a real tooling quirk, not an arbitrary preference; do not
 * "simplify" this back to compiling circuits/ in place without re-verifying
 * the quirk is gone.
 *
 * CIRCOM2's CHILD PROCESS DOES NOT RELIABLY EXIT
 * -----------------------------------------------
 * Separately: circom2's CLI prints its own "Everything went okay" success
 * banner and has fully flushed all output files by that point, but the
 * underlying WASM/WASI process then does not reliably terminate on its own
 * -- confirmed by direct experiment (a run left the child alive for 40+
 * minutes at ~0% CPU after that banner printed, i.e. genuinely wedged, not
 * slow). `execSync`, which blocks until the child *exits*, hangs forever in
 * that case even though the compile itself is long since done. This is the
 * same underlying flakiness as the "Device or resource busy" errors seen
 * when deleting a build directory right after a circom2 invocation -- a
 * lingering handle/process the WASI shim doesn't clean up. The fix is
 * `runCircom2()` below: spawn instead of execSync, resolve as soon as the
 * success banner is seen (or the process exits on its own, if it ever
 * does), and explicitly `child.kill()` rather than waiting for a natural
 * exit. Do not replace this with execSync again without re-verifying the
 * hang is gone.
 *
 * TOY CEREMONY, STATED PLAINLY
 * -------------------------------
 * The powers-of-tau contribution below uses a single, script-generated
 * entropy string. This is fine for a proof-of-concept whose point is
 * proving the pipeline and the verification property, not for anything
 * meant to secure real value: a production deployment needs a proper
 * multi-party ceremony (e.g. reusing an existing public ptau file from the
 * Hermez/Polygon ceremony) so that no single party ever knew the toxic
 * waste. See zk/README.md.
 */

const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");

const ROOT = path.resolve(__dirname, "..");
const CIRCUIT_NAME = "quant_dot";
const CIRCUIT_SRC = path.join(ROOT, "..", "circuits", `${CIRCUIT_NAME}.circom`);
const BUILD_DIR = path.join(ROOT, "build");
const CIRCUIT_DIR = path.join(BUILD_DIR, "circuit");
const CONTRACTS_DIR = path.join(ROOT, "..", "contracts");

// Sized from the circuit's real constraint count (360: 328 non-linear + 32
// linear, printed by the compile step below) -- 2^POWER must exceed that.
// POWER=12 (4096) leaves generous headroom for the circuit to grow somewhat
// without needing a new ceremony, at negligible extra cost: this whole
// ceremony completes in well under a second at this size.
const PTAU_POWER = 12;

function log(msg) {
  console.log(`[build] ${msg}`);
}

// See module docstring ("CIRCOM2's CHILD PROCESS DOES NOT RELIABLY EXIT")
// for why this is spawn-and-watch-stdout rather than execSync.
function runCircom2(args, cwd, timeoutMs = 60000) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve();
    };

    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      if (d.toString().includes("Everything went okay")) finish(null);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (!settled) finish(code === 0 ? null : new Error(`circom2 exited with code ${code}: ${stderr}`));
    });

    const timer = setTimeout(() => {
      finish(new Error(`circom2 did not report completion within ${timeoutMs}ms (stderr so far: ${stderr})`));
    }, timeoutMs);
  });
}

async function compileCircuit() {
  log(`compiling ${CIRCUIT_NAME}.circom (circom2, WASM -- see module docstring)`);
  fs.mkdirSync(CIRCUIT_DIR, { recursive: true });
  const localSrc = path.join(CIRCUIT_DIR, `${CIRCUIT_NAME}.circom`);
  fs.copyFileSync(CIRCUIT_SRC, localSrc);   // the flatten workaround

  const circom2Cli = path.join(ROOT, "node_modules", "circom2", "cli.js");
  const libPath = path.join(ROOT, "node_modules");
  await runCircom2(
    [circom2Cli, `${CIRCUIT_NAME}.circom`, "--r1cs", "--wasm", "--sym", "-o", ".", "-l", libPath],
    CIRCUIT_DIR
  );

  const r1cs = path.join(CIRCUIT_DIR, `${CIRCUIT_NAME}.r1cs`);
  const wasm = path.join(CIRCUIT_DIR, `${CIRCUIT_NAME}_js`, `${CIRCUIT_NAME}.wasm`);
  if (!fs.existsSync(r1cs) || !fs.existsSync(wasm)) {
    throw new Error(
      `compile did not produce expected artifacts at ${r1cs} / ${wasm} -- ` +
      `if circom2's output-path behaviour changed, see this file's module docstring`
    );
  }
  return { r1cs, wasm };
}

async function toyCeremony(r1csPath) {
  const ptau0 = path.join(BUILD_DIR, "pot.0.ptau");
  const ptau1 = path.join(BUILD_DIR, "pot.1.ptau");
  const ptauFinal = path.join(BUILD_DIR, "pot.final.ptau");
  const zkey0 = path.join(BUILD_DIR, `${CIRCUIT_NAME}.0.zkey`);
  const zkeyFinal = path.join(BUILD_DIR, `${CIRCUIT_NAME}.final.zkey`);

  log(`powers-of-tau: new accumulator (bn128, 2^${PTAU_POWER}) -- TOY CEREMONY, see docstring`);
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  await snarkjs.powersOfTau.newAccumulator(curve, PTAU_POWER, ptau0);

  log("powers-of-tau: one contribution");
  await snarkjs.powersOfTau.contribute(
    ptau0, ptau1, "zk-poc build script",
    `zk-poc toy entropy ${Date.now()} ${Math.random()}`
  );

  log("powers-of-tau: prepare phase 2");
  await snarkjs.powersOfTau.preparePhase2(ptau1, ptauFinal);

  log("groth16: circuit-specific setup");
  await snarkjs.zKey.newZKey(r1csPath, ptauFinal, zkey0);

  log("groth16: one zkey contribution");
  await snarkjs.zKey.contribute(
    zkey0, zkeyFinal, "zk-poc build script",
    `zk-poc toy zkey entropy ${Date.now()} ${Math.random()}`
  );

  return zkeyFinal;
}

async function exportArtifacts(zkeyFinal) {
  log("exporting verification key");
  const vkey = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
  fs.writeFileSync(
    path.join(BUILD_DIR, "verification_key.json"),
    JSON.stringify(vkey, null, 2)
  );

  log("exporting Solidity verifier -> contracts/ShardRowVerifier.sol");
  const templatesDir = path.join(ROOT, "node_modules", "snarkjs", "templates");
  const templates = {
    groth16: fs.readFileSync(path.join(templatesDir, "verifier_groth16.sol.ejs"), "utf8"),
  };
  let verifierCode = await snarkjs.zKey.exportSolidityVerifier(zkeyFinal, templates);
  // snarkjs names the contract "Groth16Verifier" by default; rename to
  // something that says what it verifies, since a real deployment may sit
  // alongside other verifiers later (M3's Track 2 or future circuits).
  verifierCode = verifierCode.replace(/contract Groth16Verifier/g, "contract ShardRowVerifier");

  fs.mkdirSync(CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTRACTS_DIR, "ShardRowVerifier.sol"), verifierCode);
}

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const { r1cs } = await compileCircuit();
  const zkeyFinal = await toyCeremony(r1cs);
  await exportArtifacts(zkeyFinal);
  log("done -- contracts/ShardRowVerifier.sol and zk/build/verification_key.json are ready");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
// Explicit process.exit(), not just letting main() return: snarkjs's WASM
// curve implementation (ffjavascript) keeps worker threads alive after the
// last await resolves, so the process would otherwise hang open at 0% CPU
// even though all output is already written -- the same family of "doesn't
// clean up after itself" issue as circom2's child process above, just on
// the parent this time. All artifacts are flushed to disk before this
// point, so exiting here is safe.
