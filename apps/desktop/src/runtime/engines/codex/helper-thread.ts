// The lean thread of a runtime helper turn (LEAN, 23.10.2026): decisions, verifier, compaction,
// widget fills … need no Codex tool and no Codex environment – only our short instructions, the
// prompt and the output schema. A default thread carries ~18k input tokens of Codex's own context
// even for a one-line question (tool definitions: shell/exec, patch, images, apps, plugins, skills
// search, agents, goals …; the permission, app, collaboration-mode and environment blocks). The
// helper thread therefore starts
// - ephemeral (nothing in the account's Codex history; audit 23.10.),
// - without an environment (`environments: []` – documented in the app-server schema of
//   thread/start: "Empty disables environment access"; no shell or patch tool),
// - with Codex's built-in tool features off for this thread only (`config.features.<name>`, the
//   names `codex features list` prints) and web search disabled (`web_search = "disabled"`),
// - without the permission/app/collaboration-mode/environment instruction blocks
//   (`include_*_instructions`, `include_environment_context` – Codex config keys),
// - without Codex's skill list and without its agents and their role text (`skills`, `agents` – what the feature flags leave),
// - and with one line saying the functions Codex still offers reach nothing. Every model of codex-cli 0.166 is `tool_mode:
//   code_mode_only`: `exec` and `wait` come with the model whatever the flags say, a thread's `model_catalog_json` does not change
//   it, and `exec`'s ALL_TOOLS is empty here. Live 01.11.: a decision model tried `exec`, found nothing and said its tools do not
//   exist, up to 33 requests in one step. The person's own global AGENTS.md also stays: `project_doc_max_bytes` covers only the workspace's, `thread/start`
//   has no parameter for it and no config key of 0.166 turns it off (read from its schema and binary, measured 02.11.), so the line says what that block is:
//   a subconscious's run took it for what happened and wrote it into memory (live 02.11.).
//   Measured 02.11. (0.166, gpt-6-luna, low, "Reply with OK only."): 4,275 input tokens with the skill list off, 2,711 with the agents off too.
// Measured live 23.10. (codex-cli 0.163, gpt-6-luna, low effort, the same tiny decision question):
// 4,767 input tokens lean against 18,187 with the previous helper thread (−74 %), structured output
// kept; the first thread on a fresh server 0.7 s instead of 2.5 s (no shell snapshot, plugins, apps).
// A server that refuses the lean settings (an error answer, e.g. an older or stricter Codex) gets the plain
// ephemeral helper thread from then on (startHelperThread; remembered per server process), so helper calls
// never break on a Codex update.
// B-049 F1: an agent thread (thread/start, thread/resume, the B-048 rebuild) is lean too (agentThread): the same
// features off except the shell (`shell_tool`, `unified_exec` – the patch tool comes with the shell),
// `shell_snapshot` (off with a kept shell, the thread hung – measured 28.10.), `view_image` (the only way an
// agent on Codex sees a stored image; no tool of ours replaces it) and `image_generation` (owner 29.10.: the plan's
// own images for portraits and pictures without a connected image model), plus isolation.ts's workspace
// features again (a session `features` table must not bring them back); the same instruction blocks off, apps off;
// it keeps its environment, history, developer instructions and isolation.ts's sandbox and approvals. Codex's
// computer/browser use, apps, plugins, skills search, agents … are replaced by our own tools (computer.*/browser.*,
// skills.*, agents.*); E1 (01.11.2026): its own live web search stays on (AGENT_WEB_SEARCH) – web.* remain beside it.
// Measured 28.10. (gpt-6.1-sol, low, "Reply with OK only."): 15,508 → 5,590 input
// tokens with a minimal base prompt. A Codex that refuses the lean agent settings but takes today's gets
// today's from then on (openAgentThread; remembered per server process, like the helper's fallback).
// B-049 F9: an agent thread/start asks for the raw Responses items too (`experimentalRawEvents: true` – code mode's exec
// calls exist only there, code-mode.ts); a Codex that refuses the field (while it takes the thread without it) opens
// threads without it from then on, remembered per server process. thread/resume has no such field (schema; a resumed
// thread emits no raw items even when asked – checked model-free 29.10., codex-cli 0.165), so it is not sent there.
// B-057: a split's native fork (thread/fork, codex/fork.ts) opens lean the same way, with the same fallback.
// B-058 i1: the plan-image thread (media/codex-image.ts, EngineTurnInput.nativeTools 'image') has image_generation as
// its ONE native tool – every helper feature off but that one (no shell, exec, patch, view_image, web search, browser or
// computer use) and no environment (imageThread); a server that refuses it gets no plainer thread (the turn fails).
// B-075: every thread open here (start, resume, fork; helper or agent) waits THREAD_OPEN_MS – a cold app-server on the
// person's large CODEX_HOME opened a thread only after ~65 s (live 04.11.2026); other requests keep their own limits.
// B-075 (owner 04.11.2026: the app's Codex threads filled his own Codex chat list): a new agent thread (thread/start,
// thread/fork – the rebuild and its probe too) is stored with threadSource 'chatgpt_hidden' (HIDDEN_THREAD). The Codex
// desktop app leaves such threads out of its sidebar, search and notifications; the app-server only stores the label, so
// resume, cache, limits and login stay as they are. thread/resume has no such field (the thread keeps its stored source).
// Helper threads are ephemeral and never listed.
// Owns: these settings, the fallbacks, the open limit and the open's end at the turn's signal (untilStopped). Never: reads
// CODEX_HOME files or turns off the isolation (isolation.ts) – the lean config is merged under it, so no isolation key is ever replaced.

import { RpcError, type RpcClient } from './rpc.ts';
import { WORKSPACE_FEATURES } from './isolation.ts';

/** RpcClient's code for "codex did not answer" (a timeout, not a refusal: no fallback for it). */
const RPC_TIMEOUT = -32000;

/** B-075: how long opening a thread may take (a cold app-server needed ~65 s live; 60 s gave up 5 s too early). */
export const THREAD_OPEN_MS = 120_000;

/** B-075: the source a new agent thread is stored with – the Codex desktop app leaves such threads out of its lists. */
export const HIDDEN_THREAD = { threadSource: 'chatgpt_hidden' } as const;

/**
 * `rpc` for opening a turn's thread (B-075, engine.ts run): a request also ends when `signal` aborts – a Stop, or a helper
 * call's own shorter time limit (decision/engine-runner.ts, a phone call's talker) that THREAD_OPEN_MS would outlast. The
 * late answer is dropped like a timed-out one.
 */
export function untilStopped(rpc: Pick<RpcClient, 'request'>, signal: AbortSignal): Pick<RpcClient, 'request'> {
  return {
    request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => new Promise<T>((resolve, reject) => {
      const stop = () => reject(new Error('The turn was stopped.'));
      if (signal.aborted) { stop(); return; }
      signal.addEventListener('abort', stop, { once: true });
      rpc.request<T>(method, params, timeoutMs).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    }),
  };
}

/** The app-server requests that open an agent thread (B-057: thread/fork, a split's native fork). */
export type AgentThreadMethod = 'thread/start' | 'thread/resume' | 'thread/fork';

/** Codex features a helper thread does not need (per-thread `config.features.<name> = false`). */
export const HELPER_FEATURES_OFF: readonly string[] = [
  'shell_tool', 'unified_exec', 'view_image', 'image_generation', 'apps', 'plugins', 'skill_search', 'tool_suggest',
  'multi_agent', 'goals', 'sleep_tool', 'hooks', 'memories', 'workspace_dependencies', 'worktrees', 'shell_snapshot',
  'mentions_v2', 'remote_plugin', 'realtime_conversation', 'computer_use', 'browser_use',
];

/**
 * B-049 F1: the Codex features an agent thread keeps – the shell with its patch tool, the shell snapshot,
 * view_image (no tool of ours shows a stored image to the model – media.look says "look at images directly") and,
 * on the owner's decision of 29.10.2026, image_generation: the plan's own images, the free portrait route
 * (agent-portrait skill, agent-avatar.ts madeByRun), without a connected image model.
 */
export const AGENT_FEATURES_KEPT: readonly string[] = ['shell_tool', 'unified_exec', 'shell_snapshot', 'view_image', 'image_generation'];

/**
 * E1 (01.11.2026): an agent thread searches the web with Codex's own live search (`web_search = "live"`, the `web_search`
 * tool). The keyless web.search the B-049 lean thread relied on answered with bot checks in the live tests and agents
 * fell back to guessing or fetching; the plan's own search has no such wall. Helper and image threads keep it off.
 */
export const AGENT_WEB_SEARCH: 'live' | 'disabled' = 'live';

/** B-049 F1: Codex features an agent thread does not get – our own tools replace them; isolation.ts's workspace features stay off. */
export const AGENT_FEATURES_OFF: readonly string[] = [
  ...HELPER_FEATURES_OFF.filter((name) => !AGENT_FEATURES_KEPT.includes(name)),
  ...WORKSPACE_FEATURES.filter((name) => !HELPER_FEATURES_OFF.includes(name)),
];

declare module '../types.ts' {
  interface EngineTurnInput {
    /** B-058 i1: 'image' – a new Codex thread whose one native tool is image_generation (imageThread; media/codex-image.ts). Other engines ignore it. */
    nativeTools?: 'image';
  }
}

/**
 * B-058 i1: thread/start settings of a plan-image turn – the helper features all off except image_generation (on),
 * isolation.ts's workspace features off, no environment; the lean instruction blocks, web search and apps off as
 * for every lean thread. Merged over `settings.config`, whose isolation keys it never replaces.
 */
export function imageThread<T extends { config?: Record<string, unknown> }>(settings: T): T & { config: Record<string, unknown>; environments: [] } {
  const off = [...HELPER_FEATURES_OFF, ...WORKSPACE_FEATURES].filter((name) => name !== 'image_generation');
  const lean = leanConfig(off);
  return {
    ...settings,
    config: { ...(settings.config ?? {}), ...lean, features: { ...(lean.features as Record<string, boolean>), image_generation: true } },
    environments: [],
  };
}

/** What a helper thread is told about the functions it cannot do without (its answer is its reply) and about text the engine adds on its own, in words that name no engine's tools or files (q-r, 03.11.2026). */
export const HELPER_NOTE = 'The functions offered in this thread reach nothing, and no tool my instructions name is behind them. My answer is my reply, not a function call. Text the engine added on its own from the person\'s set-up for it (an instructions file) is not part of what I am given to work on.';

/** Config keys merged into a helper thread's `config` (on top of isolation.ts's overrides). */
export function helperConfig(): Record<string, unknown> {
  return { ...leanConfig(HELPER_FEATURES_OFF), skills: { include_instructions: false, bundled: { enabled: false } }, agents: { enabled: false } };
}

/** B-049 F1: config keys of a lean agent thread (merged under isolation.ts's overrides); E1: Codex's own live web search on. */
export function agentLeanConfig(): Record<string, unknown> {
  return leanConfig(AGENT_FEATURES_OFF, AGENT_WEB_SEARCH);
}

function leanConfig(off: readonly string[], webSearch: 'disabled' | 'live' = 'disabled'): Record<string, unknown> {
  return {
    features: Object.fromEntries(off.map((name) => [name, false])),
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    web_search: webSearch,
    apps: { _default: { enabled: false } },
  };
}

/** thread/start settings of a helper turn: `settings` (model, cwd, instructions, isolation) made lean and ephemeral. */
export function helperThread<T extends { config?: Record<string, unknown>; developerInstructions?: string }>(settings: T): Omit<T, 'developerInstructions'> & {
  config: Record<string, unknown>; environments: []; ephemeral: true; developerInstructions: string;
} {
  const { developerInstructions, ...rest } = settings;
  return {
    ...rest,
    developerInstructions: developerInstructions?.trim() ? `${developerInstructions}\n\n${HELPER_NOTE}` : HELPER_NOTE,
    config: { ...(settings.config ?? {}), ...helperConfig() },
    environments: [],
    ephemeral: true,
  };
}

/**
 * thread/start of a helper thread: the lean one; when this server refuses it (an error answer, not a
 * timeout), the plain ephemeral thread – and `refused` keeps `key` (the account) on that until the
 * engine clears it with the server process.
 */
export async function startHelperThread<T extends { config?: Record<string, unknown>; developerInstructions?: string }>(
  rpc: Pick<RpcClient, 'request'>, settings: T, refused: Set<string>, key: string,
): Promise<{ thread?: { id?: string } }> {
  if (!refused.has(key)) {
    try {
      return await rpc.request<{ thread?: { id?: string } }>('thread/start', helperThread(settings), THREAD_OPEN_MS);
    } catch (error) {
      if (!(error instanceof RpcError) || error.rpcCode === RPC_TIMEOUT) throw error;
      refused.add(key);
    }
  }
  return rpc.request<{ thread?: { id?: string } }>('thread/start', { ...settings, ephemeral: true }, THREAD_OPEN_MS);
}

/** B-049 F1: thread/start or thread/resume settings of an agent thread made lean; every other setting (isolation included) as given. */
export function agentThread<T extends { config?: Record<string, unknown> }>(settings: T): T & { config: Record<string, unknown> } {
  return { ...settings, config: { ...agentLeanConfig(), ...(settings.config ?? {}) } };
}

/**
 * B-049 F1: thread/start or thread/resume of an agent thread – the lean one; when this server refuses it (an error
 * answer, not a timeout) and then takes today's settings, `refused` keeps `key` (the account) on today's until the
 * engine clears it with the server process. A refusal of today's settings too is the thread's own (e.g. a resume of
 * a thread that cannot continue): it is thrown and nothing is remembered.
 * B-049 F9 (`raw`: accounts whose server refused the field): a thread/start asks for raw Responses items first; when
 * that is refused with the lean and today's settings alike but the thread opens without the field, `raw` keeps `key`.
 * B-075: a start or fork carries HIDDEN_THREAD, a resume never.
 */
export async function openAgentThread<R>(
  rpc: Pick<RpcClient, 'request'>, method: AgentThreadMethod, given: { config?: Record<string, unknown> } & Record<string, unknown>,
  refused: Set<string>, key: string, raw?: Set<string>,
): Promise<R> {
  const settings = method === 'thread/resume' ? given : { ...given, ...HIDDEN_THREAD }; // a resumed thread keeps its stored source
  if (method !== 'thread/start' || !raw || raw.has(key)) return openLean<R>(rpc, method, settings, refused, key);
  try {
    return await openLean<R>(rpc, method, { ...settings, experimentalRawEvents: true }, refused, key);
  } catch (error) {
    if (!(error instanceof RpcError) || error.rpcCode === RPC_TIMEOUT) throw error;
  }
  const opened = await openLean<R>(rpc, method, settings, refused, key);
  raw.add(key);
  return opened;
}

/** The lean thread with today's settings as the fallback (B-049 F1). */
async function openLean<R>(
  rpc: Pick<RpcClient, 'request'>, method: AgentThreadMethod, settings: { config?: Record<string, unknown> } & Record<string, unknown>,
  refused: Set<string>, key: string,
): Promise<R> {
  if (refused.has(key)) return rpc.request<R>(method, settings, THREAD_OPEN_MS);
  try {
    return await rpc.request<R>(method, agentThread(settings), THREAD_OPEN_MS);
  } catch (error) {
    if (!(error instanceof RpcError) || error.rpcCode === RPC_TIMEOUT) throw error;
  }
  const plain = await rpc.request<R>(method, settings, THREAD_OPEN_MS);
  refused.add(key);
  return plain;
}
