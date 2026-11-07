// AF-013: what a call wants to do, in the words of the access rules (shared/model/access.ts AccessAction) – for the
// app's own tools (by name, arguments and category), Claude Code's permission prompts (tool_name + input), Codex's
// approval requests (command, cwd, the file change's paths) and ACP permission requests (kind, rawInput, locations).
// One line per action for the approval dialog too.
// Owns: these mappings. Never: judges (rules.ts) or decides anything.

import type { AccessAction } from '../../shared/model/access.ts';

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A command given as a string or as argv. */
const commandText = (value: unknown): string | undefined => Array.isArray(value) ? value.filter((part) => typeof part === 'string').join(' ') || undefined : str(value);

/** Words in a connector tool's name that mean money moves. */
const MONEY_WORDS = /(pay|purchase|checkout|buy|order|charge|refund|transfer|subscri|invoice)/i;

/** The app's own tool call (tools/registry.ts): its actions; none = it changes nothing the rules look at. */
export function toolActions(tool: { name: string; category: string }, args: Record<string, unknown>): AccessAction[] {
  const { name, category } = tool;
  if (name === 'shell.exec' || name === 'secrets.run') {
    const command = str(args.command);
    return command ? [{ kind: 'command', command, ...(str(args.cwd) ? { cwd: str(args.cwd)! } : {}) }] : [{ kind: 'tool', name, category }];
  }
  if (name === 'files.write') return [{ kind: 'write', path: str(args.path) ?? '.' }];
  if (name === 'files.read' || name === 'files.list' || name === 'files.search') {
    const target = str(args.path) ?? str(args.folder) ?? str(args.root);
    return target ? [{ kind: 'read', path: target }] : [];
  }
  if (name === 'web.fetch' || name === 'web.search' || name === 'browser.open') return [{ kind: 'network', ...(str(args.url) ?? str(args.query) ? { target: (str(args.url) ?? str(args.query))! } : {}) }];
  if (category === 'spend') return [{ kind: 'spend', name }];
  if (name.startsWith('app.')) {
    const out: AccessAction[] = [{ kind: 'tool', name, category }];
    if (MONEY_WORDS.test(name.split('.').slice(2).join('.'))) out.push({ kind: 'spend', name });
    return out;
  }
  if (category === 'read' || category === 'think') return [];
  return [{ kind: 'tool', name, category }];
}

/** Claude Code's built-in tools that only read or think (never asked about in 'ask'). */
const CLAUDE_QUIET: ReadonlySet<string> = new Set(['TodoWrite', 'TodoRead', 'EnterPlanMode', 'ExitPlanMode', 'Task', 'TaskOutput', 'EndConversation', 'StructuredOutput']);

/** One permission prompt of Claude Code (`--permission-prompt-tool`): `tool_name` and its `input`; `cwd` = the turn's folder. */
export function claudeActions(toolName: string, input: Record<string, unknown>, cwd: string): AccessAction[] {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command);
      return command ? [{ kind: 'command', command, cwd }] : [{ kind: 'tool', name: toolName, category: 'write_system' }];
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return [{ kind: 'write', path: str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? cwd }];
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return [{ kind: 'read', path: str(input.file_path) ?? str(input.path) ?? cwd }];
    case 'WebFetch':
    case 'WebSearch':
      return [{ kind: 'network', ...(str(input.url) ?? str(input.query) ? { target: (str(input.url) ?? str(input.query))! } : {}) }];
    default:
      if (CLAUDE_QUIET.has(toolName)) return [];
      return [{ kind: 'tool', name: toolName }];
  }
}

/** One Codex approval request (engines/codex/approvals.ts APPROVAL_METHODS); `paths`: the file change item's paths when known. */
export function codexActions(method: string, params: Record<string, unknown>, cwd: string, paths: readonly string[] = []): AccessAction[] {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const command = commandText(params.command);
    return command ? [{ kind: 'command', command, cwd: str(params.cwd) ?? cwd }] : [{ kind: 'tool', name: 'a Codex command', category: 'write_system' }];
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const changed = isRecord(params.fileChanges) ? Object.keys(params.fileChanges) : [];
    const all = [...new Set([...changed, ...paths])];
    if (all.length) return all.map((file) => ({ kind: 'write' as const, path: file }));
    const root = str(params.grantRoot);
    return root ? [{ kind: 'write', path: `${root.replace(/[\\/]+$/, '')}/` }] : [{ kind: 'tool', name: 'a Codex file change', category: 'write_system' }];
  }
  const asked = JSON.stringify(params.permissions ?? params).toLowerCase();
  if (asked.includes('network')) return [{ kind: 'network' }];
  return [{ kind: 'tool', name: 'more Codex permissions', category: 'write_system' }];
}

/** One ACP `session/request_permission` tool call. */
export function acpActions(call: Record<string, unknown>, cwd: string): AccessAction[] {
  const kind = str(call.kind) ?? 'other';
  const raw = isRecord(call.rawInput) ? call.rawInput : {};
  const locations = (Array.isArray(call.locations) ? call.locations : []).filter(isRecord).map((entry) => str(entry.path)).filter((entry): entry is string => !!entry);
  const title = str(call.title) ?? 'a tool';
  switch (kind) {
    case 'execute': {
      const command = commandText(raw.command) ?? title;
      return [{ kind: 'command', command, cwd: str(raw.cwd) ?? cwd }];
    }
    case 'edit':
    case 'delete':
    case 'move': {
      const targets = locations.length ? locations : [str(raw.path) ?? str(raw.file_path)].filter((entry): entry is string => !!entry);
      if (!targets.length) return [{ kind: 'tool', name: title, category: 'write_system' }];
      return targets.map((target) => ({ kind: 'write' as const, path: target, ...(kind === 'delete' ? { delete: true } : {}) }));
    }
    case 'read':
    case 'search':
      return locations.map((target) => ({ kind: 'read' as const, path: target }));
    case 'fetch':
      return [{ kind: 'network' }];
    case 'think':
      return [];
    default:
      return [{ kind: 'tool', name: title }];
  }
}

const cut = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The dialog's one line for an action. */
export function actionSummary(action: AccessAction): string {
  switch (action.kind) {
    case 'read': return `Read ${cut(action.path)}`;
    case 'write': return `${action.delete ? 'Delete' : 'Change'} ${cut(action.path)}`;
    case 'command': return `Run \`${cut(action.command)}\`${action.cwd ? ` in ${cut(action.cwd, 80)}` : ''}`;
    case 'network': return action.target ? `Go online: ${cut(action.target)}` : 'Go online';
    case 'spend': return `Spend money with ${action.name}`;
    case 'tool': return `Use ${cut(action.name, 80)}`;
  }
}
