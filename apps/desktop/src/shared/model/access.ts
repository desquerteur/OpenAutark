// AF-013: what an agent may do on this PC – four access modes like Codex / Claude Code, fine rules and the person's
// answers to an approval request. Stored per agent in <data>/agents/<id>/access.json (runtime/access/store.ts); a chat
// can override the mode for the turns in it (the composer's mode cell), a run through access.setMode.
// Without an access.json an agent keeps full access – the behaviour before AF-013, so nothing existing changes.
// Shapes for the access.* RPC methods and the 'access.*' events, the mode order of the composer's cycle and the labels.
// Owns: these shapes and constants. Never: evaluation (runtime/access/rules.ts) or storage.

/** read: looks, never changes · ask: asks the person before every change · project: changes inside its project folder by
 *  itself, asks for anything outside · full: no limits (the default, as before AF-013). */
export type AccessMode = 'read' | 'ask' | 'project' | 'full';

/** The composer's cycle (Shift+Tab, a click): like Claude Code's – the safer modes first. */
export const ACCESS_MODES: readonly AccessMode[] = ['read', 'ask', 'project', 'full'];

/** The mode an agent has without an access.json – today's behaviour. */
export const DEFAULT_ACCESS_MODE: AccessMode = 'full';
/** AF-014: an agent made from a folder starts here. */
export const FOLDER_AGENT_MODE: AccessMode = 'project';

export const ACCESS_MODE_LABELS: Readonly<Record<AccessMode, { label: string; short: string; description: string }>> = {
  read: { label: 'Read only', short: 'Read only', description: 'Reads files and the web, changes nothing.' },
  ask: { label: 'Ask before changes', short: 'Ask first', description: 'Asks you before every change, command or message.' },
  project: { label: 'Auto in project folder', short: 'Project', description: 'Works in its project folder by itself and asks for anything outside it.' },
  full: { label: 'Full access', short: 'Full access', description: 'Works on the whole PC without asking.' },
};

/** allow: runs · ask: the person decides in the approval dialog · deny: never runs. */
export type AccessChoice = 'allow' | 'ask' | 'deny';

/** Fine rules. Deny beats allow, allow beats the mode. Patterns: `*` matches anything (`git *`, `app.github.*`). */
export interface AccessRules {
  /** Absolute folders: `write` may also be changed outside the project, `deny` is never read or changed. */
  folders?: { write?: string[]; deny?: string[] };
  /** Shell commands (Bash, PowerShell, shell.exec): `allow` runs without asking, `deny` never runs. */
  commands?: { allow?: string[]; deny?: string[] };
  /** Web pages, downloads and commands that reach the network (absent: allowed – reading the web is no change). */
  network?: AccessChoice;
  /** Connectors and MCP tools by tool name (`app.<connector>.<tool>`, `mcp__server__tool`). */
  tools?: { allow?: string[]; deny?: string[] };
  /** Spending money (tools of the spend category; absent: the mode decides – full allows, read denies, others ask). */
  money?: AccessChoice;
}

/** An agent's stored access (access.json). */
export interface AgentAccess {
  mode: AccessMode;
  rules: AccessRules;
}

/** Where the mode in effect comes from. */
export type AccessSource = 'agent' | 'chat' | 'run' | 'default';

/** The access in effect for one turn of an agent (access.get). */
export interface EffectiveAccess extends AgentAccess {
  agentId: string;
  source: AccessSource;
  /** The agent's own mode (the chat or run may override it). */
  agentMode: AccessMode;
  /** The folder its turns start in: 'project' changes are free inside it (absent: the workspace). */
  project?: string;
}

/** One thing an agent wants to do, as the rules judge it. */
export type AccessAction =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string; delete?: boolean }
  | { kind: 'command'; command: string; cwd?: string }
  | { kind: 'network'; target?: string }
  | { kind: 'tool'; name: string; category?: string }
  | { kind: 'spend'; name: string };

/** The person's answer in the approval dialog. */
export type AccessAnswer = 'once' | 'always' | 'deny';

/** A pending approval request (the dialog shows the oldest; access.pending lists them). */
export interface AccessRequest {
  id: string;
  agentId: string;
  agentName: string;
  conversationId?: string;
  runId?: string;
  mode: AccessMode;
  action: AccessAction;
  /** One line: what the agent wants to do ("Run npm install in C:\\code\\app"). */
  summary: string;
  /** Why it needs the person (outside its mode, a rule asks). */
  reason: string;
  /** What "Always for this agent" would add to its rules ("allow commands `npm install*`"). */
  always?: string;
  /** Engine that asks (claude, codex, acp, or 'tools' for the app's own tools). */
  via: string;
  at: number;
}

declare module '../api/events.ts' {
  interface EventMap {
    /** AF-013: an agent waits for the person's approval (topic: system, owner). */
    'access.requested': AccessRequest;
    /** AF-013: a request was answered, cancelled or timed out (topic: system, owner). */
    'access.resolved': { id: string; answer: AccessAnswer | 'cancelled' };
    /** AF-013: an agent's access or a chat's mode changed (topic: system, owner). */
    'access.changed': { agentId?: string; conversationId?: string };
  }
}
