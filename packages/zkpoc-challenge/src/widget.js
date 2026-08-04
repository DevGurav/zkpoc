/**
 * The drop-in flow: fetch a challenge, solve it, submit the response, get
 * back an admit/deny decision. Browser-only (uses `fetch`) -- kept separate
 * from `solveChallenge` so the actually-tested compute path never depends
 * on network availability, mirroring `@zkpoc/sdk`'s
 * `issueSession`/`loadCodeFromUrls` split for the same reason.
 *
 * The wire protocol is deliberately unopinionated about transport framing
 * (no assumed auth, headers, or endpoint shape beyond the two URLs) --
 * a real deployment's issue/verify endpoints are
 * `packages/zkpoc-broker/src/challenge.js#issueChallenge`/`#resolveChallenge`
 * called from whatever server framework the site already uses.
 */

import { solveChallenge } from './solve.js';

/**
 * @param {object} o
 * @param {string} o.issueUrl   GET -> `{ shard: object, sizing: object }`
 *                               (a serialised `issueChallenge()` result)
 * @param {string} o.verifyUrl  POST `{ shardId, workerId, root, rows, elapsedMs }`
 *                               -> `{ outcome, timingRatio }`
 *                               (whatever the server derives from
 *                               `resolveChallenge()`)
 * @param {string} [o.workerId]
 * @param {boolean} [o.memoryHard]  forwarded to `solveChallenge` -- must
 *                                  match the deployment's issuer-side
 *                                  setting (Q7/ADR-0013)
 * @returns {Promise<{outcome:string, timingRatio:number|null}>}
 */
export async function runChallenge(o) {
  const workerId = o.workerId ?? `visitor-${Math.random().toString(36).slice(2)}`;

  const issued = await (await fetch(o.issueUrl)).json();
  const startedAt = performance.now();
  const result = await solveChallenge(issued.shard, workerId, { memoryHard: o.memoryHard });
  const elapsedMs = performance.now() - startedAt;

  const resp = await fetch(o.verifyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...result, elapsedMs }),
  });
  return resp.json();
}
