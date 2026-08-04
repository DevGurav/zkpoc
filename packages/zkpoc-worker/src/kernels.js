/**
 * Workload kernels.
 *
 * Kernel source is exported as a string rather than fetched, because the
 * Compute Consent Manifest binds a hash of exactly these bytes. Anything that
 * could rewrite the source between hashing and execution -- a bundler
 * transform, a CDN, a service worker -- breaks the binding, which is the point.
 *
 * The workload is a tiled fp32 GEMM, standing in for a quantized ONNX
 * inference shard. GEMM is the right stand-in: it is what inference actually
 * spends its time on, and it has an exactly checkable result, so a returned
 * value can be verified rather than merely timed.
 *
 * NOTE ON THE CPU PATH. This is a JS typed-array kernel, not the Rust -> WASM
 * SIMD kernel the design calls for; building that needs a Rust toolchain.
 * It is a lower bound, and the break-even model already shows the CPU path is
 * economically dead at any share, so the WebGPU path is the one that matters.
 * The seam is `cpuMatmul` -- swap it for the WASM export and nothing else in
 * the governor changes.
 */

export const MATMUL_WGSL = `
struct Dims { n: u32 };
@group(0) @binding(0) var<storage, read>       A : array<f32>;
@group(0) @binding(1) var<storage, read>       B : array<f32>;
@group(0) @binding(2) var<storage, read_write> C : array<f32>;
@group(0) @binding(3) var<uniform>             d : Dims;

const TS : u32 = 16u;
var<workgroup> tileA : array<f32, 256>;
var<workgroup> tileB : array<f32, 256>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(local_invocation_id)  lid : vec3<u32>) {
  let n = d.n;
  let row = gid.y;
  let col = gid.x;
  var acc : f32 = 0.0;
  let tiles = (n + TS - 1u) / TS;
  for (var t : u32 = 0u; t < tiles; t = t + 1u) {
    let aCol = t * TS + lid.x;
    let bRow = t * TS + lid.y;
    tileA[lid.y * TS + lid.x] = select(0.0, A[row * n + aCol], row < n && aCol < n);
    tileB[lid.y * TS + lid.x] = select(0.0, B[bRow * n + col], col < n && bRow < n);
    workgroupBarrier();
    for (var k : u32 = 0u; k < TS; k = k + 1u) {
      acc = acc + tileA[lid.y * TS + k] * tileB[k * TS + lid.x];
    }
    workgroupBarrier();
  }
  if (row < n && col < n) { C[row * n + col] = acc; }
}`;

/** Deterministic shard input, so any party can recompute and check a result. */
export function shardMatrix(n, seed = 0) {
  const a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = ((i + seed) % 17) * 0.0625 - 0.5;
  return a;
}

/** Blocked fp32 GEMM. 2*n^3 FLOPs. See the note above: JS, not WASM SIMD. */
export function cpuMatmul(n, A, B, C) {
  const BS = 64;
  C.fill(0);
  for (let ii = 0; ii < n; ii += BS) {
    const iMax = Math.min(ii + BS, n);
    for (let kk = 0; kk < n; kk += BS) {
      const kMax = Math.min(kk + BS, n);
      for (let jj = 0; jj < n; jj += BS) {
        const jMax = Math.min(jj + BS, n);
        for (let i = ii; i < iMax; i++) {
          const iN = i * n;
          for (let k = kk; k < kMax; k++) {
            const a = A[iN + k];
            if (a === 0) continue;
            const kN = k * n;
            for (let j = jj; j < jMax; j++) C[iN + j] += a * B[kN + j];
          }
        }
      }
    }
  }
}

export const flopsPerShard = (n) => 2 * n ** 3;

/** Reference value of C[0][0], for cheap correctness spot-checks. */
export function referenceC00(n, seedA = 0, seedB = 0) {
  let acc = 0;
  for (let k = 0; k < n; k++) {
    acc += (((k + seedA) % 17) * 0.0625 - 0.5)
         * ((((k * n) + seedB) % 17) * 0.0625 - 0.5);
  }
  return acc;
}
