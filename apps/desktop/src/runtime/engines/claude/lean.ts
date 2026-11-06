// B-049 F2: lean Claude Code agent turns. An agent turn (the MCP hub or tools, no output schema) runs with OUR
// system prompt only and Claude Code's built-in tools cut down to the execution core; the hub stays.
// Read from claude 2.1.303 (`--help`, the binary, code.claude.com cli-reference / tools-reference / mcp /
// agent-sdk modifying-system-prompts, 28.10.2026) and checked model-free with 2.1.303 (an `initialize`-only
// start, no user message: every lean flag is taken, `commands: []` against the full skill and command list):
// - `--system-prompt-file` replaces Claude Code's whole default prompt (identity, tool guidance, environment and
//   git status) instead of appending to it. A new session's prompt puts a line `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`
//   between the stable and the volatile part (2.1.275+): Claude Code sends them as two cached blocks, so the
//   stable part stays cached across new sessions of one agent; a resumed session's file holds the stable part only.
// - `--tools Bash,Read,Edit,Write,Glob,Grep,WebSearch` (+ PowerShell on Windows: Claude Code's Windows shell, the only
//   one on a PC without Git Bash): WebFetch, Agent, Task*/TodoWrite, NotebookEdit, Skill, ToolSearch, Cron*, Monitor,
//   LSP … are gone (EndConversation cannot be removed by design); MCP tools are not affected. E1 (01.11.2026):
//   WebSearch stays – the plan's own server-side search; the keyless web.search answered with bot checks in the live
//   tests (our web.fetch reads a page, so WebFetch stays out).
//   Without ToolSearch the hub's tools load upfront (documented), and the hub entry says `alwaysLoad: true`, so
//   startup waits for them (at most the 5 s connect timeout) and the first request already carries them.
// - `--disable-slash-commands`: no skills and no slash commands (also no skill listing).
// - `--settings {"disableAllHooks":true}`: no hooks from the account home's settings or its plugins; managed
//   policy hooks still run. It only narrows: no permission, MCP server, plugin or directory is added.
// - LEAN_ENV on every turn process (helper turns too; an older CLI ignores unknown variables):
//   CLAUDE_CODE_DISABLE_CLAUDE_MDS (no CLAUDE.md of any level, no auto-memory files), CLAUDE_CODE_DISABLE_AUTO_MEMORY,
//   CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS (the commit/PR workflow text in the Bash tool description and the git
//   status snapshot – both also reach a custom system prompt).
// Not used: --safe-mode (it drops --mcp-config servers: our hub; 2.1.303 code), --bare (Anthropic auth only through
// ANTHROPIC_API_KEY, never the subscription login), --exclude-dynamic-system-prompt-sections (ignored with
// --system-prompt-file), --restricted (would ignore the account's user settings and confine the file tools),
// CLAUDE_CODE_DISABLE_ATTACHMENTS (also drops file-changed notes; its effect on steered lines is unverified).
// Fallback: a CLI that refuses a flag exits at once without a line on stdout (2.1.303: `error: unknown option
// '…'`, exit 1, checked). A lean start that ends that way while no lean turn of this process has answered yet is
// retried once with today's arguments (appended prompt, no tool list, hub without alwaysLoad); when that one
// answers, the lean flags stay off in this process (LeanMemory). No line = no system/init = no model call yet.
// To measure live (weekly limit, not done): input tokens per call lean against today, the hub tools in the first
// request, cache reads of the stable block on a second new session, summarized thinking and steering unchanged.
// Helper turns (decision, verifier, compaction, the subconscious's brains) run lean too, without any built-in tool: measured live
// 02.11.2026 with 2.1.303 and Haiku, `--tools ''` with `--json-schema` leaves exactly `StructuredOutput`, and one step costs 2,830
// tokens of context instead of 25,841 and took one model request instead of two (today's form offered Task, Edit, Write, PowerShell … to a turn that must only answer).
// Owns: the lean arguments, environment, prompt text and hub config, and the per-process refusal memory.
// Never: widens what a turn may do (no allow rule, MCP server or directory) or drops the hub.

import { HUB_SERVER } from './stream.ts';

/** Claude Code's built-in tools an agent turn keeps: the execution core and its own web search. Everything else comes from our hub. */
export const CORE_TOOLS: readonly string[] = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch'];

/** The core for this platform: Windows adds PowerShell, Claude Code's shell there (on by default for claude.ai logins). */
export function coreTools(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [...CORE_TOOLS, 'PowerShell'] : [...CORE_TOOLS];
}

/** Every turn process: no CLAUDE.md, no auto memory, no built-in git workflow text (documented variables). */
export const LEAN_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
};

/** Session settings of a lean turn (`--settings`): only narrowing keys. */
export const LEAN_SETTINGS = '{"disableAllHooks":true}';

/** The line Claude Code splits a custom system prompt at (cached static part above, per-session part below). */
export const PROMPT_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/** The prompt file's text: lean, a volatile part follows the boundary line; today's form joins the parts. */
export function promptText(stable: string, volatile: string | undefined, lean: boolean): string {
  const parts = lean && stable && volatile ? [stable, PROMPT_BOUNDARY, volatile] : [stable, volatile ?? ''];
  return parts.filter(Boolean).join('\n\n');
}

/** The prompt flag and, lean, the tool core, no skills/commands and no hooks; today's appended prompt otherwise. */
export function promptArgs(promptFile: string, lean: boolean, platform?: NodeJS.Platform): string[] {
  return lean
    ? ['--system-prompt-file', promptFile, '--tools', coreTools(platform).join(','), '--disable-slash-commands', '--settings', LEAN_SETTINGS]
    : ['--append-system-prompt-file', promptFile];
}

/**
 * The hub entry's `timeout`: without it Claude Code 2.1.303 cuts a hub call after 60 s ("The operation timed out.", live 02.11.2026), while the
 * call goes on here. A tool's own limit and the stall watch stay what ends a call that hangs.
 */
export const HUB_CALL_MS = 60 * 60_000;

/** A helper turn's form, lean: our system prompt only and no built-in tool; the answer tool of `--json-schema` stays (see the head of this file). */
export function helperPromptArgs(promptFile: string, lean: boolean): string[] {
  return lean ? ['--system-prompt-file', promptFile, '--tools', '', '--disable-slash-commands', '--settings', LEAN_SETTINGS] : ['--append-system-prompt-file', promptFile];
}

/** The hub's MCP config file text; lean, its tools load upfront and startup waits for them (alwaysLoad). */
export function hubConfig(mcp: { url: string; token: string }, lean: boolean): string {
  const server = { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, timeout: HUB_CALL_MS, ...(lean ? { alwaysLoad: true } : {}) };
  return JSON.stringify({ mcpServers: { [HUB_SERVER]: server } });
}

/**
 * Whether this process's Claude Code takes the lean flags: unknown until a lean turn answers ('ok'); a lean start
 * that ended without a line before that is taken as a refusal once today's arguments answer ('refused', kept for
 * the process). A retry that ends without a line too was no refusal (the CLI fails either way): unknown again.
 */
export class LeanMemory {
  private state: 'unknown' | 'ok' | 'refused' = 'unknown';

  /** Whether the next agent turn starts lean. */
  allowed(): boolean { return this.state !== 'refused'; }

  /** After a lean start; true = start once more with today's arguments. */
  afterLean(quiet: boolean): boolean {
    if (!quiet) { this.state = 'ok'; return false; }
    if (this.state === 'ok') return false;
    this.state = 'refused';
    return true;
  }

  /** After that retry. */
  afterRetry(quiet: boolean): void {
    if (quiet && this.state === 'refused') this.state = 'unknown';
  }
}
