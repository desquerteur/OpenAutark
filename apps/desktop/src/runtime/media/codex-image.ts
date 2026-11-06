// B-058 G11: an image on the person's ChatGPT plan, for every agent (Claude, HTTP and local ones too) when no
// image model is connected or the chosen one cannot serve: ONE short Codex thread on a signed-in plan login
// (a plan, never an API-key login – that would bill the key) with Codex's own image_generation tool, which only
// agent threads keep (engines/codex/helper-thread.ts AGENT_FEATURES_KEPT; a tool-less turn would be a lean
// helper thread with it off). So the turn offers one tool of ours – image.unable, the model's way to say why it
// cannot – runs read-only (readOnly: no writes, native permission requests rejected) in a folder of its own, asks
// for exactly one image, and the thread is deleted afterwards (thread/delete), so nothing stays in the account's
// Codex history. The image comes back as the imageGeneration item's base64 result, or as its saved file, read
// only inside <CODEX_HOME>/generated_images/ (engines/codex/turn.ts generatedImage). Plan usage, no USD spend:
// Codex reports the account's limits itself.
// Review fix (B-058): an agent thread keeps Codex's shell, and a read-only sandbox still reads every file of the PC –
// so the prompt of any agent (a Claude or HTTP one too) could steer the turn into reading files the agent cannot
// reach. A command, patch or other native tool (anything but the image tool and code mode's exec/wait) stops the
// turn at once; before an image was made that is a failure with a fixed message, and the model's own reply text
// never reaches the caller (only image.unable's short reason, when no native tool ran).
// B-058 i1: the turn now opens an image-only thread (EngineTurnInput.nativeTools 'image' → engines/codex/helper-thread.ts
// imageThread: image_generation on; shell, exec, patch, view_image, web search, browser and computer use off; no
// environment), so view_image – which emits no turn event – is gone too; the stray-tool stop stays as the second line.
// Owns: the account and model pick, the turn, its deadline and stop, the stray-tool stop, and reading the one image back.
// Never: reads token or auth files (only the generated image, after realpath, inside generated_images), uses a
// pay-per-use login, offers our other tools, returns the model's free text, or keeps the thread.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { EngineFile, EngineTurnInput } from '../engines/types.ts';
import { chargeOf } from '../models/pricing.ts';
import { tierRank } from '../routing/score.ts';
import { GENERATED_MAX_BYTES, imageMime } from './generate-http.ts';
import type { Generated, GenerationRequest } from './providers/types.ts';

export type CodexImageServices = Pick<RuntimeServices, 'accounts' | 'catalog' | 'engines' | 'paths' | 'log'>;

export const CODEX_IMAGE_MS = 120_000;
const DELETE_MS = 5_000;
const WHAT = 'Image generation with the ChatGPT plan';
const LUNA = /luna/i;
const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const INSTRUCTIONS = 'I create exactly one image with my image generation tool and then reply with one short sentence. '
  + 'Image generation is my one tool here: a command, a file read or write or any other tool but image.unable stops the turn; image.unable says why when I cannot make the image.';

/** Native tools the image turn may use: the image tool, and code mode's script wrapper (its nested calls are checked one by one). */
const KEPT_NATIVE: ReadonlySet<string> = new Set(['image_generation', 'exec', 'wait']);
const STRAYED = 'Codex started a command instead of only making the image, so the turn was stopped and nothing was made. Describe just the picture (no files, paths or commands) and try again.';

const UNABLE_TOOL = {
  name: 'image.unable',
  description: 'Says in one sentence why I cannot make the image.',
  inputSchema: { type: 'object', properties: { reason: { type: 'string', maxLength: 300 } }, required: ['reason'], additionalProperties: false },
} as EngineTurnInput['tools'][number];

/** The signed-in ChatGPT plan login (Codex) that makes the image, best first; undefined = none. */
export function codexImageAccount(s: Pick<RuntimeServices, 'accounts'>): Account | undefined {
  let accounts: Account[];
  try { accounts = s.accounts.candidates('codex'); } catch { return undefined; }
  return accounts.find((account) => account.provider === 'codex' && account.enabled && account.state === 'ok' && chargeOf(account) === 'plan');
}

/** The account's small model: the newest Luna, else the lowest tier (the image tool does the work, not the chat model). */
function codexModel(s: Pick<RuntimeServices, 'catalog'>, account: Account): ModelInfo | undefined {
  let models: ModelInfo[];
  try { models = s.catalog.list(); } catch { return undefined; }
  const usable = models.filter((model) => model.engine === 'codex' && model.available && (!model.accounts.length || model.accounts.includes(account.id)));
  const luna = usable.filter((model) => LUNA.test(model.model)).sort((a, b) => b.model.localeCompare(a.model, 'en', { numeric: true }));
  if (luna.length) return luna[0];
  return [...usable].sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.relCost ?? 1) - (b.relCost ?? 1))[0];
}

/** The size asked for, as words the image tool understands. */
function sizeLine(size: string | undefined): string {
  if (!size || size === 'auto') return '';
  const [w, h] = size.split('x').map(Number);
  if (!w || !h) return '';
  return ` Format: ${w > h ? 'landscape' : w < h ? 'portrait' : 'square'}, ${size} pixels.`;
}

/** The image of an imageGeneration item: inline base64 (or a data: URL), or its saved file inside <home>/generated_images. */
async function imageBytes(file: EngineFile, account: Account): Promise<Uint8Array> {
  if (file.dataBase64) {
    const body = file.dataBase64.replace(/^data:[^;,]*;base64,/i, '');
    if (body.length > Math.ceil(GENERATED_MAX_BYTES.image / 3) * 4 + 4) throw new WorkforceError('unavailable', 'The generated image is larger than 20 MB.');
    return Buffer.from(body, 'base64');
  }
  if (!file.path) throw new WorkforceError('unavailable', `${WHAT} returned no image.`);
  const home = account.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const root = await realpath(path.join(home, 'generated_images')).catch(() => undefined);
  const real = await realpath(file.path).catch(() => undefined);
  const rel = root && real ? path.relative(root, real) : '';
  if (!real || !rel || rel.startsWith('..') || path.isAbsolute(rel) || !/\.(png|jpe?g|webp)$/i.test(real)) throw new WorkforceError('unavailable', `${WHAT} saved the image where it is not read.`);
  const info = await stat(real);
  if (!info.isFile() || info.size > GENERATED_MAX_BYTES.image) throw new WorkforceError('unavailable', 'The generated image is larger than 20 MB.');
  return readFile(real);
}

/**
 * One image on `account`'s plan (see the header). Rejects with a clear WorkforceError: no Codex model, the
 * plan's limit, signed out, no image (with the model's reason), the deadline, or a stop.
 */
export async function codexImage(s: CodexImageServices, account: Account, request: Pick<GenerationRequest, 'prompt' | 'size'>, options: { signal?: AbortSignal; timeoutMs?: number; agentId?: string } = {}): Promise<Generated & { model: string }> {
  const model = codexModel(s, account);
  if (!model) throw new WorkforceError('unavailable', 'Codex lists no model for this account yet. Check the account in Settings › Models.');
  if (options.signal?.aborted) throw new WorkforceError('cancelled', 'Stopped.');
  const engine = s.engines.get('codex');
  const cwd = path.join(s.paths.temp, 'codex-image');
  await mkdir(cwd, { recursive: true });
  const ms = options.timeoutMs ?? CODEX_IMAGE_MS;
  const controller = new AbortController();
  let late = false;
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { late = true; controller.abort(); }, ms);
  (timer as { unref?: () => void }).unref?.();
  let unable: string | undefined;
  let ref: string | undefined;
  const images = new Set<string>(); // call ids of image tool calls
  let imageMade = false;
  let strayed = false; // a native tool other than the image tool started before an image was made
  const onEvent: EngineTurnInput['onEvent'] = (event) => {
    if (event.type === 'tool_start' && event.own) {
      if (event.name === 'image_generation') { images.add(event.callId); return; }
      if (KEPT_NATIVE.has(event.name)) return;
      if (!imageMade) strayed = true;
      controller.abort(); // the turn ends here; a command's output never reaches another model step
    } else if (event.type === 'tool_end' && event.ok && images.has(event.callId)) imageMade = true;
  };
  try {
    const result = await engine.run({
      runId: `img_${randomUUID()}`, agentId: options.agentId ?? 'runtime', account, model: model.model, effort: 'low',
      system: { stable: INSTRUCTIONS, volatile: 'I reply in one short sentence.' },
      input: [{ type: 'text', text: `I make exactly one image with my image generation tool and write no files.${sizeLine(request.size)} Prompt: ${request.prompt}` }],
      tools: [UNABLE_TOOL],
      callTool: async (_name, args) => {
        const reason = (args as { reason?: unknown })?.reason;
        unable = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, 300) : 'no reason given';
        return { content: [{ type: 'text', text: 'Noted. I end my turn now.' }] };
      },
      cwd, readOnly: true, onEvent, signal: controller.signal,
      nativeTools: 'image', // B-058 i1: image_generation is the thread's one native tool (no shell, view_image …)
    });
    ref = result.session?.ref;
    if (strayed) throw new WorkforceError('unavailable', STRAYED);
    if (late) throw new WorkforceError('timeout', `${WHAT} timed out after ${Math.round(ms / 1000)} s.`);
    if (options.signal?.aborted) throw new WorkforceError('cancelled', 'Stopped.');
    if (result.stop === 'limit') throw new WorkforceError('rate_limited', 'The ChatGPT plan\'s usage limit is reached. Try again after it resets, or add an OpenAI or Gemini API key.');
    if (result.stop !== 'done' && !result.files?.length) throw new WorkforceError('unavailable', result.error?.message || `${WHAT} failed.`);
    const file = result.files?.[0];
    // Only image.unable's reason – never the model's reply text (see the header).
    if (!file) throw new WorkforceError('unavailable', `Codex made no image${unable ? `: ${unable}` : '. Try a plainer description.'}`);
    const bytes = await imageBytes(file, account);
    const mime = imageMime(bytes);
    if (!mime) throw new WorkforceError('unavailable', `${WHAT} returned data that is not a PNG, JPEG or WebP image.`);
    return { bytes, mime, extension: EXTENSION[mime], model: `codex:${model.model}` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    if (ref) await deleteThread(s, engine, account, ref);
  }
}

/** thread/delete before the call returns (live 29.10.: a delete left running lost the race against the server's end), at most DELETE_MS. */
async function deleteThread(s: Pick<CodexImageServices, 'log'>, engine: ReturnType<CodexImageServices['engines']['get']>, account: Account, ref: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<'slow'>((resolve) => { timer = setTimeout(() => resolve('slow'), DELETE_MS); (timer as { unref?: () => void }).unref?.(); });
  try {
    const outcome = await Promise.race([engine.deleteSession?.(account, ref), waited]);
    if (outcome === 'slow') s.log.warn('codex image thread delete still running', {});
  } catch (error) {
    s.log.warn('codex image thread not deleted', { error: String(error) });
  } finally { clearTimeout(timer); }
}
