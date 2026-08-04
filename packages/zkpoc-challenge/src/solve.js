/**
 * Client-side half of the useful-PoW challenge protocol
 * (`packages/zkpoc-broker/src/challenge.js` is the server half -- issue a
 * shard, resolve a response). Nothing here talks to the network; see
 * `runChallenge` in `widget.js` for the fetch-based drop-in flow.
 *
 * WHY THIS IS THE REFERENCE (JS/CPU) SOLVE PATH, NOT THE FAST ONE
 * -------------------------------------------------------------------
 * `buildHonestSubmission` computes every row via `shard.js#referenceElement`
 * -- correct on every device, no WebGPU required, and exactly what
 * `packages/zkpoc-broker/test/challenge.test.js` already validates
 * end-to-end. It is also the slow path: `bench/attacker_advantage.py`
 * measured a 181.7x throughput gap between this and a GPU-accelerated
 * solve, which is why `chooseShardSize` sizes challenges against a
 * *reference device tier's* wall-clock, not against this implementation's
 * own speed. A production widget wanting the fastest HONEST solve time on
 * capable devices would substitute `@zkpoc/worker`'s WGSL kernel for the
 * inner loop and keep this path as the CPU fallback -- that substitution
 * is future work, tracked in the package README, not done here.
 */

import { Shard, buildHonestSubmission } from '../../zkpoc-broker/index.js';

/**
 * Compute an honest response to an issued challenge shard.
 *
 * @param {object} shardDescriptor  `Shard#toJSON()` output from the issuer
 *                                  (`packages/zkpoc-broker/src/challenge.js#issueChallenge`)
 * @param {string} workerId         identifies this response, not this device
 *                                  or this visitor -- a fresh id per attempt
 *                                  is fine and expected
 * @param {object} [o]
 * @param {boolean} [o.memoryHard]  must match the issuer's own setting for
 *                                  this deployment -- see Q7/ADR-0013's
 *                                  memory-hard commitment mitigation
 *                                  (`merkle.js#hashRow`'s `memoryHard`
 *                                  option). Not carried in the shard
 *                                  descriptor itself, the same way `k` isn't
 *                                  -- both sides configure it, matching the
 *                                  existing protocol convention.
 * @returns {Promise<{shardId:string, workerId:string, root:string, rows:object[]}>}
 *          a plain-object `ShardResult`, ready to serialise and send back
 */
export async function solveChallenge(shardDescriptor, workerId, o = {}) {
  const shard = new Shard(shardDescriptor);
  const result = await buildHonestSubmission(shard, workerId, o);
  return {
    shardId: result.shardId,
    workerId: result.workerId,
    root: result.root,
    rows: result.rows,
  };
}
