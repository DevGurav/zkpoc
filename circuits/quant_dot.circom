pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";

/**
 * ZK-PoC's Track 1 circuit (ADR-0007): a quantized dot product, proving one
 * output element of the GEMM kernel packages/zkpoc-broker already uses
 * (shard.js#referenceElement is exactly sum_k(elemA(i,k) * elemB(k,j))),
 * scoped to N terms so the circuit stays small -- ADR-0007's "bounded
 * circuit size" requirement -- while remaining a faithful instance of the
 * real computation, not an unrelated toy.
 *
 * WHAT THIS PROVES, PRECISELY
 * ----------------------------
 * Given N pairs of quantized values (a[i], b[i]) as a PRIVATE witness, the
 * circuit proves knowledge of values whose dot product equals the PUBLIC
 * output `out`, without revealing a[] or b[] themselves. That's the entire
 * point relative to ADR-0011's row-reveal scheme: the current commit-then-
 * challenge audit path (audit.js#auditFull) proves correctness by disclosing
 * every row in the clear; a real ZK circuit proves the same claim while
 * disclosing nothing. This is the honest replacement for that disclosure,
 * not a faster version of it -- see zk/README.md for where this fits
 * relative to `auditFull()`.
 *
 * This does NOT claim bit-exact equivalence to merkle.js's row-hash
 * quantization (which quantizes the FINAL float sum; this circuit sums
 * already-quantized integer inputs -- the two round differently). What it
 * does claim is a real, correctly-constrained proof of integer dot-product
 * computation using the same value generator (shard.js#elemA/elemB) and the
 * same QUANTIZE_SCALE convention (merkle.js) the rest of the project uses,
 * checked end to end in zk/test/verifier.test.js against a real Shard's
 * actual output.
 *
 * WHY THE RANGE CHECK EXISTS
 * ----------------------------
 * circom signals are elements of a ~254-bit prime field, not bounded
 * integers. Without a range check, a dishonest prover could supply a witness
 * that wraps around the field modulus and still satisfy the dot-product
 * constraint while representing a completely different integer value --
 * the field arithmetic alone does not prevent this. SignedRangeCheck forces
 * each input into a declared bit-width via the standard circom idiom (shift
 * into the non-negative range, then decompose with Num2Bits, which itself
 * constrains every bit to {0,1} and their weighted sum to equal the shifted
 * input) -- see circomlib's bitify.circom.
 */

template SignedRangeCheck(bits) {
    signal input x;
    signal shifted;
    shifted <== x + (1 << (bits - 1));
    component n2b = Num2Bits(bits);
    n2b.in <== shifted;
}

/**
 * @param N     number of (a[i], b[i]) term pairs summed
 * @param BITS  bit-width each input is range-checked against, signed
 *              (representable range: [-2^(BITS-1), 2^(BITS-1)) ). BITS=20
 *              covers merkle.js's QUANTIZE_SCALE=1e4 applied to values in
 *              [-1,1) -- i.e. roughly [-10000,10000] -- with wide margin.
 */
template QuantizedDotProduct(N, BITS) {
    signal input a[N];
    signal input b[N];
    signal output out;

    component rangeA[N];
    component rangeB[N];
    signal partial[N + 1];
    partial[0] <== 0;

    for (var i = 0; i < N; i++) {
        rangeA[i] = SignedRangeCheck(BITS);
        rangeA[i].x <== a[i];
        rangeB[i] = SignedRangeCheck(BITS);
        rangeB[i].x <== b[i];

        partial[i + 1] <== partial[i] + a[i] * b[i];
    }

    out <== partial[N];
}

// N=8 mirrors DEFAULT_CHALLENGE_ROWS in shard.js -- not load-bearing (the
// two numbers serve unrelated purposes), but a deliberate, readable echo
// rather than an arbitrary choice. a[], b[] are private by default (not
// listed in the public[] set below); `out` is public because it is a
// declared output signal.
component main = QuantizedDotProduct(8, 20);
