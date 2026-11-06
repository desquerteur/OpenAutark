// Fetching a team pattern from a URL the person typed (patterns.import / patterns.refresh): https
// only, no credentials or cookies, at most PATTERN_MAX_CHARS of text (the body stream is read with
// a byte limit, whatever content-length says), 15 s, redirects followed by fetch but the final URL
// must stay https. One request per call – never on a schedule. Wave 2: the download itself
// (fetchBoundedText) is shared with SKILL.md link imports (skills/fetch-skill.ts) – one set of rules.
// Owns: these limits and user-safe errors. Never: sends tokens or local data, or keeps the response.

import { WorkforceError } from '../../shared/errors.ts';
import { PATTERN_MAX_CHARS } from '../../shared/model/team-start.ts';

export type FetchText = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; credentials: 'omit'; redirect: 'follow' }) => Promise<{
  ok: boolean; status: number; url?: string; headers: { get(name: string): string | null }; text(): Promise<string>;
  /** The body as a stream (fetch has it): read with a byte limit instead of text(). */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}>;

const TIMEOUT_MS = 15_000;
const TEXT_TYPES = /^(text\/|application\/(json|yaml|x-yaml|octet-stream)|$)/i;

/** What a bounded text download needs from its caller (team patterns here, SKILL.md links in skills/fetch-skill.ts). */
export interface BoundedFetch {
  /** 'pattern', 'skill' – used in the error texts. */
  noun: string;
  maxChars: number;
  /** Accepted content types (the part before ';'). */
  types: RegExp;
  tooLarge: () => WorkforceError;
  /** Refuses a type before the type check (a web page where a raw file is needed). */
  refuse?: (type: string) => WorkforceError | undefined;
  accept?: string;
}

/** The body as text, reading at most `maxBytes` – a missing or wrong content-length cannot make it read more. */
async function boundedText(response: Awaited<ReturnType<FetchText>>, maxBytes: number, tooLarge: () => WorkforceError): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * One https download of a text the person linked: no credentials or cookies, 15 s, the final URL
 * still https, an accepted type, at most `maxChars` (bytes bounded while reading). Returns the text
 * and the URL that was read. The single authority for these rules (patterns and skill links).
 */
export async function fetchBoundedText(url: URL, fetcher: FetchText, options: BoundedFetch): Promise<{ text: string; url: string }> {
  const failed = () => new WorkforceError('unavailable', `The ${options.noun} could not be downloaded. Check the link and the connection.`);
  const maxBytes = options.maxChars * 4;
  let response: Awaited<ReturnType<FetchText>>;
  try {
    response = await fetcher(url.href, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: options.accept ?? 'text/markdown, text/plain;q=0.9, */*;q=0.1' }, credentials: 'omit', redirect: 'follow' });
  } catch {
    throw failed();
  }
  if (response.url && !response.url.startsWith('https:')) throw new WorkforceError('bad_request', 'The link redirected away from https.');
  if (!response.ok) throw new WorkforceError('unavailable', `The ${options.noun} could not be downloaded (HTTP ${response.status}).`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const refused = options.refuse?.(type);
  if (refused) throw refused;
  if (!options.types.test(type)) throw new WorkforceError('bad_request', 'The link does not point to a text file.');
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw options.tooLarge();
  let text: string;
  try { text = await boundedText(response, maxBytes, options.tooLarge); } catch (error) {
    if (error instanceof WorkforceError) throw error;
    throw failed();
  }
  if (text.length > options.maxChars) throw options.tooLarge();
  return { text, url: response.url || url.href };
}

export function checkUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new WorkforceError('bad_request', 'Enter a full https:// link to a pattern file.'); }
  if (url.protocol !== 'https:') throw new WorkforceError('bad_request', 'Patterns are imported over https only.');
  if (url.username || url.password) throw new WorkforceError('bad_request', 'Remove the sign-in part from the link.');
  return url;
}

export async function fetchPattern(value: string, fetcher: FetchText = fetch as unknown as FetchText): Promise<string> {
  const url = checkUrl(value);
  const tooLarge = () => new WorkforceError('bad_request', 'This pattern is too large.');
  return (await fetchBoundedText(url, fetcher, { noun: 'pattern', maxChars: PATTERN_MAX_CHARS, types: TEXT_TYPES, tooLarge })).text;
}
