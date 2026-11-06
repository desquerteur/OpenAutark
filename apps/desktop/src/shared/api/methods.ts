// The typed RPC contract: every method a client may call on the runtime.
// Owns: the Methods interface with the core methods (system, org, chats, tasks, knowledge, files –
// the S1 handler modules) and MethodName/ParamsOf/ResultOf. Every other area adds its methods by
// module augmentation in its own part: methods-<area>.ts next to this file (one per handler module,
// e.g. providers, security, devices, app, media, bridges, browser) or a shared/model file.
// Consumers import Methods and the helper types from here only; each layer's typecheck includes all
// of src/shared, so every part is seen. A new method goes into its area's part (or a new
// methods-<area>.ts its handler imports), not here – this file stays small.
// Handlers live in src/runtime/rpc/handlers/*, the typed client in src/ui/lib/rpc.ts.
// Naming: `<domain>.<verb>`, params are one object, results are plain data. Never: behaviour.

import type { Agent, AgentTemplate, OrgNode, Space } from '../model/org.ts';
import type { Attachment, Conversation, ConversationSettings, ConversationSummary, Member, Message, SendMessageInput } from '../model/chat.ts';
import type { CreateTaskInput, Schedule, ScheduleSpec, Task, TaskFilter, TaskStatus, TaskView } from '../model/tasks.ts';
import type { KnowledgeHit, KnowledgeItem, KnowledgeKind, KnowledgeQuery, ModeInfo, ModeSaveInput, ModeSaveResult, SkillInfo } from '../model/knowledge.ts';
import type { AgentActivity, Run, RunItem } from '../model/runs.ts';
import type { FileRef, ResourceState, Settings, SettingsPatch, SystemInfo } from '../model/system.ts';
import type { Topic } from './protocol.ts';
import type { RestoreStatus } from '../model/restore.ts';

// The parts split out of this file by area (23.10.); the result types consumers import from here
// are re-exported below.
import './methods-providers.ts';
import './methods-security.ts';
import './methods-devices.ts';
import './methods-app.ts';
import './methods-media.ts';
import './methods-bridges.ts';
import './methods-browser.ts';

type Page<T> = { items: T[]; next?: string };

export interface Methods {
  // ----------------------------------------------------------------- system
  'system.info': { params: void; result: SystemInfo };
  'system.resources': { params: void; result: ResourceState };
  'events.subscribe': { params: { topics: Topic[] }; result: { ok: true } };
  'events.unsubscribe': { params: { topics: Topic[] }; result: { ok: true } };
  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  'ui.state': { params: void; result: { drafts: Record<string, string>; secretDrafts?: Record<string, string[]>; lastConversationId?: string } };
  'ui.saveDraft': { params: { conversationId: string; text: string; attachments?: Attachment[]; secrets?: string[] }; result: { ok: true } };
  /** Added for the desktop updater (package B): may the app restart now without losing work? */
  'system.restartReadiness': { params: void; result: { ready: boolean; reasons: string[] } };
  /**
   * Added for the desktop updater (package B): pause new wakes, checkpoint runs, flush WAL before
   * quitAndInstall. `cancel: true` resumes when the restart did not happen after all.
   */
  'system.prepareRestart': { params: { cancel?: boolean } | void; result: { ok: true } };
  /** Added by R4 contracts: consistent copy of the database + blobs into `dir` (default chosen by the runtime). Owner scope. */
  'system.backup': { params: { dir?: string } | void; result: { path: string; bytes: number } };
  /** Added by R4 contracts: stages a backup; it replaces the data on the next start (applyPendingRestore). Owner scope. */
  'system.restore': { params: { path: string }; result: { ok: true; restartRequired: true } };
  'system.restoreStatus': { params: void; result: RestoreStatus }; // MM7: staged/last restore, canRestart. Owner scope.
  'system.restartRuntime': { params: void; result: { ok: true } }; // MM7: the host restarts the runtime (applies a staged restore); 'unavailable' headless. Owner scope.

  // ----------------------------------------------------------------- org
  'spaces.list': { params: void; result: Space[] };
  'spaces.save': { params: Partial<Space> & { name: string }; result: Space };
  'spaces.archive': { params: { id: string }; result: { ok: true } };
  'agents.list': { params: { includeArchived?: boolean } | void; result: Agent[] };
  'agents.get': { params: { id: string }; result: Agent };
  'agents.org': { params: void; result: OrgNode[] };
  'agents.templates': { params: void; result: AgentTemplate[] };
  'agents.create': { params: { name?: string; template?: string; role?: string; managerId?: string; spaceId?: string; instructions?: string; mode?: string }; result: Agent };
  'agents.update': { params: { id: string; patch: Partial<Pick<Agent, 'name' | 'role' | 'avatar' | 'instructions' | 'mode' | 'skills' | 'modelPolicy' | 'managerId' | 'spaceId' | 'team' | 'deviceId' | 'voice'>>; /** Wave 3: the instructions an editor started from – changed meanwhile (SYSTEM.md, another edit) = 'conflict'. */ base?: { instructions: string } }; result: Agent };
  'agents.archive': { params: { id: string }; result: { ok: true } };
  /** O6: brings an archived agent back (under its old manager while active, else the person). */
  'agents.restore': { params: { id: string }; result: Agent };
  'agents.activity': { params: void; result: AgentActivity[] };
  'agents.runs': { params: { id: string; limit?: number }; result: Run[] };
  /** Added by R4 contracts: an agent (+ optionally its knowledge) as a portable file in the blob store. Owner scope. */
  'agents.export': { params: { id: string; includeKnowledge?: boolean }; result: FileRef };
  'runs.items': { params: { runId: string }; result: RunItem[] };
  'runs.cancel': { params: { runId: string }; result: { ok: true } };

  // ----------------------------------------------------------------- chats
  'chats.list': { params: { includeHidden?: boolean; search?: string } | void; result: ConversationSummary[] };
  'chats.get': { params: { id: string }; result: ConversationSummary };
  'chats.create': { params: { title?: string; agentIds: string[]; spaceId?: string; firstMessage?: string; people?: string[] }; result: Conversation }; // people (F-52): person ids
  'chats.update': { params: { id: string; title?: string; pinned?: boolean; settings?: Partial<ConversationSettings> }; result: Conversation };
  'chats.members': { params: { id: string; add?: string[]; remove?: string[]; lead?: string }; result: Member[] };
  'chats.archive': { params: { id: string }; result: { ok: true } };
  'chats.delete': { params: { id: string }; result: { ok: true } };
  'chats.markRead': { params: { id: string; seq: number }; result: { ok: true } };
  'chats.search': { params: { text: string; conversationId?: string; limit?: number }; result: Array<{ message: Message; conversationTitle: string; snippet: string }> };
  'chats.direct': { params: { memberId: string }; result: ConversationSummary }; // B-050 K1: the caller's default 1:1 with memberId (agent, person or the owner), created on first open
  'chats.export': { params: { conversationIds: string[]; dir?: string }; result: { dir: string; chats: number; messages: number; files: number } }; // B-050 K8 (b): chat folders and their files
  'messages.list': { params: { conversationId: string; beforeSeq?: number; limit?: number }; result: Message[] };
  'messages.send': { params: SendMessageInput; result: Message };
  'messages.edit': { params: { id: string; body: string }; result: Message };
  'messages.delete': { params: { id: string }; result: { ok: true } };
  'messages.stop': { params: { conversationId: string; agentId?: string }; result: { ok: true } };
  'messages.retry': { params: { messageId: string }; result: { ok: true } };
  /** T11: `priority` 'important' posts it as important (B-050 K4: 'silent' posts it quietly; never with asTask); `asTask` (needs 'tasks') posts a team task each time (kind 'routine'; first line = title, "- " lines = steps). */
  'messages.schedule': { params: { conversationId: string; body: string; spec: ScheduleSpec; mentions?: string[]; priority?: 'normal' | 'important' | 'silent'; asTask?: boolean; ultra?: boolean }; result: Schedule }; // ultra (B-057): Ultra suggested for the scheduled message
  'blocks.answer': { params: { messageId: string; blockIndex: number; answer: unknown; clientId?: string }; result: { ok: true; taskId?: string } };
  'blocks.state': { params: { messageId: string; blockIndex: number; state?: unknown }; result: { state: unknown } };
  /** Added by package B: raw HTML of an ```app fence, served by main at wf-sandbox://app/<messageId>/<blockIndex>. */
  'blocks.appHtml': { params: { messageId: string; blockIndex: number }; result: { html: string } };
  /**
   * Added by package C2: an event from a sandboxed ```app (wf.send → name/data; wf.prompt → name
   * 'prompt', data {text}). Delivered to the authoring agent as `[ui-event …] (from mini-app)`;
   * never counts as consent or an approval. The host rate-limits before calling.
   */
  'blocks.event': { params: { messageId: string; blockIndex: number; name: string; data?: unknown }; result: { ok: true } };
  /**
   * Added by R3 group D: the PWA frame path of an ```app fence
   * (`/sandbox/app?m=…&i=…&e=<expiresAt>&t=<HMAC>`), valid for 10 minutes and until the runtime
   * restarts. `expiresAt` is runtime time. The desktop uses wf-sandbox:// instead.
   */
  'blocks.sandboxUrl': { params: { messageId: string; blockIndex: number }; result: { url: string; expiresAt: number } };

  // ----------------------------------------------------------------- tasks
  'tasks.list': { params: TaskFilter | void; result: TaskView[] };
  'tasks.get': { params: { id: string }; result: TaskView };
  'tasks.create': { params: Omit<CreateTaskInput, 'origin' | 'spaceId'>; result: TaskView }; // B-054: no conversationId = a chat-free task; origin and space are runtime-written
  'tasks.update': { params: { id: string; rev?: number; patch: Partial<Pick<Task, 'title' | 'notes' | 'dueAt' | 'priority' | 'doneWhen' | 'dependsOn' | 'mode' | 'assigneeKind' | 'assigneeId' | 'sort'>> }; result: TaskView };
  'tasks.setStatus': { params: { id: string; status: TaskStatus; note?: string }; result: TaskView };
  'tasks.complete': { params: { id: string; answer?: unknown; note?: string; clientId?: string }; result: TaskView };
  'tasks.reorder': { params: { ids: string[] }; result: { ok: true } };
  'tasks.delete': { params: { id: string }; result: { ok: true } };
  /** Human to-dos: open tasks assigned to the human, across all chats. */
  'todos.list': { params: { limit?: number } | void; result: TaskView[] };
  /** Turn free text typed into the To-do list into a task with the right widget. */
  'todos.add': { params: { text: string; conversationId?: string }; result: TaskView };
  'todos.changeWidget': { params: { id: string; type: string }; result: TaskView };
  /** F03: snooze a to-do (by id or its chat block) for `minutes` or until a time (epoch ms). */
  'todos.snooze': { params: { id?: string; messageId?: string; blockIndex?: number; minutes?: number; until?: number }; result: TaskView };
  'todos.stopRepeating': { params: { id: string }; result: TaskView };
  /** "Give to me": team work becomes the person's to-do. */
  'tasks.makeMine': { params: { id: string }; result: TaskView };
  /** F06 "Can't do this…": the person declines a to-do (cancelled with the reason; its author is woken). Not for host approvals. */
  'todos.decline': { params: { id: string; reason?: string; clientId?: string }; result: TaskView };
  /** F06: removes a to-do the person added (agents' to-dos are declined instead). */
  'todos.remove': { params: { id: string }; result: { ok: true } };
  'schedules.list': { params: { conversationId?: string; ownerId?: string } | void; result: Schedule[] };
  /** T11: `body`/`priority`/`mentions` reword the person's own message or task post (not an agent's). */
  'schedules.update': { params: { id: string; active?: boolean; spec?: ScheduleSpec; title?: string; body?: string; priority?: 'normal' | 'important' | 'silent'; mentions?: string[] }; result: Schedule };
  'schedules.delete': { params: { id: string }; result: { ok: true } };
  'schedules.runNow': { params: { id: string }; result: { ok: true } };
  /** T11: the next fire times of a spec (default 3, at most 10; `runs` already made count against maxRuns). Read-only. */
  'schedules.preview': { params: { spec: ScheduleSpec; count?: number; runs?: number }; result: { times: number[] } };

  // ----------------------------------------------------------------- knowledge, skills, modes
  'knowledge.search': { params: KnowledgeQuery; result: KnowledgeHit[] };
  /** `kinds` (CTX5): several kinds at once – the knowledge browser lists every kind except observations. */
  /** B-044: `before` = saved before ("Older than"); the first page names the kinds stored at all (`kinds`). */
  'knowledge.list': { params: { scope?: string; scopeId?: string; kind?: string; kinds?: string[]; pinned?: boolean; cursor?: string; limit?: number; before?: number }; result: Page<KnowledgeItem> & { kinds?: KnowledgeKind[] } };
  'knowledge.save': { params: Partial<KnowledgeItem> & { title: string; body: string; scope: KnowledgeItem['scope'] }; result: KnowledgeItem };
  'knowledge.expire': { params: { id: string; reason?: string }; result: { ok: true } };
  'knowledge.history': { params: { id: string }; result: KnowledgeItem[] };
  /** CTX5: pin/unpin the current version in place (no new version); 'chat' tier like knowledge.save. */
  'knowledge.pin': { params: { id: string; pinned: boolean }; result: KnowledgeItem };
  /** CTX5: forget permanently – every version of the item and its search rows. Owner only; `confirm` must be true. */
  'knowledge.forget': { params: { id: string; confirm: true }; result: { ok: true; ids: string[] } };
  'skills.list': { params: { every?: boolean } | void; result: SkillInfo[] }; // every: one row per copy, not per name (Settings › Skills & memory)
  'skills.get': { params: { name: string }; result: { info: SkillInfo; body: string } };
  /** `modes` (CTX4): modes whose skill index lists the skill ([] = every mode); absent keeps the current ones. */
  'skills.save': { params: { name: string; description: string; body: string; ownerAgentId?: string; modes?: string[] }; result: SkillInfo };
  'skills.delete': { params: { name: string }; result: { ok: true } };
  'modes.list': { params: void; result: ModeInfo[] };
  /** CTX8, owner only: save a mode of your own (left-out fields keep the mode's or `from`'s values) / delete it (`restored`: the built-in is back). */
  'modes.save': { params: ModeSaveInput; result: ModeSaveResult };
  'modes.delete': { params: { key: string }; result: { ok: true; restored: boolean } };
  /** B-044, owner only: opens <data>/modes (the own modes as files) in this PC's file manager. */
  'modes.openFolder': { params: void; result: { ok: true } };

  // ----------------------------------------------------------------- files
  'files.upload': { params: { name: string; mime?: string; dataBase64: string }; result: FileRef };
  /**
   * Added by package C2: chunked upload for recordings/large files (chunks ≤ 4 MB, base64).
   * Chunks of one `uploadId` (prefix 'up') arrive in `index` order; the call with `final: true`
   * stores the joined bytes and returns the FileRef. Intermediate calls return `{ received }`.
   */
  'files.uploadChunk': { params: { uploadId: string; index: number; dataBase64: string; final?: boolean; name: string; mime?: string; conversationId?: string }; result: { received: number; file?: FileRef } }; // conversationId: a person's upload into their chat (F-52)
  'files.uploadPath': { params: { path: string; device?: string }; result: FileRef }; // the owner and the phone ('manage'); B-076 `device`: a linked PC's file
  'files.get': { params: { id: string }; result: FileRef };
  'files.read': { params: { id: string; maxBytes?: number }; result: { dataBase64: string; mime: string } };
  'files.open': { params: { id: string; reveal?: boolean }; result: { ok: true } }; // owner scope
  /** Added by package C2: open a deliverable by its workspace path (`file` block: Open / Show in folder). Owner scope. */
  'files.openPath': { params: { path: string; reveal?: boolean; anywhere?: boolean }; result: { ok: true } }; // anywhere: outside the workspace and data folder too (the file tab)
}

export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = Methods[M]['params'];
export type ResultOf<M extends MethodName> = Methods[M]['result'];

export type { AccessTicket, AccessWait, SessionInfo } from './methods-devices.ts';
