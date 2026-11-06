// The write-only mailbox (B-055 Q2): one sealed letter becomes one Firestore document feedback/<id> through the REST
// API with the project's public web API key – no SDK, no sign-in. The document id is the report's stable request id,
// so a retry after a lost answer finds its own letter (HTTP 409 ALREADY_EXISTS = it arrived) instead of a second one.
// The rule (resources/feedback/firestore.rules) allows only this create: fields v = 1 and sealed (bytes < 1,000,000).
// Owns: the create request and what its answer means. Never: reads, lists or deletes letters (inbox.ts, team only),
// or sends anything but the sealed bytes.

import { FEEDBACK_SEALED_LIMIT } from '../../shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { ReceiverConfig } from './receiver.ts';
import { FIRESTORE_ORIGIN, request } from './transport.ts';

/** Firestore document ids the rule accepts (≤ 64 characters; we only ever use these characters). */
export const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const NOT_SET_UP = 'Sending feedback is not set up in this version. Your report is saved on this PC.';
const RETRY = 'Feedback could not be sent right now. Your report is saved on this PC; try again later.';
const REFUSED = 'The feedback mailbox refused this report. It is saved on this PC.';

/** The documents URL of the mailbox (`endpoint`: a local fake in tests). */
export function documentsUrl(config: Pick<ReceiverConfig, 'project' | 'endpoint'>): string {
  return `${config.endpoint ?? FIRESTORE_ORIGIN}/v1/projects/${encodeURIComponent(config.project)}/databases/(default)/documents`;
}

/**
 * Creates feedback/<id> with the sealed bytes. 'created': it is in the mailbox now; 'exists': an earlier attempt
 * already put it there (only this sender knows the id). The answer echoes only `v` (mask), never the letter.
 */
export async function dropSealed(config: ReceiverConfig, id: string, sealed: Uint8Array, run: typeof fetch = fetch): Promise<'created' | 'exists'> {
  if (!DOCUMENT_ID.test(id)) throw new WorkforceError('bad_request', 'Invalid feedback id.');
  if (sealed.byteLength > FEEDBACK_SEALED_LIMIT) throw new WorkforceError('bad_request', 'This report is too large to send.');
  const url = `${documentsUrl(config)}/feedback?documentId=${encodeURIComponent(id)}&mask.fieldPaths=v&key=${encodeURIComponent(config.apiKey)}`;
  const body = JSON.stringify({ fields: { v: { integerValue: '1' }, sealed: { bytesValue: Buffer.from(sealed).toString('base64') } } });
  let status: number;
  try {
    ({ status } = await request(run, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, 0));
  } catch {
    throw new WorkforceError('unavailable', RETRY);
  }
  if (status >= 200 && status < 300) return 'created';
  if (status === 409) return 'exists';
  if (status === 400 || status === 403 || status === 404) throw new WorkforceError('unavailable', REFUSED);
  throw new WorkforceError('unavailable', RETRY);
}
