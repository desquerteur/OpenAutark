// Which agent is "the Manager" and which chat is its first chat (the one the first run opens). The rules live
// in shared/text/manager-chat.ts – the runtime uses them too (the start text, a manager's bundled report);
// this module keeps the window's import path.
// Owns: nothing of its own (re-export, tested in test/unit/ui). Never: reads signals or RPC.

export { managerAgent, managerFirstChat } from '../../shared/text/manager-chat.ts';
