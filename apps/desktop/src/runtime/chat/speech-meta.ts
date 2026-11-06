// Speech meta of a human message: a dictated or spoken message (SendMessageInput.speech) becomes meta.via 'voice' +
// meta.speech { source, live? } – `live`: said in a live conversation or call, not dictated (such lines are never
// folded into a running turn). Older rows may say source 'windows'.
// Owns: that validation. Never: trusts more than these two fields from the client.

import { WorkforceError } from '../../shared/errors.ts';
import type { MessageMeta, SpeechMeta } from '../../shared/model/chat.ts';

const SOURCES: ReadonlyArray<SpeechMeta['source']> = ['endpoint', 'windows'];

function invalid(expected: string): never {
  throw new WorkforceError('bad_request', `Invalid parameter speech: expected ${expected}.`, { details: { param: 'speech', expected } });
}

/** Validated speech meta; undefined when none was sent. Throws bad_request on a wrong shape. */
export function speechMeta(value: unknown): SpeechMeta | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) invalid('{source, live?}');
  const { source, live } = value as Record<string, unknown>;
  if (typeof source !== 'string' || !SOURCES.includes(source as SpeechMeta['source'])) invalid(`source ${SOURCES.join(' | ')}`);
  return { source: source as SpeechMeta['source'], ...(live === true ? { live: true as const } : {}) };
}

/** Message meta with the speech applied (via 'voice'); unchanged without speech. */
export function withSpeech(meta: MessageMeta, value: unknown, _body?: string): MessageMeta {
  const speech = speechMeta(value);
  return speech ? { ...meta, via: 'voice', speech } : meta;
}
