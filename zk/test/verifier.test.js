const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const hre = require("hardhat");
const { expect } = require("chai");
const snarkjs = require("snarkjs");

/**
 * M3 Track 1 exit criteria (docs/BUILD.md, ADR-0007): a genuine Groth16
 * proof over circuits/quant_dot.circom verifies on-chain, and a tampered
 * witness is rejected on-chain. This test generates the proof from REAL
 * Shard-derived inputs (packages/zkpoc-broker/src/shard.js), not synthetic
 * numbers, so it also stands as an end-to-end check that the circuit is
 * wired to the same computation the rest of the project performs -- see
 * circuits/quant_dot.circom's docstring for exactly what equivalence is (and
 * isn't) being claimed.
 *
 * Requires `npm run build` to have been run first (produces zk/build/ and
 * contracts/ShardRowVerifier.sol -- both gitignored, regenerated fresh).
 */

const WASM_PATH = path.join(__dirname, "..", "build", "circuit", "quant_dot_js", "quant_dot.wasm");
const ZKEY_PATH = path.join(__dirname, "..", "build", "quant_dot.final.zkey");
const SHARD_MODULE_PATH = path.join(
  __dirname, "..", "..", "packages", "zkpoc-broker", "src", "shard.js"
);
const MERKLE_MODULE_PATH = path.join(
  __dirname, "..", "..", "packages", "zkpoc-broker", "src", "merkle.js"
);

// Matches circuits/quant_dot.circom's component main = QuantizedDotProduct(8, 20):
// N=8 terms, and a shard of matrix dimension n=8 makes referenceElement(i,j)
// exactly an 8-term dot product -- the same shape, not a coincidence.
const N = 8;

async function buildCircuitInputs() {
  const { Shard } = await import(pathToFileURL(SHARD_MODULE_PATH).href);
  const { quantize } = await import(pathToFileURL(MERKLE_MODULE_PATH).href);

  const shard = new Shard({ id: "zk-test-shard", n: N, sessionNonce: "zk-poc-verifier-test-fixed-nonce" });

  // Row i=0, column j=0 of A*B: sum_k elemA(0,k) * elemB(k,0). Quantized per
  // term BEFORE summing, matching the circuit's own arithmetic (see the
  // circuit docstring's "does NOT claim bit-exact equivalence" note --
  // merkle.js quantizes the final float sum, this quantizes each factor).
  const a = [];
  const b = [];
  let expected = 0n;
  for (let k = 0; k < N; k++) {
    const qa = quantize(shard.elemA(0, k));
    const qb = quantize(shard.elemB(k, 0));
    a.push(qa);
    b.push(qb);
    expected += BigInt(qa) * BigInt(qb);
  }
  return { a, b, expected };
}

describe("ShardRowVerifier (M3 Track 1, ADR-0007)", function () {
  this.timeout(120000);

  let verifier;
  let genuineProof;
  let genuinePublicSignals;
  let expectedOut;

  before(async function () {
    if (!fs.existsSync(WASM_PATH) || !fs.existsSync(ZKEY_PATH)) {
      throw new Error(
        `missing build artifacts (${WASM_PATH} / ${ZKEY_PATH}) -- run "npm run build" in zk/ first`
      );
    }

    const { a, b, expected } = await buildCircuitInputs();
    expectedOut = expected;

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      { a, b }, WASM_PATH, ZKEY_PATH
    );
    genuineProof = proof;
    genuinePublicSignals = publicSignals;

    const Verifier = await hre.ethers.getContractFactory("ShardRowVerifier");
    verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
  });

  it("proves the real Shard-derived dot product, not an arbitrary witness", function () {
    expect(BigInt(genuinePublicSignals[0])).to.equal(expectedOut);
  });

  it("verifies a genuine proof on-chain", async function () {
    const ok = await verifier.verifyProof(
      ...groth16CallData(genuineProof, genuinePublicSignals)
    );
    expect(ok).to.equal(true);
  });

  it("rejects a tampered public signal on-chain", async function () {
    const tamperedSignals = [(BigInt(genuinePublicSignals[0]) + 1n).toString()];
    const [a, b, c] = groth16CallData(genuineProof, genuinePublicSignals);
    const ok = await verifier.verifyProof(a, b, c, tamperedSignals);
    expect(ok).to.equal(false);
  });

  it("rejects a proof with a tampered proof point on-chain", async function () {
    const tamperedProof = {
      ...genuineProof,
      pi_a: [
        (BigInt(genuineProof.pi_a[0]) + 1n).toString(),
        genuineProof.pi_a[1],
        genuineProof.pi_a[2],
      ],
    };
    const ok = await verifier.verifyProof(
      ...groth16CallData(tamperedProof, genuinePublicSignals)
    );
    expect(ok).to.equal(false);
  });
});

// snarkjs's proof.pi_b coordinates are stored with each pair reversed
// relative to what the exported Solidity verifier expects -- this is a
// documented snarkjs/circom convention (G2 point coordinate ordering), not a
// bug; confirmed working end-to-end against a real deployed verifier in this
// project's scratch validation before this test was written.
function groth16CallData(proof, publicSignals) {
  const a = [proof.pi_a[0], proof.pi_a[1]];
  const b = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const c = [proof.pi_c[0], proof.pi_c[1]];
  return [a, b, c, publicSignals];
}
