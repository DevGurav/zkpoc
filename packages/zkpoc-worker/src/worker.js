/**
 * Shard execution worker.
 *
 * Runs in a dedicated Worker, which is not decoration: a Worker has no DOM,
 * no `document`, no `window`, and no synchronous access to the page. Several
 * of the manifest's `data_access` claims are therefore enforced by the
 * execution context itself rather than by promise -- `dom: "none"` is a
 * structural fact here, not an assertion the user has to take on trust.
 *
 * The worker never decides how much of the device to use. It executes bursts
 * of a size the governor dictates and reports exactly how long it was busy.
 * Keeping the policy out of the worker is what makes the share enforceable:
 * a compromised kernel can produce wrong answers, but it cannot award itself
 * more CPU, because it never controls the schedule.
 */

import {
  MATMUL_WGSL, shardMatrix, cpuMatmul, flopsPerShard, referenceC00,
} from './kernels.js';

let cfg = { n: 256, path: 'cpu' };
let gpu = null;      // {device, pipeline, bind, ...}
let cpu = null;      // {A, B, C}
let shards = 0;

// -- setup ------------------------------------------------------------------

async function initGpu(n) {
  if (!globalThis.navigator?.gpu) throw new Error('WebGPU unavailable in worker');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const bytes = n * n * 4;
  const U = GPUBufferUsage;

  const bufA = device.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_DST });
  const bufB = device.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_DST });
  const bufC = device.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_SRC });
  const readback = device.createBuffer({ size: 4, usage: U.COPY_DST | U.MAP_READ });
  const dims = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });

  device.queue.writeBuffer(bufA, 0, shardMatrix(n, 0));
  device.queue.writeBuffer(bufB, 0, shardMatrix(n, 0));
  device.queue.writeBuffer(dims, 0, new Uint32Array([n, 0, 0, 0]));

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: MATMUL_WGSL }),
      entryPoint: 'main',
    },
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufA } },
      { binding: 1, resource: { buffer: bufB } },
      { binding: 2, resource: { buffer: bufC } },
      { binding: 3, resource: { buffer: dims } },
    ],
  });
  return { device, pipeline, bind, bufC, readback, n };
}

function initCpu(n) {
  return { A: shardMatrix(n, 0), B: shardMatrix(n, 0), C: new Float32Array(n * n) };
}

// -- one shard --------------------------------------------------------------

async function runShardGpu() {
  const { device, pipeline, bind, n } = gpu;
  const groups = Math.ceil(n / 16);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(groups, groups);
  pass.end();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
}

function runShardCpu() {
  cpuMatmul(cfg.n, cpu.A, cpu.B, cpu.C);
}

/** Read C[0][0] back so a result can be spot-checked, not merely timed. */
async function sampleResult() {
  if (cfg.path === 'cpu') return cpu.C[0];
  const { device, bufC, readback } = gpu;
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(bufC, 0, readback, 0, 4);
  device.queue.submit([enc.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const v = new Float32Array(readback.getMappedRange().slice(0))[0];
  readback.unmap();
  return v;
}

// -- burst ------------------------------------------------------------------

/**
 * Execute shards until the governor's time budget is spent.
 *
 * Reports `busyMs` as measured, never as requested. The governor computes the
 * achieved share from this, so overshooting the budget shows up in the share
 * accounting instead of being silently absorbed -- the difference between a
 * limit that is enforced and one that is merely declared.
 */
async function burst(budgetMs) {
  const t0 = performance.now();
  let done = 0;
  do {
    if (cfg.path === 'gpu') await runShardGpu();
    else runShardCpu();
    done++;
  } while (performance.now() - t0 < budgetMs && done < 64);

  const busyMs = performance.now() - t0;
  shards += done;
  return { busyMs, shardsDone: done, flops: done * flopsPerShard(cfg.n) };
}

// -- message loop -----------------------------------------------------------

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data ?? {};
  const reply = (ok, data) => self.postMessage({ id, ok, ...data });

  try {
    switch (type) {
      case 'init': {
        cfg = { n: payload.n ?? 256, path: payload.path ?? 'cpu' };
        shards = 0;
        if (cfg.path === 'gpu') {
          try {
            gpu = await initGpu(cfg.n);
          } catch (err) {
            // Fall back rather than fail: reporting which path actually ran is
            // more useful than refusing to run, and the governor surfaces it.
            cfg.path = 'cpu';
            cpu = initCpu(cfg.n);
            return reply(true, { path: 'cpu', fellBack: true, reason: String(err) });
          }
        } else {
          cpu = initCpu(cfg.n);
        }
        return reply(true, { path: cfg.path, fellBack: false });
      }

      case 'burst':
        return reply(true, await burst(payload.budgetMs));

      case 'sample': {
        const value = await sampleResult();
        return reply(true, {
          value,
          expected: referenceC00(cfg.n),
          shards,
        });
      }

      case 'stop':
        gpu?.device?.destroy?.();
        gpu = null; cpu = null;
        return reply(true, { stopped: true, shards });

      default:
        return reply(false, { error: `unknown message type ${type}` });
    }
  } catch (err) {
    reply(false, { error: String(err) });
  }
};
