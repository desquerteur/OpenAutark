// B-058 G13: one job on fal.ai's queue API (fal.ai/docs/api-reference/inference-api, read 29.10.2026):
// POST https://queue.fal.run/{model id} with `Authorization: Key …` → { request_id, status_url, response_url,
// cancel_url }; GET status_url until `status` is COMPLETED (202 IN_QUEUE / IN_PROGRESS, 200 COMPLETED – a
// failed job is COMPLETED too); GET response_url → the model's output JSON (or the model's error). The wait is
// the bounded poll of this one job (job.ts waitForJob: a passing status failure is ridden out, a made result is
// asked once more); a job the call gives up on is cancelled (PUT
// cancel_url, best effort) so it is not made and charged after nobody waits for it. The job's start is
// limited to the call's time (X-Fal-Request-Start-Timeout) and its files expire after an hour.
// Owns: this exchange. Never: sends the key to a URL outside the queue's origin, logs or returns the key or a
// raw provider body, or downloads result files (fal.ts does, without the key).

import { WorkforceError } from '../../../shared/errors.ts';
import { endpointFor } from '../../engines/http/common.ts';
import { atPhase, mediaExchange, reached, unusable } from '../generate-http.ts';
import { answerJson, keyHeader, retryOnce, sameOrigin, waitForJob } from './job.ts';
import type { GenerationContext, GenerationTarget } from './types.ts';

const JSON_MAX = 1024 * 1024;
const CANCEL_MS = 3_000;
const SAFE_TYPE = /^[a-z][a-z_]{0,40}$/;

export interface FalResult { output: Record<string, unknown>; requestId: string }

function queueRoot(target: GenerationTarget, what: string): string {
  try { return endpointFor(target.account); } catch (error) {
    throw unusable(`${error instanceof Error ? error.message : 'The account has no valid server URL.'} (${what})`);
  }
}

/** The submit answer's URLs, only when they stay on the queue's origin (they carry the key). */
function jobOf(answer: Record<string, unknown>, root: string, what: string) {
  const url = (value: unknown) => (typeof value === 'string' && sameOrigin(value, root) ? value : undefined);
  const requestId = typeof answer.request_id === 'string' ? answer.request_id.slice(0, 100) : '';
  const statusUrl = url(answer.status_url);
  const responseUrl = url(answer.response_url);
  if (!requestId || !statusUrl || !responseUrl) throw new WorkforceError('unavailable', `${what} on fal.ai returned an unusable job.`, reached('sent'));
  return { requestId, statusUrl, responseUrl, cancelUrl: url(answer.cancel_url) };
}

/** Runs `model` with `input` and returns its output JSON (see the header). */
export async function runFalJob(ctx: GenerationContext, target: GenerationTarget, model: string, input: Record<string, unknown>, what: string): Promise<FalResult> {
  const root = queueRoot(target, what);
  const auth = await keyHeader(target, 'Authorization', 'Key ');
  const startS = Math.max(1, Math.floor((ctx.deadlineMs - Date.now()) / 1000));
  const headers = {
    ...auth,
    'X-Fal-Request-Start-Timeout': String(startS),
    'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 3600 }),
  };
  const path = model.split('/').map(encodeURIComponent).join('/');
  const { raw } = await mediaExchange(ctx, { url: `${root}/${path}`, headers, json: input, what, max: JSON_MAX });
  const job = jobOf(answerJson(raw, what, 'sent'), root, what);

  let status: Record<string, unknown>;
  try {
    status = await waitForJob(ctx, what, async () => {
      const { raw: body } = await mediaExchange(ctx, { url: job.statusUrl, method: 'GET', headers: auth, what, max: JSON_MAX });
      const state = answerJson(body, what, 'sent');
      if (state.status === 'COMPLETED') return state;
      if (state.status === 'IN_QUEUE' || state.status === 'IN_PROGRESS') return undefined;
      throw new WorkforceError('unavailable', `${what} on fal.ai lost track of its job.`, reached('sent'));
    });
  } catch (error) {
    if (job.cancelUrl) {
      void ctx.fetch(job.cancelUrl, { method: 'PUT', headers: auth, redirect: 'error', signal: AbortSignal.timeout(CANCEL_MS) })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
    throw atPhase(error, 'sent', `${what} on fal.ai did not finish.`);
  }

  try {
    const result = () => mediaExchange(ctx, { url: job.responseUrl, method: 'GET', headers: auth, what, max: JSON_MAX });
    // a made result is asked once more after a passing failure; a failed job's error answer is not
    const { raw: body } = status.error === undefined ? await retryOnce(ctx, what, result) : await result();
    return { output: answerJson(body, what), requestId: job.requestId };
  } catch (error) {
    if (error instanceof WorkforceError && error.code === 'bad_request') throw error; // the model refused the input (422): nothing made
    if (status.error !== undefined) {
      const type = typeof status.error_type === 'string' && SAFE_TYPE.test(status.error_type) ? ` (${status.error_type})` : '';
      throw new WorkforceError('unavailable', `${what} failed on fal.ai${type}.`);
    }
    throw atPhase(error, 'answered', `${what} on fal.ai finished, but its result could not be read.`);
  }
}
