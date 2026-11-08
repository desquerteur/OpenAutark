// RPC contract part (AF-018): the Projects tab – folders the person codes in, their git state, agents and sessions,
// and starting a new coding session in one. Handlers: runtime/rpc/handlers/projects.ts. Merged into Methods by
// module augmentation. Owns: these method shapes. Never: behaviour.

import type { ConversationSummary } from '../model/chat.ts';
import type { Project, StartSessionInput } from '../model/project.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: every project – added ones and those following from agents' home folders; pinned first, then by activity. Git state may be cached (≤ 60 s). */
    'projects.list': { params: void; result: Project[] };
    /** Owner: one project with its git state read fresh. */
    'projects.get': { params: { id: string }; result: Project };
    /** Owner: adds a folder of this PC as a project (adding it again returns the same project). */
    'projects.add': { params: { folder: string; name?: string }; result: Project };
    /** Owner: renames ('' = the folder's name again) or pins a project. */
    'projects.update': { params: { id: string; name?: string; pinned?: boolean }; result: Project };
    /** Owner: takes the project off the list – its folder, agents and chats stay untouched. */
    'projects.remove': { params: { id: string }; result: { ok: true } };
    /** Owner: a new session – a new chat with a project agent (hired from the folder when it has none) whose first message is the prompt. */
    'projects.startSession': { params: StartSessionInput; result: { project: Project; conversation: ConversationSummary; agentCreated: boolean } };
  }
}

export {};
