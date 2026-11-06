// B-058 G13: a file the Gemini API generated and handed out as a Files API URI (Gemini Omni video with
// `delivery: "uri"`, ai.google.dev/gemini-api/docs/omni and /api/files, read 29.10.2026): GET {base}/files/{id}
// until its state is ACTIVE (PROCESSING meanwhile, FAILED ends it) – the bounded poll of this one file
// (job.ts waitForJob, which rides out a passing failure) –, then GET {base}/files/{id}:download?alt=media. Both requests go to the account's own
// API origin with the key header (the official SDK does the same, redirects included); the id is read from the
// URI, the URL is never taken from the answer.
// Owns: this wait and download. Never: logs or returns the key or a raw provider body.

import { WorkforceError } from '../../../shared/errors.ts';
import { mediaExchange, reached } from '../generate-http.ts';
import { answerJson, downloadResult, waitForJob } from './job.ts';
import type { GenerationContext, GenerationKind } from './types.ts';

const FILE_ID = /\/files\/([a-z0-9][a-z0-9-]{0,39})(?=$|[:/?])/i;

/** The Files API id in a generated file's URI ('…/v1beta/files/abc-123:download?alt=media' → 'abc-123'). */
export function generatedFileId(uri: unknown): string | undefined {
  return typeof uri === 'string' ? FILE_ID.exec(uri)?.[1] : undefined;
}

/** Waits until the generated file is ACTIVE and downloads it; every failure is at phase 'answered' (it was made). */
export async function downloadGeneratedFile(ctx: GenerationContext, input: { base: string; headers: Record<string, string>; uri: unknown; kind: GenerationKind; what: string }): Promise<{ bytes: Buffer; type: string }> {
  const { base, headers, kind, what } = input;
  const id = generatedFileId(input.uri);
  if (!id) throw new WorkforceError('unavailable', `${what} returned no usable file.`, reached('answered'));
  try {
    await waitForJob(ctx, what, async () => {
      const { raw } = await mediaExchange(ctx, { url: `${base}/files/${id}`, method: 'GET', headers, what, max: 256 * 1024 });
      const file = answerJson(raw, what);
      if (file.state === 'ACTIVE') return true;
      if (file.state === 'FAILED') throw new WorkforceError('unavailable', `${what} failed while the Gemini API stored the file.`, reached('answered')); // final: never asked again
      return undefined;
    });
  } catch (error) {
    const known = error instanceof WorkforceError;
    throw new WorkforceError(known ? error.code : 'unavailable', known ? error.message : `${what} did not finish.`, reached('answered'));
  }
  return downloadResult(ctx, `${base}/files/${id}:download?alt=media`, kind, what, headers);
}
