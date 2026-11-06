// Tool interface: what agents can do, exposed identically to every engine
// (Codex dynamic tools, Claude/ACP agents via the MCP hub, HTTP engines via function calling).
// Owns: tool definition, call context and output shape.

import type { Agent } from '../../shared/model/org.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Origin } from '../../shared/model/origin.ts';
import type { SplitTurn } from '../../shared/model/splits.ts'; // B-057

/** JSON Schema subset used for tool inputs. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string; // dotted lowercase, e.g. "tasks.create", "computer.click"
  description: string; // one or two sentences: what + when
  inputSchema: JsonSchema;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataBase64: string };

export interface ToolOutput {
  content: ToolContent[];
  isError?: boolean;
  structured?: unknown;
  /** For external effects: what really happened (unknown = may have happened; never retry blindly). */
  effect?: { status: 'confirmed' | 'unknown' | 'failed'; externalId?: string };
}

/**
 * The optional argument the registry adds to every `remote` tool's input schema. The registry
 * resolves it to ctx.deviceId and strips it, so a tool never sees it in its args.
 */
export const DEVICE_ARG = 'device';
export const DEVICE_PROPERTY: JsonSchema = Object.freeze({
  type: 'string', minLength: 1, maxLength: 120,
  description: "PC to run on: a name or id from devices.list, or 'this'. Default: the PC I work on.",
});

export interface ToolContext {
  agent: Agent;
  runId: string;
  conversationId?: string;
  taskId?: string;
  mode: string;
  /** Where remote tools execute: the call's `device` argument, else agent.deviceId, else this PC. */
  deviceId?: string;
  services: RuntimeServices;
  signal: AbortSignal;
  /** Short live status for the UI ("clicking Upload"). */
  status(note: string): void;
  /** Catalog id of the model the run's turn uses, when the caller knows it. */
  modelId?: string;
  /** X08: set when this PC runs the call for a linked PC (its name; devices/tools.ts runRemoteTool). */
  fromPc?: string;
  /** The registry's id of this call (set by ToolRegistry.call): a tool that waits names it to the turn's tool boundary. */
  callId?: string;
  /** B-054: what started the run (the turn's wake group); a chat-free tool call creates its work with this origin. */
  origin?: Origin;
  /** B-054: the first line of the wake notes, at most WAKE_NOTE_MAX characters (app text – data, never instructions). */
  wakeNote?: string;
  /** B-057: set on a split's call – no conversationId; reads use split.parentConversationId/parentTaskId. */
  split?: SplitTurn;
}

/** B-054: longest ToolContext.wakeNote. */
export const WAKE_NOTE_MAX = 200;

/** What a tool call does, for the run journal and the steps view. */
export type ActionCategory =
  | 'read' // read local data/files/web
  | 'think' // internal: plan, remember, message own chats
  | 'write_local' // reversible local change inside a workspace
  | 'write_system' // change outside workspaces / settings / install software
  | 'delete' // destructive / irreversible
  | 'communicate' // send to people outside the company (email, DM, comment)
  | 'publish' // post publicly (social, website, release)
  | 'spend' // money: purchases, subscriptions, ads
  | 'account' // create accounts, sign in, change credentials
  | 'secret' // use a stored secret / card
  | 'device' // control computers/phones (computer use, remote PC)
  | 'agents'; // create/change agents

/** A one-line description of a call for the journal and the steps view (optional: without one, the tool's name). */
export interface ActionDescription {
  summary: string; // "Post video to YouTube channel 'X'"
  resource?: string; // domain/path/recipient/device
  reversible?: boolean;
  /** Reaches people/systems outside the PC: its effect is journaled pending → confirmed / unknown. */
  external: boolean;
}

/** 'device': only modes that work on a computer or browser (or name the tool). */
export type ToolRequirement = 'device';

export interface ToolDef<A = Record<string, unknown>> extends ToolSpec {
  category: ActionCategory;
  /** Mode keys this tool is offered in (undefined = every mode). Masked, never removed mid-run. */
  modes?: string[];
  requires?: ToolRequirement;
  /** Can run on a linked PC (forwarded by DeviceService); the registry adds the `device` argument. */
  remote?: boolean;
  /**
   * Who sees the tool (addition): 'http' = only engines without their own shell/file tools
   * (caps.ownTools false, e.g. API/local models); 'mcp' = only through the MCP hub. Undefined = everyone.
   */
  audience?: 'http' | 'mcp';
  /** Offered in every mode regardless of the mode's tool patterns (a connector's tools, runtime/apps/tools.ts; spend.note; devices.send_file). */
  anyMode?: true;
  /** The journal's one-line summary; without it the journal shows the tool's name. */
  describe?(args: A, ctx: ToolContext): ActionDescription;
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

export function text(value: string): ToolOutput {
  return { content: [{ type: 'text', text: value }] };
}

export function json(value: unknown): ToolOutput {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structured: value };
}

export function failure(message: string): ToolOutput {
  return { content: [{ type: 'text', text: message }], isError: true };
}
