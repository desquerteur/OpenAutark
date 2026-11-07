// Builds the RPC handler table from every handler module. Each module registers its methods
// with their scope rules; a method registered twice throws at startup (table.ts).
// Owns: the list of handler modules. Never: handlers themselves.

import { HandlerTable } from '../table.ts';
import type { HandlerModule } from '../table.ts';
import { register as system } from './system.ts';
import { register as org } from './org.ts';
import { register as chats } from './chats.ts';
import { register as tasks } from './tasks.ts';
import { register as knowledge } from './knowledge.ts';
import { register as files } from './files.ts';
import { register as filesPath } from './files-path.ts'; // the pane's file tab: read, write and list by path
import { register as providers } from './providers.ts';
import { register as security } from './security.ts';
import { register as devices } from './devices.ts';
import { register as app } from './app.ts';
import { register as media } from './media.ts';
import { register as portability } from './portability.ts';
import { register as bridges } from './bridges.ts';
import { register as browser } from './browser.ts'; // MP8: agent browser live view
import { register as sideView } from './side-view.ts'; // B-076: a side-browser tab watched from another PC or the phone
import { register as work } from './work.ts'; // 21.10. 17:09: the person's emergency stop of all agent work
import { register as remote } from './remote.ts'; // connect PCs by Remote ID or address (CEO or employee)
import { register as relay } from './relay.ts'; // the meeting server's state (devices/rendezvous)
import { register as taskCenter } from './task-center.ts'; // quick tasks and "Send to…"
import { register as references } from './references.ts'; // "Remember why…" (references.remember)
import { register as teamStart } from './team-start.ts'; // F-51: team patterns
import { register as calls } from './calls.ts'; // realtime voice sessions
import { register as repair } from './repair.ts'; // 23.10.: repair screen after a broken upgrade or a crash loop (also served by repair/server.ts)
import { register as people } from './people.ts'; // F-52: people of the organisation (owner admin, joining, person variants)
import { register as providerHistory } from './provider-history.ts'; // wave 2: provider histories (Codex thread/delete, Claude Code purge)
import { register as notes } from './notes.ts'; // a chat's shared notes
import { register as agentCore } from './agent-core.ts'; // wave 3: an agent's SYSTEM.md state and Main Skills
import { register as calendar } from './calendar.ts'; // B-041 My day: calendar rows, connected calendars
import { register as day } from './day.ts'; // B-041 My day: own input, planning, briefing, handed off
import { register as chatFiles } from './chat-files.ts'; // B-050: chats.direct (default 1:1), chats.export
import { register as connectedApps } from './connected-apps.ts'; // apps.list / apps.reconnect (connectors are files)
import { register as feedbackInbox } from './feedback-inbox.ts'; // B-055: the team's feedback inbox and wf feedback setup (owner only)
import { register as splits } from './splits.ts'; // B-057: splits.list/get/stop – an agent split into parallel workers
import { register as abilities } from './abilities.ts'; // B-058: abilities.status – the abilities overview
import { register as rpcMethods } from './rpc-methods.ts'; // rpc.methods: what can be called, with its params
import { register as pages } from './pages.ts'; // the views in <data>/pages
import { register as companies } from './companies.ts'; // B-072: the companies on this PC (companies.list / companies.open)
import { register as sideTabs } from './side-tabs.ts'; // B-076: the phone's side pane (tabs.get/set) and tab view positions
import { register as phoneUse } from './phone-use.ts'; // B-078: phoneUse.attach/reply and phone.pairLink (the owner's Android phone)
import { register as access } from './access.ts'; // AF-013: access modes, rules and approval requests
import { register as folderAgents } from './folder-agents.ts'; // AF-014: agent from a folder
import { register as session } from './session.ts';

/**
 * Client-facing modules (chats.ts also registers blocks.*), then providers/security/devices/app,
 * then the rest (portability.ts also registers agents.export/derive and system.backup/restore),
 * then session.ts (session.info reads the finished table at call time).
 */
export const HANDLER_MODULES: readonly HandlerModule[] = [system, org, chats, tasks, knowledge, files, filesPath, providers, security, devices, app, media, portability, bridges, browser, sideView, work, remote, relay, taskCenter, references, teamStart, calls, repair, people, providerHistory, notes, agentCore, calendar, day, chatFiles, connectedApps, feedbackInbox, splits, abilities, pages, companies, sideTabs, phoneUse, access, folderAgents, rpcMethods, session];

export function createHandlerTable(): HandlerTable {
  const table = new HandlerTable();
  for (const register of HANDLER_MODULES) register(table);
  return table;
}
