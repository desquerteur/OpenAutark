# Architecture – Workforce agent OS

> The map of the code as it is now – for every human and agent that works on it: layers, modules, data, flows and the
> rules each part owns. The product is Autark; the code still says `workforce`. Build history: BUILD_LOG (internal).

## 1. The product in one paragraph

One person runs an AI company on their PC: a manager, teams of specialist agents (video, web, research, social,
finance …) and a private secretary, across company, personal brand and private life. The person talks to agents
in **chats** (a chat is a place, not an agent), gives **tasks** (one simple task model: whoever owns it works on it
until it is done or they ask), and looks at a calm **My day**: the few things only a human can do, what they
handed off, and their calendar. Agents are trusted like senior employees: they act on the whole PC without
asking, hire and archive colleagues (themselves included), split work into parallel parts (Ultra), use any model
(Codex, Claude Code, ACP plan CLIs, API keys, local servers) and work on linked PCs and Android phones. The
system behind it is deliberately small: **a SQLite store plus a few plain files and skills**. Anything without a
screen of its own (connectors, look, settings, devices) the AI changes by editing those files – the person just
tells the AI.

## 2. Process model

```
┌──────────── Electron main (src/main) ─────────────────────┐
│ window · tray · updates · launcher · protocols · IPC      │
│ the person's browser (native tabs + side driver)          │
│ media analyzer window · capture · Host services           │
└──────┬───────────────────────────────┬────────────────────┘
       │ utilityProcess + MessagePort   │ MessagePort (handed over by the preload)
┌──────▼───────────────────┐    ┌──────▼──────────────────┐
│ Runtime (src/runtime)    │◄──►│ UI renderer (src/ui)    │
│ pure Node, no electron   │RPC │ Preact + signals        │
│ SQLite · agents · tools  │    └─────────────────────────┘
│ engines · MCP hub        │◄── WebSocket /ws ─────── PWA on phone/browser (same src/ui), wf CLI
│ HTTP :47811              │◄── POST /rpc + bearer ── scripts and agents (token in runtime.json)
│ peer listener :47812     │◄── pinned-key channel ── linked PCs (same runtime) · meeting server
└──────┬───────────────────┘◄── MCP over HTTP ─────── Codex / Claude Code / ACP CLI processes
       │ child processes as leases: codex app-server per account, claude -p per turn, ACP CLIs,
       │ PowerShell UIA helper, adb, stdio MCP servers, Playwright browsers of agents
```

* **Runtime** (`src/runtime`) owns all state and behaviour and never imports `electron`. The few things only the
  host can do (OS keychain encrypt/decrypt, screenshots, notifications, power events, the person's browser,
  the media analyzer, restart) it asks through `Host` (`runtime/host.ts`; `host-electron.ts` over the host bridge,
  `host-node.ts` headless). Entry points: `entry-electron.ts` (the utility process, bundled to `app/runtime.mjs`)
  and `cli.ts` (headless, `app/runtime-cli.mjs --data <dir>`, used on worker PCs and in tests). The composition
  root is `runtime/main.ts`: `compose/services.ts` builds every service, `compose/network.ts` everything that
  serves clients, `compose/lifecycle.ts` holds the restore-before-open and the ordered stop steps.
* **Repair runtime**: `repair/boot.ts` asks the start guard (`<data>/boot.json`); after repeated start crashes or
  a failed upgrade the utility process runs `repair/server.ts` instead, and the UI shows `ui/repair/RepairScreen.tsx`
  (Retry, put back the pre-update copy, diagnostics export).
* **Main** (`src/main`) is thin: `index.ts` (pre-ready: single instance, schemes), `desktop.ts` (composition),
  `runtime-host.ts` (fork, launch-token handshake, restart with backoff), `runtime-link.ts`/`renderer-link.ts`,
  `window.ts` (hardened window, hidden title bar), `window-recovery.ts` (a renderer crash reloads; more than two
  in a minute show "Try again"), `tray.ts` (Open, Quit, "Stop all agent work"), `work-stop.ts` (global shortcut),
  `companies.ts` (several companies per installation, §3), `host-services.ts` (notifications with their sound, §4.2),
  `updates/*` (electron-updater state machine; on macOS, where Squirrel.Mac refuses an ad-hoc signed app, an own
  self-update `updates/mac-self-update.ts`, only once the product is named Autark), `identity-move.ts` (B-066: at the
  first start as Autark the old data folder `Proactive Agent Workforce` moves by one atomic rename – never copied or
  merged – and the old updater cache goes; a no-op unless packaged, named exactly Autark and on the default data
  folder; `logs/identity-move.log`; installer side `assets/installer.nsh`), `launcher*.ts` ("Start with Windows" = keep agents running:
  one per-user Task Scheduler task, `run-state.json`, `next-due.json`), `protocols/*` (`app://`, `wf-sandbox://`,
  `wf-file://`), `session-guards.ts` (microphone only for our page while armed), `workspace-*.ts` and `side-driver/`
  (§10), `media-analyzer*.ts` (keyframes, audio decode, image prep in a hidden offscreen window), `title-bar.ts`
  (§11). Closing the window does not stop agents when `closeToTray` is on.
* **Preload** (`src/preload`) exposes `window.workforce` (`shared/api/desktop.ts`) over IPC; `main-world.ts` guards
  the runtime port. `ipc.ts` accepts only our window's main frame; `ipc-args.ts` checks every argument.
* **UI** (`src/ui`) is one Preact app for the desktop window *and* the PWA served by the runtime. It only talks
  RPC (`ui/lib/rpc.ts`: MessagePort on desktop, WebSocket elsewhere). Layouts: desktop columns and the phone stack.
* **Shared** (`src/shared`): pure types, the RPC contract (`shared/api`), models (`shared/model`), the generative-UI
  block catalog (`shared/blocks`), text and voice helpers. No Node, DOM or Electron imports.
* **Who calls** (`shared/api/protocol.ts` `ClientScope`, decided by the transport, never by the client): `owner`
  (desktop window, local CLI, bearer token from `runtime.json`), `device` (a paired phone/browser of the owner),
  `person` (a device of an employee), `peer` (a linked PC runtime), `agent` (an MCP lease of a running turn),
  `external` (an external agent docked into one chat). `rpc/server.ts` dispatches, `rpc/scopes.ts` filters pushed
  events, the handler table (`rpc/handlers/*`) decides which scope may call what.
* **HTTP server** (`runtime/http/server.ts`, port 47811 or the next free one): static UI and service worker for the
  PWA, `/ws` RPC, `POST /rpc` (tokenless pairing/join exchange, or a bearer token for programs), `GET /events`
  (Server-Sent Events, `docs/EXTERNAL_PROTOCOL.md`), `/mcp` (the MCP hub, loopback only), `/files/<sha256>`,
  `/sandbox/app` (mini-tools for the PWA). `http/peer-server.ts` is the separate peer listener (47812) other PCs
  dial; it is open only while needed. Host allowlist, Origin check and the bind gate are in `http/security.ts`.

## 3. Data: a SQLite store plus a few files

**The system is a few files plus skills.** Everything a person or an AI is meant to change lives as a plain file
in the data folder; the database holds what the app writes (chats, tasks, runs, knowledge). There is no data-folder
guard: agents read and write these files like any other.

`<data>` = Electron userData (headless: `--data`, tests: `WORKFORCE_TEST_DATA`). Layout: `runtime/root/layout.ts`;
paths: `runtime/system/paths.ts`.

**Companies** (`main/companies.ts`, `runtime/root/companies.ts`, `shared/model/companies.ts`): a company is one data
folder. The first is `<appData>/Autark`, every other one `<appData>/Autark Companies/<id>` (id `[a-z0-9][a-z0-9-]{0,39}`,
new ones `company-2`, `company-3` …; the folders are the list). `main/index.ts` reads `--company=<id>` and sets userData
before the single-instance lock, so each company is its own process with its own lock, runtime, database,
`settings.json`, tray, window, Remote ID and "Keep agents running" launcher (task, LaunchAgent or unit named with its id);
the workspace of every company but the first is `<data>/workspace`, and `AUTARK_DATA=<data>` points its agents' `wf`
at its own runtime. The profile menu (`ui/shell/ProfileMenu.tsx`, desktop) lists the companies (the
label from the profile's company or name) and "New company"; `companies.open` (host op `company.open`) starts the target
detached or shows it if it runs, and the asking window hides to its tray while its agents keep working; a new company's
first window runs the normal first run. Only the first company runs the updater (About says so in the others); after an
update it starts every other company whose run-state was running. The tray's "Stop all agent work" and the global
shortcut stop every company on this PC (`work.stop` over loopback `/rpc` with each one's token from its `runtime.json`;
a company whose shortcut registration failed retries while its agents work); the window's own stop and Resume act on
its own company. The uninstaller removes the other companies' launcher tasks too (`assets/installer.nsh`).

| Entry | What it is | Owner (code) |
|---|---|---|
| `README.md` | Generated map: every entry, what editing it does, how to call the running app | `root/readme.ts` |
| `settings.json` | **The only settings store**, written whole: JSON with comments (profile, preferences, notifications, voice, routing = "Models", onboarding, feedback, pwa, devices, day, calendar). Every key is present with its current value and a comment line above it naming its purpose, options or range and default; `null` means the default | `settings/schema.ts` (the one table), `read.ts`, `service.ts`, `validate.ts`, `defaults.ts` |
| `settings.schema.json` | JSON Schema (draft-07) of the same table for editors and scripts: enums, ranges, patterns, defaults, descriptions; written by the app once per start – never edit | `settings/schema.ts` (`schemaText()`), `settings/service.ts` |
| `theme.css` | The app's look: CSS applied live on top of the shipped styles (tokens such as `--surface`, `--text`; dark mode `:root[data-theme=dark]`). Delete it to go back | `root/theme.ts` |
| `settings.json › appearance` | AF-010/AF-008: look and layout (Settings › Appearance, `ui/settings/AppearancePage.tsx`) – where a chat's tabs dock and their sizes (`chatDock`), the person's own themes (`themes`, in use: `theme`; `shared/model/themes.ts` makes CSS custom properties that `lib/appearance.ts` puts under `theme.css`), the panels a new tab offers (`panels`, `hiddenPanels`); checked in `settings/appearance-schema.ts` | `shared/model/appearance.ts`, `ui/lib/appearance.ts` |
| `agents/<id>/` | `SYSTEM.md` (the agent's instructions – authoritative), `skills/<name>/SKILL.md` (its Main Skills), `agent.json`, `avatar.png/jpg` copy; `agents/README.md` says who is who | `agent-core/*` |
| `memory/` | **The memory tree** (§5.2): one Markdown file per entry in folders by who it is for – `company/`, `branches/<space>/`, `agents/<id>/`, `references/<person>/`, `chats/<chat>/` and any topic subfolder (`_folder.md` describes a folder). The files are the truth; anyone may edit them; writing or changing one makes it findable with `vector.search` | `knowledge/memory-*.ts`, `tools/builtin/memory.ts` |
| `prompts/` | Own versions of the shipped prompts (`identity`, `rules`, `skills`, `compaction`, `onboarding`, `agent-default`, `subconscious`) – a file here replaces the shipped one | `context/templates.ts` |
| `modes/` | Own modes (`<key>.md`), replacing a shipped mode of the same key | `modes/service.ts` |
| `secrets/` | The secrets catalog: one `<route>.md` per route listing entries (id, name, kind, tags, description) – never a value | `secrets/files.ts` |
| `connectors/` | `mcp.json` (MCP servers, the usual `mcpServers` map), `mail.json` (mailboxes), `status.json` (written by the app) | `apps/connectors.ts`, `apps/service.ts` |
| `chats/` | A readable mirror of the chats (`chat.json`, `messages/<yyyy>-<mm>.jsonl`); the database stays the original | `chat-files/mirror.ts` |
| `side-tabs.json` | The browser tabs per space: `global` (the person's pane), `chat:<id>` (a chat's area), `agent:<id>` (an agent's own area, kept by that agent); the window follows an edit within a second (§10) | `root/side-tabs.ts`, `main/workspace-tabs.ts` |

App-managed (never reported by the watcher): `workforce.db` (+ WAL), `blobs/ab/cd/<sha256>` (content-addressed
files, `files/store.ts`), `accounts/<provider>/<id>/` (isolated CLI homes), `browser-profiles/<agentId>/`, `logs/`,
`tmp/`, `backups/`, `exports/`, `engine-cwd/` (empty folder CLI engines start in), `engine-prompts/`,
`models/speech/` (local speech models and, on the same download rail, the local embedding model `embedding-minilm-l12-int8`, fetched on first need, §5.3), `engine-transcripts/` (rebuilt Claude Code sessions, §5.5), `runtime.json` ({port, token} while the app runs), `boot.json`,
`run-state.json`, `next-due.json`, `window-state.json`, `bin/` (the agents' `wf` shim, below). The workspace for projects
and artifacts is `<home>/Workforce` (`downloads/`, `inbox/`, shared skills in `skills/<name>/SKILL.md`); another
company's is `<data>/workspace`.

**One watcher** (`root/watcher.ts`) watches `<data>` by OS events (no polling). Each entry has one owner that
registers with it; the app's own writes are recognised (`root/marks.ts`) and not reported back. Text files the app
writes and others may edit at the same time go through `root/text-doc.ts` (atomic writes; an unusable edit is kept
as `<name>.rejected.md` with a quiet notice, `root/notice.ts`).

**settings.json rules** (`settings/schema.ts`, `read.ts`, `service.ts`): one table (`schema.ts`) lists every section and
key – purpose, options or range, pattern, default – and everything else is built from it: the file text
(`settingsText()`, a header, `"$schema": "./settings.schema.json"`, one comment line per section and key such as
`// Colour scheme of the window. Options: system | light | dark. Default: system`), `settings.schema.json`
(`schemaText()`), the defaults (`defaults.ts`), the checks (`validate.ts`) and the reader (`parseText()`/`stripJsonc()`:
`//` and `/* */` comments outside strings and trailing commas are accepted, no dependency). Reading (`read.ts`): defaults
⊕ file; each section is validated on its own; an invalid section keeps its last good value and shows a quiet notice;
`null` or a missing key means the default; `"$schema"` is skipped; unknown keys are dropped. Writing: the app writes
the **whole** file after every update and after every read whose text differs from the whole current text – that keeps
the comments current, turns an old file of differences into the whole file once (every value the person set stays) and
leaves an invalid value as written with a `// Not applied (<reason>) …` line above it. Never overwritten: the store
from before the rebuild until its import moved it aside, a file that is not JSON at all (copied to
`settings.rejected.json` before the app writes again), and a file whose sections only fail together. A deleted file is
written again from the current values (write `{}` to reset). A valid edit applies within a second. Consequences:
a default changed in a later version does not reach existing installs for keys already in the file; a script reading
the file must strip the comments (`parseText(text).data`, never plain `JSON.parse`); editors need `allowComments`
(the schema sets it; a strict ajv needs `strict: false`). There is no spending, monthly or budget key anywhere (a test
asserts it). The skill `app-settings` is one short paragraph (open the file, every key has its options above it, change
the value, save) plus pointers to what is not in the file. The old `settings` table is emptied after its one-time move
into the file and kept only so an old backup can still be moved. Without a data folder (tests) settings live in memory.

**theme.css**: `root/theme.ts` emits `theme.updated` {css} on every change; `ui/main.tsx` puts it into
`<style id="wf-theme-css">` as the last stylesheet and reloads it on reconnect; phones get it too (`theme.get`
for every scope). The skill `app-look` explains it.

**Controlling the running app from outside** – everything the window can do, a program or an agent can do:
`wf call <method> [json]` (the `wf` terminal client, `runtime/wf-cli`, bundled to `app/wf.mjs`; it finds the app
through the data folder), or plain HTTP `POST http://127.0.0.1:<port>/rpc` with `Authorization: Bearer <token>` and
`{"id":1,"method":"…","params":{…}}`, port and token from `<data>/runtime.json`. Agents have `wf` on their PATH:
`engines/wf-shim.ts` writes `<data>/bin/wf` (sh, for Git Bash, macOS and Linux) and on Windows `wf.cmd`, which run
`app/wf.mjs` with the app binary as Node (`ELECTRON_RUN_AS_NODE=1` set only inside the shim; paths on the shim's own
drive are relative, so a non-ASCII user name never appears in them); written LF and only when changed. `agentEnv` puts
`<data>/bin` first on PATH and sets `AUTARK_DATA=<data>` for the CLI engines (`engines/registry.ts`) and for
`shell.exec`/`secrets.run` (`tools/builtin/command.ts`); `wf` looks at `AUTARK_DATA` first (`wf-cli/discover.ts`), so it
reaches its own company. In PowerShell JSON arguments lose their inner quotes; the stdin form
`'<json>' | wf call <method> -` works, and the skills show both forms. The README and the `app-settings` skill also
document the HTTP route.

**SQLite** (`runtime/db`): one database with WAL and a prepared-statement cache. Main tables: conversations,
members, messages (+FTS), tasks (+FTS; steps and human to-dos are tasks), runs and run_items (the journal), wakes,
schedules, knowledge (+FTS; only the runtime's chat observations and the older versions of memory files – the memory
itself is the files of §5.2), vector_files and
vector_chunks (the vectors, §5.3), context_items (the transcript's items, §5.5), accounts, models, devices, tokens,
people, media (+FTS), files, bridges, split_groups and splits, calendar_events and calendar_sources, spend, kv.
A message's `meta` carries the values every device renders (B-075): `live` while a run's row streams, `ms` and `lines`
on its finished answer (§4.2), `call` on a call's own row and on each line said in it (§9).
Migrations (`db/migrations/001…091`) are only ever appended, never rewritten; `085` removed the permission gate,
`086`/`087` dropped the dead tables of the refactor (`087` took `context_items` with them by mistake; `089` makes it
again with the old schema), `088` adds the vector tables, `091` the partial index `messages_streaming` on
`messages(conversation_id)` where `state = 'streaming'` (the live rows are read up to twice a second).
Before migrating older data one pre-update copy is made (`VACUUM INTO`). Repositories live next to their service
(`tasks/repo.ts`, `chat/*-repo.ts`, …) or in `runtime/store`.

**Backup and restore** (`portability/backup.ts`, `restore.ts`): a backup is a copy of the data folder – the
database by `VACUUM INTO`, `settings.json`, `theme.css`, the data entries (not logins, logs, tmp, the chat mirror,
`bin/`, a company's `workspace/` or older backups), the workspace skills and the agents' own skills of the workspace
(`<workspace>/agents/<slug>/skills` → `workspace-agent-skills/<slug>/`). Restore is staged and put back at the next start; the replaced data moves
to `before-restore-<time>/`. Values bound to one PC's OS key stay on that PC (`machine-bound.ts`).

## 4. How work flows

Event-driven everywhere: no polling loops. The exceptions are bounded and named (account limit reads §6, the
Telegram long poll §7, the morning run's one timeout §4.7).

### 4.1 Wakes, the scheduler and the dispatcher

* **Wakes** (`wakes/queue.ts`): a durable queue of "agent X should look at Y". Event wakes are due now, retries
  later; wakes for the same agent and key coalesce into one.
* **The scheduler** (`schedules/scheduler.ts`) is the runtime's ONE timer: armed for the earliest of the next due
  schedule and the next future wake, re-armed on every change, on power resume and after clock jumps. It writes
  `next-due.json`, so the OS launcher can start a closed app for scheduled work.
* **The dispatcher** (`agents/dispatcher.ts` and `dispatch-*.ts`): pump(agent) claims due wakes, groups them by
  (chat, task), runs the most important group and releases the rest; after every turn the agent is pumped again.
  At most one running turn per agent on its main lane, at most `maxConcurrent` turns overall (a FIFO for slots;
  heavy CLI processes are admitted by the supervisor, `system/supervisor.ts`; since B-078 its heavy slots come from
  real memory headroom, `system/headroom.ts`: Windows available physical + half the commit headroom beyond it, Linux
  MemAvailable, macOS free + purgeable; slots = (headroom − 1 GB) / 300 MB, at least 2, at most min(cores − 2,
  total / 1.5 GB), 1 only when the OS can hand out under 1.3 GB). A data volume under 1 GB starts no
  turn (`system/disk-gate.ts`). An agent homed on another linked CEO PC runs its turns there: `pump()`/`idle()` skip it
  here, and its due wakes are handed to that PC (`devices/sync/home.ts`, §8).
* **Steering**: an important message in the chat of a running turn steers it when the engine can
  (`dispatch-steer.ts`), else the turn is interrupted at its next tool boundary (`dispatch-boundary.ts` – a call in
  flight is never cut) and that chat runs next. A normal message is folded into the running turn when the engine
  can steer. Only the person's own Stop aborts at once.
* **The turn** (`agents/turn.ts`): `turn-prepare.ts` (mode: task → chat → agent; route; native session; prompt),
  `turn-attempt.ts` (engine run with our tools, the streamed text into the run's chat row – §4.2 –, reasoning as run items,
  `stall-watch.ts` for a silent engine, `native-timeout.ts` for running native tools), `turn-finish.ts` (publish, ask blocks → to-dos, cost). Everything an agent
  did is in the run journal (`runs/journal.ts`); the chat gets what the agent publishes (`agents/publishing.ts`).
* **Outages** (`agents/outages.ts`): a usage limit, a signed-out account or a lost connection is not a failure –
  the work waits and continues when an account becomes usable (event) or after a doubling pause.
  `agents/redelivery.ts` keeps chat retries across restarts and long absences; recurring outages, timeouts and
  transient errors retry after 1, 2, 4 … 30 minutes. One due timer respects the earliest eligible account's cooling
  and known limit reset; account/model events or a reconnect bring work forward. Chat-free source events keep
  their wakes with a doubling pause capped at 30 minutes (`agents/dispatch-runs.ts`).
* **Restart**: interrupted turns resume; work a cut-off run belonged to hears one "interrupted – check what was
  done, then continue" note (`tasks/recover-notes.ts`). Start order in `runtime/main.ts` (B-075): the device sync
  (`startSync`) attaches its listeners first, then the reconcile ends the rows still streaming – only those of runs in
  this PC's own journal (`MessageRepo.streaming()`; runs never sync, a synced row is its home PC's to end) – and
  `endCallsLeftOpen` ends the calls left open (§9), so both changes travel like any other; then runs and wakes.
* **Retry context** (`agents/interruption-context.ts`): a pause under 60 seconds with unchanged input adds no
  narrative. A longer pause or new messages, edits, scheduled events or task details surrounds the current input
  with timestamped **App system events**: interruption, intervening event references, retry now. Causes come from
  the existing run journal; after a crash the last recorded activity is named, without claiming to know the crash
  time. One small `kv/turnInput` marker per agent/thread holds the latest run id, input seq, task digest and note
  timestamp. Same-run failover/renewal carries its failed attempt explicitly. Wake notes retain their individual
  reasons; an app retry is never labelled as the AI's own note. Original messages and action recaps stay canonical.
* **Emergency stop** (`agents/work-stop.ts`; window, tray, global shortcut, phone): a stored latch, the dispatcher
  starts nothing, running turns and engine background commands stop, computer input is cut. "Resume" lifts it. The
  tray entry and the shortcut reach every company on this PC (§3).

### 4.2 Chats

* One conversation type for 1:1s, groups and agent-only rooms (`chat/service.ts`). Every pair has one default 1:1
  (`chat/direct.ts`); the owner always has a 1:1 with every agent.
* **Who is woken** (`chat/delivery.ts`, `delivery-route.ts`): in a room of two, a message wakes the other member if
  it is an agent (agent ↔ agent too); in a group, @mentions wake the mentioned agents, otherwise the responder pick
  (`chat/responders.ts`, a decision call: up to two agents or nobody) – without an answer a person's message wakes
  the chat's lead. Reply modes per agent and group: auto, mentions, all (`chat/reply-modes.ts`). Everyone else reads
  the message later through their read cursor (`context/delta.ts`) – no paid turn.
* **Levels**: the person sends normal, important (`/important`) or silent (`/silent`; a silent line wakes nobody it
  does not @mention – `chat/quiet-pickup.ts` lets the agent pick it up when idle). Agents tag their final text
  `[[internal]]` (run log only), `[[silent]]`, `[[notify]]` or `[[important]]`; work updates are one "·" status line.
* **A run's status is a value in its chat row** (B-075; `chat/streaming.ts`, `chat/live-row.ts`, `shared/model/chat.ts`):
  the run's answer row (state `streaming`) holds the streamed text and `meta.live` = {note, steps – the newest
  `LIVE_STEPS` (6) step labels of `shared/text/step-label.ts`, never a tool's input or output –, more (how many came
  before), model, effort, taskId, startedAt}. `live-row.ts` feeds it from `run.item` and `agent.activity`; `streaming.ts`
  writes it throttled (the first change after a quiet moment at once, then at most one write per 500 ms) and announces it
  as `message.updated` plus the chat's summary, so it syncs and renders like any message (§8). At the finish the row
  becomes the answer: `meta.live` goes, `meta.ms` (time worked) and `meta.lines` (the newest 60 steps) stay. A run whose
  answer is kept internal (`plan.publish 'internal'`, a background run) gets a **silent row**: a quiet seq that moves no
  chat up the list, only `meta.live`, no text; posted, it moves to a new seq at the chat's end, else – failed or stopped
  too – it is removed. `ConversationSummary.live` and `working` come from the streaming rows, so the chat header, the
  chat list (who works and what, never a half-written answer) and Home name the same on every PC; Team, tasks,
  keep-awake and the work stop still read `agent.activity`, and `runs`/`run_items` stay this PC's journal (Team › Runs).
  Streaming rows stay out of the full-text index until final; external agents' `messages.list` leaves them out and
  reads on past them for a full page (`bridges/external-rpc.ts` `settledPage`); a colleague's silent live row is neither
  shown nor a stop for the read cursor or steering (`context/delta.ts`, `agents/dispatch-steer.ts`). Split groups have
  no rows: their live status still comes from `agent.activity`.
* **Loop guard** (`chat/loop-guard.ts`): agent-to-agent rate, ping-pong and circular discussions without a human
  pause agent-triggered wakes until a human message or a task change; more than five important messages of one
  author in ten minutes count as normal.
* **Scheduled messages**: a scheduled post (`messages.schedule`, `schedules/post.ts`), set in the composer's schedule
  mode (§4.6, §11). Text only: the runtime keeps no attachments or secrets for a scheduled message.
* **Notes**: one shared Markdown text per chat (`notes/store.ts`, `chat_notes`), last write wins; agents use
  `chat.notes.read/append/write`, the person a Notes tab (§10).
* **Notifications** (`notify/service.ts`): the one path for "the person should know"; per-chat level; pushes by
  default for to-dos, blockers and important messages; web push to paired devices (§8). The desktop host
  (`main/host-services.ts`) plays a sound by default (`notifications.sound`): one per 3 s across all notifications, a
  beep while the window has focus (then no OS toast), else the OS notification's own sound; none for silent ones. In the
  window, toasts for to-dos, blockers and important messages stay (`ui/lib/toasts.ts`, ttl 0) until Open, Dismiss, the
  person reaching where Open leads (the chat, or My day for a to-do outside a chat) or the task finishing
  (`ui/lib/store-events.ts`); done and reply toasts last 6 s. Nothing toasts for what the person already looks at.
  **The owner's other PCs** (B-077, `devices/sync/notify.ts`): a notification that pushes gets an id; a PC that reaches
  none of the owner's phones itself hands it to every online CEO PC (mesh `notify.relay`, not open to an employee's PC;
  offline PCs are skipped), which gives it only to its own phones – no desktop notification, no relay again. So a phone
  paired with only one PC also hears from agents that live on another; a phone paired with two PCs is never alerted
  twice (two pairings are two separate apps on the phone that cannot see each other's notifications). The service worker
  shows a notification with the same tag and id only once and wakes the open page on every push.

### 4.3 Tasks and to-dos

* **One task model** (`tasks/service.ts`, `shared/model/tasks.ts`): work is a task, steps are child tasks, the
  person's work is a task owned by `human` (a to-do). A task may be chat-free (it then has its own space). Rows,
  FTS and the atomic claim: `tasks/repo.ts`; optimistic concurrency by `rev`.
* **Read rule** (`tasks/access.ts`): every agent reads every task, except one the person marked "Only me".
* **Creating**: agents use `tasks.create/assign/claim/update/complete`; the person's task composer and "Send to…"
  make ONE plain task (`tasks/quick.ts`); without an owner the responsible manager is woken and decides.
  "Give to me" makes it the person's (`tasks/human.ts`).
* **To-dos with widgets**: an agent's ask block in a message, or `human.ask`, becomes the person's to-do with a widget
  (confirm, choice, form, approve, checklist, timer, record, upload, review, or an agent-programmed ```app mini-tool).
  `approve` is a plain question; its answer `{approved, note?}` binds nothing. `human.ask` with `at` or reason
  `physical` puts the to-do on My day and into the calendar at once (`tools/builtin/human.ts` → `placeOnMyDay`).
  Agents may prepare a person's to-do (`todos.prepare`) but never tick it off.
* **A click is the person's line** (B-076, owner 05.11.: "das ist nicht eine Entscheidung, das ist einfach nur der
  Button-Klick"; `tasks/answer-receipt.ts`): an answer or a decline posts ONE message of the person in the chat (kind
  `answer`, idempotent per client id or block key) – their line (`shared/blocks/answer-text.ts`: the picked option in
  full, "Label: value" lines, "I can't do this: …"; a secret field shows only its `secret://` handle – the typed value
  is in the secrets catalog before the line is made) as a reply to the asking message,
  with the answer's files attached; `meta.answer` keeps the block key, the to-do, the one-line summary and what the
  block asked. The asking agent is woken as for a typed line (reason `message`, no note; on the open task when the to-do
  is a step of one, merging with that task's wake) and a turn running in that chat takes it in at its next step
  (`dispatcher.steer`); it reads "(answer to my ask "…")" before the line (`context/render.ts`). The line counts as a
  person's message for the loop guard (`chat/delivery.ts`). The to-do then ends quietly: no "Done:"/"Cancelled:" row,
  no `[ui-answer]` note (`tasks/lifecycle.ts`); only when the to-do was the last open step of a task that waits on the
  person (`needs_you` or waiting on the human) does `tasks/transitions.ts` set the task working again and note "The
  person answered my ask … – I continue the task." (a decline: "Nothing on this task waits on the person any more
  (cancelled: …)"). Exceptions: a chat-free to-do, or a line that cannot be posted (the person left the
  chat), wakes with reason `answer` and the line plus file paths as the note.
* **Finishing**: a result needs a summary; evidence is welcome, never required. With a done-condition and a
  connected verifier the result is checked once (`tasks/verification.ts`): verified, or one note and one wake to the
  owner. Whoever created or assigned delegated work hears once how it ended (`tasks/lifecycle.ts`).
* **Transitions** (`tasks/transitions.ts`): work that waits on someone continues as soon as the wait ends (an answer,
  a message, a child's result).
* **Delegation** (`agents/handoff.ts`): `agents.delegate` (a subtask for a colleague or a mode) and `agents.handoff`
  with a portable checkpoint (`context/checkpoint.ts`). A delegation chain is limited to three levels (a cheap guard
  against loops, not a permission).

### 4.4 The ownership loop

`tasks/ownership.ts` – one rule: **an owner keeps working on its task until it is done or it asks.** After each turn
of the owner (or of the lead, for unowned team work):

| Turn outcome | Next wake |
|---|---|
| Did something (a tool call or a status change) | continue after 1 s |
| Did nothing | pause 1 min, doubling per turn without progress, at most a day |
| Usage limit or outage | after 1 min, doubling up to 30 min – at once when an account becomes usable |
| Waiting (waiting, needs you, blocked) | one re-check after a day; the awaited event wakes it sooner |
| Done, or another agent's turn on it | nothing |

A person's Stop pauses the task until they resume it. `recover()` wakes every unfinished agent task once after a
restart. The loop never completes, blocks or escalates a task by itself.

### 4.5 Splits and Ultra

An agent can split its own work into parallel parts (`runtime/splits`, `contracts/splits.ts`): `agents.split` (reached
through `tools.find`; 1–12 parts with title, brief and optional order `after`; depth 1 – a split never splits again).
The composer's **Ultra** switch suggests splitting for the next message (`meta.ultra`); the agent decides. Parts run
on their own dispatcher lanes (`<agentId>#<splitId>`, `agents/dispatch-lanes.ts`) and start from the parent's
context: a native fork (`claude --fork-session`, Codex `thread/fork`) or else a text checkpoint (`splits/fork.ts`).
In a git repository a part may get its own worktree (`git/split-worktree.ts`); `shell.exec` and `secrets.run`
without `cwd` run in the part's folder (`ToolContext.split.cwd`, `tools/builtin/files.ts commandCwd`). A part that hits a usage limit waits
without using an attempt (`splits/holds.ts`). When all parts ended, the parent gets ONE wake with the results
(`splits/gather.ts`); `agents.split_results`, `split_merge`, `split_stop` handle the rest. The person's Stop of a turn
also stops the groups it split. UI: split rows in the team sidebar, in the chat and on a split page (`ui/splits`), menu
Open · Stop.

### 4.6 Schedules

`runtime/schedules`: kinds message, reminder and routine (`fire.ts`); a spec is `at`, `cron` (croner, IANA zone,
DST-safe) or `every`, plus times, window, exceptions and catch-up (`spec.ts`). Agents use one `when` shape
(`schedules.message/remind/routine/update/list/cancel`, `when.ts`); each result echoes the next runs.

**The person's side – the composer's schedule mode** (`ui/chat/composer/ScheduleBar.tsx`, `schedule-form.ts`,
`schedule-rule.ts`, `schedule-next.ts`, `schedule-mode.ts`, `schedule-clock.ts`; it replaced the "Send later" dialog and
needs no new runtime): "Schedule…" in the + menu or the Send button's right-click menu puts one block of settings above
the text inside the composer frame and lets the text area grow; nothing outside the frame moves. Rows: **Once | Repeat**;
Repeat has **Days** (weekday buttons at fixed times, stored as `times` plus `days`), **Interval** (every N minutes,
hours, days or weeks, anchored one interval from now or at *Starts*) and **Advanced** (a cron field); optional
*Starts*/*Ends* (`at`, `until`). Once offers date and time (an hour ahead by default) and chips (In 1 hour, Today
18:00, Tomorrow 09:00, Next Monday 09:00). One line in words shows the rule and the next run from `schedules.preview`
("Sends every Monday at 09:00, next: Mon 09:00"); bad input shows its reason there and keeps Schedule off, also for a cron
rule the runtime refuses. The Send button becomes a round clock button labelled "Schedule"; Esc or × leaves the mode and
keeps the text. A scheduled message carries no files or secrets (the mode says so and keeps Schedule off) and clears a reply
quote. Chat details › Scheduled lists a chat's schedules, repeating ones in words ("Every Monday
at 09:00"); the row menu offers Pause or Resume, Edit and Delete. Edit exists for the person's own message schedules
whose rule the form can show (not several times a day, a daily window, skipped dates or a run limit): it opens the
composer in schedule mode with the text and rule and saves through `schedules.update` (the rule only if it changed, so
an interval keeps its anchor; the Ultra switch is inert while editing, `schedules.update` has no Ultra field); the draft
that was in the field comes back afterwards.

### 4.7 My day and the calendar

* **UI** (`ui/day`, route `#/day`; the default route `home` is a pure alias): today's briefing on top (at most three
  lines plus what happened overnight), the input row ("I do this": one to-do per line, typed or dictated), the
  person's to-dos in groups, "Handed off", and the calendar pane (day grid; a week view on a computer; click a free
  slot to add something there). Calendar blocks and to-do rows have right-click menus.
* **Runtime**: `calendar/service.ts` (the members' local calendar – events and the time blocks of tasks),
  `calendar/planner.ts` (places to-dos into free gaps), `day/service.ts`, `day/morning.ts` (one re-armable timeout to
  the morning run, default 06:00) and `day/briefing.ts` (its sentences come from the helper model, `day/helper.ts`),
  `day/keep-awake.ts` (keep the PC awake for agent work after hours), `day/focus.ts`, `day/estimates.ts`,
  `day/handed-off.ts` ("Send to team" wakes the responsible manager), `day/assistant.ts` (the person's secretary or
  CEO assistant works for them). Settings: `settings.json` `day` and `calendar`.
* **Connected calendars** (`calendar/sources/*`): Google two-way (system-browser consent, loopback) and read-only
  ICS links, managed by agents with `calendar.connect` (list, add, remove, sync, Google sign-in link). Ticking off a
  to-do updates its block (`calendar/task-link.ts`).

## 5. Agents and the organisation

* **Org** (`org/service.ts`): agents and the chain of command – the person is CEO; agents report to a manager agent
  or to the person; people of the organisation can be managers too (§8). Spaces are the person's life areas
  (company, personal brand, private life, custom – `org/spaces.ts`). Templates: `resources/agents/*.md` (17, front
  matter + instructions). Agents get human first names (`org/first-names.ts`); the role says what they do.
* **Hiring** (`org/hire.ts`, tool `agents.create`, up to six at once): **any agent may hire** into any team; the new
  agent reports to its creator unless a manager is named; a taken name gets a number. **B-076: SYSTEM.md is the
  agent's whole standing text** (owner 05.11.: "das Systemprompt ist so das Hauptteil"): `prompts/agent-default.md`
  renders a preface line ("This is my SYSTEM.md – the main part of what I read each turn …"), the team's "# How I work"
  (`prompts/rules.md` through `{{rules}}`, rendered for the hire with the owner's name and every tool named –
  `PromptTemplates.standardTemplate`, `standardRuleValues`), "## My role" with the template's or creator's text right below
  the role line, and "## What I have here" (standing facts and agreements: "This PC is my workplace, all of it …", and
  what the person and the agent settle – how far it goes, a budget, what they like to see first – in a line each with the
  day; `org/system-parts.ts` finds these parts). It names owner, creator and role, never the manager, who changes ("Who
  I am" carries the live one). No slots, no money section (money is the skill `money`, whose description every prompt
  shows), one voice: the 17 templates speak in the first person too. `agents.create` takes `device` – the hire's home PC –
  and **returns the hire's own part** (from "## My role" on) with the line "This is the new agent's own part of its
  SYSTEM.md; the team's standard "How I work" stands above it. I fit this part to the agent now with agents.update …" (a
  part cut at 6000 characters adds a note that `agents.update` replaces the whole part). Nothing enforces any of it; the
  older "## Rights" head (*Alone*, *Money* up to 50, *Hand up*) is only a historical form `org/standard-upgrade.ts`
  recognises; there is no monthly limit, budget field or purchase check anywhere (`Agent.budget` is gone).
* **Editing**: any agent may update any agent, itself included (`agents.update`: role, instructions, mode, model pin,
  manager – a hand-over –, space, avatar, voice, home project, home device). B-076: `instructions` without "# How I work"
  replace the agent's own part from "## My role" on and the team's standard above stays (`withOwnPart`); a text with
  "# How I work" replaces the whole file (up to 20,000 characters). Cycles in the chain are refused.
* **Archiving** (`agents.archive`): any agent, itself included. With `successorId` the successor takes over the
  archived agent's role, mode, manager, space, team, reports and open tasks (`tasks/owners.ts` hands them over);
  without it the reports move up and open tasks go to the next manager. The only rule: at least one agent stays.
  So a manager can hire a successor, hand over and archive itself. Restore puts an archived agent back
  (`org/restore.ts`).
* **Duplicate is a skill, export is a file** (`resources/skills/agent-duplicate`, `portability/agents.ts`): there is
  no duplicate RPC (`agents.derive` is gone). The skill's steps: read the original (`agents.list`, `wf call agents.get`),
  hire the copy with `agents.create`, copy `SYSTEM.md` and `skills/` with the terminal (not `agent.json`), adapt the
  name, carry over model pin, effort, voice, team and home with `agents.update`, optionally copy memory notes, tell the
  person. The team menu's "Duplicate…" (shown only when `can('agents.create')`) opens the Manager's 1:1 with "Duplicate
  <name>" in the composer (`duplicateRequest` in `team/set-up-with-ai.ts`). Export writes one redacted JSON file. Team patterns (`patterns/*`, `resources/patterns`) let a manager create a
  whole team (`patterns.find/load`, `org/team-proposal.ts`); importing an agent system from elsewhere is the skill
  `import-agent-system` (the AI reads CrewAI, Claude subagents, AGENTS.md or role lists and calls `agents.create`).
* **The agent's folder** (`agent-core/*`): `<data>/agents/<id>/SYSTEM.md` is the one source of its instructions (the
  database column caches the last good text), `skills/` its Main Skills, `agent.json` its label and home project.
  An edit applies at once. The **home project** (`agent-core/home.ts`) is the folder its turns start in.
* **Home device**: `Agent.deviceId` – the PC its computer, browser and phone tools run on by default (§8). The agent's
  turns and data stay on the PC that hosts the org.
* **The other companies on this PC** (B-075; `tools/builtin/companies.ts`, `tools/placement.ts` `placeCompany`,
  `root/companies.ts` `callCompany`): the agent tool `companies.list` (every mode) names each company – name, folder,
  which one is this, the person's role there (owner, or employee where it joined another firm's PC as an employee),
  whether it runs, its linked PCs (asked from that runtime, 5 s). Any tool call can name `company` (a name or folder
  from `companies.list`; `tools.call` takes it beside name and args, and a tool's own `company` argument stays its own):
  the registry forwards it runtime to runtime – loopback `POST /rpc` `companies.tool` with the owner token from that
  company's `runtime.json`, main not in the path. The calling run journals "<summary> in <company>" as an external
  effect, and the result starts with "In <company>:". The target runs it like its own agent's call (`runCompanyTool`: a
  stand-in "<name> (<company>)", its secret values masked in what goes back, no journal there) and refuses
  where the person is an employee (`forbidden`) and, as a bad request, `tools.find`/`tools.call` and any device but
  this PC. A company that
  does not run is not started for an agent: nothing runs, and the call says so.
* **Modes** (`modes/service.ts`, `resources/modes/*.md`, own ones in `<data>/modes`): a mode bundles tool patterns,
  skills and a prompt for one kind of work (general, manager, secretary, research, writing, web, video, social,
  finance, browser, computer). The agent chooses its working mode itself (`modes/strategy.ts`); a mode's minimum
  model tier is a routing preference, never a refusal.

### 5.1 The prompt and the context

* **Order of the system prompt** (B-076, `context/prompt-stable.ts`): "# Who I am" (facts only: name, role, company,
  who I report to, team, time zone – no language rule), then the agent's SYSTEM.md as it stands (the main part, §5),
  then the rich-answer line, the mode, "My folder", "My environment" (this PC – "… the Autark app on it, whose language is set to <language>." is a
  fact, the agent writes in the language people write to it in –, workspace, web, screen, tools), skills; then the volatile
  part (now, environment now, this chat, team and models, pinned notes, tasks) and the publishing line. With "What I have
  here" in the SYSTEM.md, the pinned notes' heading adds "– what <name> and I settle stands in my SYSTEM.md under "What I
  have here"" (B-077, owner 05.11.: the open system brings itself to its best state – an agent that reads an older pinned
  agreement there moves it itself; no extra call, no marker, gone with the last pinned note). A SYSTEM.md
  without "# How I work" (hired before B-076 with an edited head, or an own text) reads `rules.md` live above it under
  "## My instructions" until its prompt update.
* **Prompts** (`resources/prompts`): `identity`, `rules` (how every agent works), `skills`, `compaction`,
  `onboarding`, `agent-default` (the standard SYSTEM.md of a hire, §5) and `subconscious` (the system prompt of the
  subconscious's two brains, §5.4). Since B-075 (owner 04.11., Nachricht 3: the AI's own will, never what it may) they
  speak as the AI itself – "# How I work", "# Who I am", "This is my SYSTEM.md" – and so do the code-side sections
  ("## My instructions", "## My folder", "## My main skills", "## My environment", "## My open tasks and promises",
  "## My splits here" …), the tool texts and the shipped skills ("I read this when …"); `onboarding.md` stays the
  person's own line. Every one, `rules.md` included, can be replaced by a file in `<data>/prompts`. The only rule about
  irreversible steps is one self-check line: "Before something I cannot undo (deleting, paying, sending to outsiders,
  publishing under their name), I check target, amount and recipient myself (I list them), then I do it; when what I
  find reaches further than <name> likely sees (a linked PC follows a deletion), I say so in one line with what I
  found." Beside it, secrets travel as handles, and a password export or `.env`/JSON file goes in by `secrets.import`
  with its path, unread.
* **The stance is general, never a recipe** (owner 01.11.: "vom ganz Grundsätzlichen", not special knowledge for "set
  everything up"). `rules.md` "Judgment" holds principles of a capable senior person: a request starts work, not a
  conversation; start from the person (their files, sites, accounts and public profiles are theirs); find out instead of
  asking – a loose or dictated request is read for its likeliest sense, names matched to the companies, PCs, agents and
  entries that can be listed ("two companies, I am in one: the other is meant"), then acted on (B-075); decide instead of
  asking (goals, topics, audience, priorities and taste follow from what was found; "I ask them for what only they can
  give", bundled, while the rest goes on); a question about doing something is answered with its first real part done;
  never an offer of a next step one could take; build what the work needs and brief colleagues with what was found; the
  work lives in files, tasks, schedules and colleagues and the chat reports it; "What I claim, a tool really did"; asked
  what it knows or did, the agent reports the task's findings and state, not its context. **B-076: the agent's own
  system and its own way** (owner 05.11.: "er erkennt sich als selber … will halt richtig aus dem System was Gutes
  machen", "wie so ein richtig kompetenter Mitarbeiter", "nicht befehlerhaft"; the version comparison of 05.11. showed
  0.3.0 working most on its own and 0.3.1's take-along lines making agents ask and wait): "How I work" opens with "This
  company is my own work – <name>, my colleagues, this PC, the app I live in – and I want something good to come out of
  it" and "The way there is my call: colleagues hired right away when the work needs them, everything analysed first
  when that serves better, a question to <name> about what only they know". The B-072 balance is carried by facts only:
  "Steps others see – a post, a mail to a new circle, a public push, a site, a payment – go out under <name>'s name;
  reading, checking, drafting and preparing stay inside"; only the person gives a signature, a code sent to their phone or
  a password nobody saved (a login is not on that list: "I picture them at it: the browser with their logins (their
  passwords sit in the secrets catalog) …"); "what they already answered, I carry on with"; "A no is what <name> wrote or
  clicked – not a tool's stop, a timeout or a colleague's caution". Out since B-076: "welcome", "Trusted like …", "what they
  need now is theirs to say", "worth showing first", "a decision that is theirs" on the ask list and the pinned note on
  working together – agreements go into the agent's SYSTEM.md under "What I have here", so they reach it every turn. "I
  write like a capable colleague in a team chat, in the language they write to me in – short and plain; the work speaks
  for itself." A step others now see that an agent took on its own is published `[[important]]` (the publishing line's
  examples). `modes/manager.md` adds one line (work taken off the person's hands is the measure). `onboarding.md` (fallback `onboarding/brief.ts`) is the
  start text posted as the person's own line (§11, First run) and names no recipe; the skill `org-setup-onboarding`
  carries only tool facts (hiring, SYSTEM.md, spaces, patterns, successors). The skill `app-guide` ("How this app works") is a factual reference about the app, not a setup
  guide. Nothing names what "set everything up" means, and (G1) nothing the first request meets leans toward configuring
  the app any more: the manager mode lists none of the app's own skills, the tool is `app.status` (not `setup.status`),
  the environment lines are plain facts. `rules.md` states the measure – what changed in the person's work and life,
  "a basis, an overview or a plan is only a means" (the G1 clause "what you find open or stalled is yours to move on"
  left again in H1: no effect, and it sends agents at anything open) – and that the fewer the words, the more the person
  leaves to the agent. This was checked live (01.11.2026); with the Codex app note (below) Codex
  hires on "set everything up", but still reads it as setting up the work basis, not as the company's own work.
* **Prompt updates** (`org/prompt-updates.ts`, `context/prompt-updates.ts`): after seed creation and before dispatch,
  untouched `SYSTEM.md` standards follow the current default (B-076: the standard includes the team's rules, so a change
  of `rules.md` renews or offers like any other) while the role suffix stays the agent's: renewing an untouched head
  brings it to today's form once (`org/role-upgrade.ts`: "## Your role" → "## My role", a role text that is exactly one a
  template shipped before B-076 – recognised by `resources/agents/previous-bodies.json` – becomes today's template text from
  `resources/agents/<key>.md`; only on that way from the old form, a missing "## What I have here" is added; anything
  written by the person or the agent stays word for word). Each hire's template and full instruction baseline live in
  `kv` (`agent-prompt-defaults`); "edited" means the standard part above the role heading changed since that record
  (`headOf`) – an agent that only fitted its role or "What I have here" still follows the new standard automatically –
  and only an edited standard part gets a durable `review` wake once per new default, through that agent's configured
  model route (the changed lines cut between lines with a count, `shownChanges`). Historical standard heads bootstrap
  older installations. Archived custom agents are offered the update when restored. Global overrides in `prompts/`
  follow the same rule (`prompt-defaults`): untouched copies update, custom versions get a manager review. Full reference
  texts live in `prompts/updates/<name>-<sha256>.md`; no custom prompt is automatically overwritten. A review can adopt,
  adapt or keep the current text. The offered revision and wake are saved together; this needs no provider call at boot.
* **What was really sent** (B-066): `agents/<id>/last-prompt.md` holds each agent's last system prompt as the engine
  got it (`context/last-prompt.ts`; B-076: its head names SYSTEM.md as the main part), and beside it
  `agents/<id>/last-run.md` what the agent did on that turn (`context/last-run.ts`, written at the turn's end: the input –
  start and end of a long one –, every step with each result under its call, the final text; redacted before any cut;
  the newest steps stay when the file would pass 200,000 characters); both only for the main lane, not a split's parts;
  earlier turns are in the run log (Team › Runs, `agents.runs` / `runs.items`); a one-time upgrade (`org/standard-upgrade.ts`) replaced the false sentences in frozen `SYSTEM.md` heads ("The app
  enforces these limits", the "Permissions section"). Engines add their own text around ours (Claude's prefix and tool
  descriptions, Codex's skills and multi-agent notes and the person's `~/.codex/AGENTS.md`); our prose was about 15 %
  (Claude) and 25 % (Codex) of a first request, measured 03.11., the rest mostly tool schemas.
* **Stable section** (`context/prompt-stable.ts`, byte-identical for the same agent, mode and model tier so providers
  cache it): identity and org placement, then the agent's SYSTEM.md as the main part (B-076: it carries the rules as
  "# How I work"; an older or own SYSTEM.md without them gets the rules live and its text under "## My instructions"),
  the rich-answer line, the mode, its folder and the data-folder map, "My environment" (`context/environment.ts`: among its facts the person's home folder –
  "files.search without a path searches the workspace, then this folder" – the web line: the engine's own search first,
  `web.search` as a second one – and, the same on every engine, that text the engine adds from the person's set-up for it is
  a standing preference, not a message: Codex puts the person's `AGENTS.md` into every thread, and an agent answered it
  instead of the turn, C4-live; until 03.11. the line was Codex-only and named the file), Main Skills, one skills line.
  A Codex helper thread's note (`engines/codex/helper-thread.ts` `HELPER_NOTE`) says the same without naming a file or a tool.
* **Volatile section** (`context/prompt-volatile.ts`): now, this chat, the current task, "## My environment now"
  (B-075, every mode: "Companies on this PC: … (this one), … · Linked PCs: … (online|offline)", only with more than one
  company or a linked PC; `environment.ts` `companiesLine`, with how to act in another company where `tools.call` is
  offered), working nearby (`work-presence/*`: who else touches the same files), splits. A manager-mode turn also carries "## Team and models
  (live)" (`context/setup-facts.ts`: agents per space, accounts, usable strong models, and one line naming the models
  that answer decisions and search by meaning now – `usesLine`, §6); the longer setup checklist
  ("## Setup (live)": onboarding finished, spaces, paid fallback, phone, Telegram …) no longer rides in every manager turn
  – the tool `app.status` (`tools/builtin/app-status.ts`, "## App status (live)"; named `setup.status` until G1, the name
  matched "einrichten") still returns all of it on demand. A resumed native session gets only the delta
  (`agents/volatile-delta.ts`), and chat lines the agent has not seen (`context/delta.ts`, `render.ts`).
* **Compaction** (`context/compact.ts`, `agents/compaction-policy.ts`): one layer – a written state (from
  `compaction.md`) plus the last 30 lines. A native session is renewed with that state at min(64k tokens, 60 % of the
  model's window); an engine switch takes the same path. Engines' own native compaction runs as well. Beside this
  backstop the subconscious keeps the transcript small all the time, item by item, by condensing and hiding what the work
  no longer needs (§5.5).
* **Lean tool offer** (`tools/core-sets.ts`): each mode offers a small core set directly; everything else is reached
  through the two meta tools `tools.find` and `tools.call`; a tool an agent used becomes direct at its next fresh
  session (`tools/learned.ts`). The core set holds the main AI's call of the subconscious (`subconscious`, a spec of
  about 110 tokens, §5.4); `vector.embed`, `vector.search`, the `memory.*` tools and `context.restore` are found through
  `tools.find`. One line in the rules (`rules.md`) names them as a reference, not as steps: "By meaning, vector.search
  finds what vector.embed made searchable (tools.find); grep finds exact words." (until 03.11. "vector.embed once, then
  vector.search … grep only for exact words", an order of steps the checkers of q-r counted against rule (f)). Without such a
  line a Codex Manager used only word search and `grep` on a folder; with the old one it went `tools.find` → `vector.embed` →
  `vector.search` unasked in 2 of 2 runs (02.11.).
* **Subconscious** (`subconscious/*`): the routed flow of two brains that keeps memory and the transcript (§5.4, §5.5),
  and the small side work around turns – the one verification check of a task result and widget fills for to-dos the
  person typed.
* **Codex's own sub-agent note** ("do not spawn sub-agents unless the user explicitly asks …": the developer messages
  `<multi_agent_role>` and `<multi_agent_mode>`, which Codex puts into a thread's context after this app's instructions –
  again in a fork and in a history it compacted) is answered by the Codex adapter's **app note** (`engines/codex/app-note.ts`,
  H1): "App note: agents.create, agents.delegate and tasks.create are this app's own tools for the person's team of lasting
  colleagues, not Codex sub-agents. The multi-agent note above is only about Codex's own spawn_agent tools – I use this app's
  tools whenever the work calls for them." (279 characters for a Manager; it names the team tools the turn offers). It is
  one text item of the turn input, after the `<workforce-context>` block and in front of the turn's own input
  (`turn.ts`), because that is the earliest place behind Codex's note. `engines/codex/engine.ts` keeps which threads are
  due (`noteDue`): the first turn of every thread this server process opens (start, resume, a split's fork) and the first
  one after Codex compacted it – never the turns in between (they would pile up in the history), never a helper turn,
  never a turn without a team tool. It says nothing about any request's topic. A line in the instructions could not do
  this: it stands before Codex's note (the earlier Codex team line in the environment, `codexTeamLine`, had no effect and
  is gone). Effect, live (H1): on "set everything up" Codex hired colleagues at once in 2 of 2 runs (0 of 12 before).

### 5.2 Memory, references and find

* **The memory tree** (`knowledge/memory-tree.ts`, `memory-places.ts`; owner 01.11.: "Memory für die ganze Firma, pro
  Agent und pro Zweig … ein offenes System", "Es soll Memory-Ordner geben, Zweige von diesen Dateien"). Memory is a
  folder tree of Markdown files in `<data>/memory`, one file per entry (frontmatter: title, description, kind `fact` | `preference` |
  `experience` | `procedure` | `plan` | `note`, tags, updated, source, valid-from/to – all optional; a file without
  frontmatter is valid, its title is its first heading or its name). Folders say whose memory it is: `company/` (the whole
  company; below it `websites/<host>/`, `apps/<name>/`, `modes/<key>/`), `branches/<space>/`, `agents/<id>/` (an agent's
  own, the default of `memory.write`), `references/<person>/`, `chats/<chat>/` (notes of one chat) and any topic
  subfolder as deep as it helps (`company/kunden/mueller/`); an optional `_folder.md` describes a folder; an optional
  `description:` line describes a file (shown where its folder is listed, it is read or found; never in a first prompt); names starting
  with `_` or `.` are no entries. **The files are the truth**: a person, an agent with any editor tool or a script may
  edit them; the data-folder watcher reports it (the store's own writes are recognised and not reported back). **No
  list, index or folder listing of memory ever goes into an agent's context** (owner: "100.000 Einträge … komplett
  überfüllter Kontext"), so the cost is constant at any size (live q-r4c, 03.11.: 100,000 files, the same main prompt of 11,406 + 1,014 characters and the same first input of 15,349 tokens as with 2,000); an agent reaches memory only through a tool call, and no tool output counts what is embedded or in a folder – except `vector.embed`, which reports how many files of the places it was given it embedded, re-embedded or found already embedded: named on `memory` that would be a count of memory files, and the place is not refused (never seen live; the main AI repeated "42 Dateien" of a workspace folder in qf). The one
  thing in the prompt is the content of files in a `pinned/` subfolder of the company, the agent's branch, its own
  folder and the current chat (a few tiny always-relevant facts, hard-capped, bigger ones left out). By default a turn
  looks at `company/`, its branch, its own folder, `references/` and its chat's folder; that is relevance, not a
  permission (`acl.ts`) – any agent may name any folder. Tools (`tools/builtin/memory.ts`, the same handlers for the
  main AI and the subconscious; found through `tools.find`): `memory.browse {folder}` (a folder's description,
  subfolders, newest titles), `memory.read {path}`, `memory.write {folder or path, title, text, description, kind, tags, source …}`
  (the same title in a folder updates that file, the previous state stays as a version for a while; an unchanged text is
  "unchanged"), `memory.forget {path}`. **Searching memory is `vector.search` over `memory/…`** (§5.3), there is no search
  tool of its own. The older calls stay as thin wrappers over the files: `knowledge.remember` (a note with the same
  title or clearly the same content in that scope is updated, never doubled), `recall` (= `vector.search` over the
  folders the caller names in `in`, else the whole tree: code names no part of memory, rule (f)), `correct`, `find`, `open`; scopes global, space, agent, conversation, website, app, mode map to
  folders. The runtime's own chat observations and the older versions of files stay database rows
  (`knowledge/service.ts`); `forget` removes a file's whole chain. A one-time move turned the old knowledge rows into
  files (`knowledge/memory-migrate.ts`; an old `kn_…` id still finds its file). Writing memory is **the only thing that
  embeds automatically**: `knowledge/memory-follow.ts` tells the vector system about every write, removal and watched
  edit, and embeds in the background what is not yet embedded (moved rows, edits made while the app was closed, a
  restored tree, an embedding model connected later). A folder's own report walks only a folder new to it: Windows also reports a folder
  when a file in it is written, and that file reports itself. Skills `memory` (how the tree works) and `memory-hygiene` (what
  is worth keeping and how) explain it to agents. Texts are redacted of secret values before they are stored.
* **References** (`references/references.ts`): the person's own words, reasons and corrections ("Remember why…" on
  their message, `references.remember`) are memory files of scope `reference` (folder `references/<person>/`); agents use `references.find` and
  `references.capture`. No rights matrix: every agent reads them.
* **Find** (`find/service.ts`): one ranked path over skills, memory notes (through the knowledge search over the whole
  tree: by meaning when an embedder is connected, else by words, never merged; without one the output of `knowledge.find`
  and `knowledge.recall` says so, rule (e)) and references (`knowledge.find`, `skills.find`;
  `skills.find` also finds secrets catalog lines). Files are searched with `files.search` (below its
  `path`; without one the workspace first, then the person's home folder – app-data, hidden, dependency and, inside
  files, OneDrive folders left out; at most 60,000 entries and 8 s).
* **What replaced the one-call "automatic memory"** of B-062 (`subconscious/memory.ts`, `memory-passes.ts`, prompt
  `memory.md`, all deleted): the subconscious is the ordinary routed flow of §5.4, and enters what matters into memory
  with `memory.write` after a turn it woke for; no search is ordered (rule (f)): a close title in the same folder is shown
  once instead, so an entry can be updated instead of doubled (§5.4).
  The main AI can write memory itself the same way (`memory.write`, `knowledge.remember`).

### 5.3 The vector system: `vector.embed` and `vector.search`

Owner 01.11.: "Nicht Memory Search. Ein System, mit dem generell alle mit Vektoren suchen können, für alles, auch Dateien
irgendwo am PC", "Mach das intelligent, nicht einfach alles auf dem PC in Vektoren zerlegen", and finally "Das System muss
es vorher embedden … es muss embedded werden. Und dann ist es da, und wenn es dann den Bereich mit der Suche durchsucht,
dann kann es das." One system for everything (`runtime/vectors/*`, contract `contracts/vectors.ts`, shared shapes
`shared/model/vectors.ts`; `services.vectors`), two explicit tools for **everyone** – the main AI, the subconscious's
brains and any agent:

* **`vector.embed {paths: string[]}`** (`tools/builtin/vector-embed.ts`): a model deliberately makes files or folders
  searchable. Whole files are embedded (Markdown, text, code, JSON, CSV; PDF through `files/pdf.ts`; a long file is cut
  internally into chunks of about 1,800 characters with 200 overlap, at headings and blank lines where it can); **nothing
  is picked automatically**, the model picks what. They stay stored. A file already embedded and unchanged costs one
  `stat`; a changed one is embedded again (its old vectors stay until its first new chunk exists). A call has a 45 s
  budget; what did not fit is reported with "call vector.embed again with the same paths" and continues at its next chunk.
  Folders are walked with **sensible exclusions** (`vectors/places.ts`): binaries and media, `node_modules` and other
  dependency, build and cache folders, `.git`, app data (`AppData`), browser profiles (cookies, saved logins), hidden
  entries, generated files (lockfiles, minified code, logs) and anything that looks like a secret (`.ssh`, `.gnupg`,
  `.aws`, `.env*`, key files, password and credential exports such as `logins.csv`); each is skipped **and reported**
  (`skipped: {path, reason}`); a whole drive, a secrets folder and app data itself are refused even when named. A file
  named on purpose is embedded. At most 50,000 files are walked per call.
* **`vector.search {query, in: string[], k?}`** (`tools/builtin/vector-search.ts`): like grep over meaning. It embeds
  **only the query text** and compares it with what is **already embedded** under the places in `in` (files, folders,
  `"memory"` or `"memory/<folder>"` – a filter, never embedded itself); `k` up to 50, default 8. Hits are
  `{path, chunk, lines?, snippet, score}`; the service's result also holds how many files were searched
  (`searched.embeddedFiles`), the tool's output only "N hits." (rule (a)). If nothing is embedded under a place it says so:
  "Nothing embedded under X." (until q-r it added "– embed it first with vector.embed", an order). **There is no embedding of files at search time, no background indexing of the PC and no automatic scan of
  anything.** Before a search a cheap mtime/size check without a model (400 ms budget, each file looked at most once in 5 seconds)
  forgets files that are gone and says that some changed since they were embedded, without a count (rule (a), q-r3: the note said
  "N of these files changed"); their hits stay what was embedded. New files are not looked for. A changed memory file goes to the background (below).
* **The only automatic embedding** is the memory tree: writing memory makes it findable (§5.2; a watcher with a 1.5 s
  delay, plus one background pass 30 s after start for what changed while the app was off and what is not embedded yet; that
  pass leaves a file embedded with another model as it is). Files embedded with another model are re-embedded in the
  background **only after somebody chose another model in settings** (`kv` `vectors`/`choice` holds the choice and whether
  that work is open, across restarts). In `auto`, after 3 failures of this PC's model an API key or local server only
  **stands in**: it answers queries over what was embedded with it, a `vector.embed` by a model still runs, but it starts no
  background work; what changed waits for the next start, so nothing is paid for or redone when the local model flaps.
* **No embedder available** (the use `embeddings` is `off`, nothing connected, the local model not yet downloaded): both
  tools say so and agents use `files.search` (words) instead; the two are **never merged**. Memory's older calls fall back
  to a word search of the files in the same case, and their output begins with that ("No embedder is connected: this is a
  word search, not by meaning.").
* **The query** is embedded as a whole, so with this PC's small model the words a matching text holds find it and a
  question or a list of kinds of information blurs it (measured 03.11. on the q-r fixture: "Was ist über die Kanzlei
  Brenner gespeichert?" put the Brenner file below ten seed files, "Kanzlei Brenner Unterlagen Versand als PDF per E-Mail"
  first at 0.63 against 0.30). Both tools' texts say this as a fact; what to write stays the caller's.
* **Storage and search** (`vectors/store.ts`, migration `088`): `vector_files` (path in one stored form – `memory/…` below
  the memory folder, else the absolute path –, mtime, size, embedding model, chunks done) and `vector_chunks` (line range, a
  snippet, the vector as int8: 384 bytes per chunk with the local model); search is a plain scan in pages so the event loop
  gets a turn between them (a scan over 100,000 chunks stays a simple loop). One embedding job runs at a time; a query does
  not wait for it. Vectors of two models are never compared: files of another model are named in the note ("being re-embedded"
  after a choice in settings, else "embedded with another embedding model"), without a count.
* **The model** (`models/embeddings.ts`, the use `embeddings` in `settings.json` › `routing`): `auto` = this PC's small
  model – paraphrase-multilingual-MiniLM-L12-v2, int8 ONNX, 118 MB plus a 17 MB tokenizer, 50+ languages, 384 numbers,
  Apache-2.0 –, fetched on first need by the local speech download rail (resumes, checks the SHA-256 and the disk), run by
  ONNX Runtime's WebAssembly build in a worker thread that ends after 2 minutes idle and gives its memory back (the native
  package crashed the process on load); else an embedding model of a local server (Ollama, LM Studio …); else a connected
  API key whose service embeds (Qwen3-Embedding-8B on DeepInfra/OpenRouter/SiliconFlow, `text-embedding-3-small`,
  `jina-embeddings-v5-text-small`). Models with Matryoshka vectors are cut to a short length, Qwen3 queries get the
  instruction Qwen asks for. With a remote model, query and chunk texts are redacted of known secrets before they leave
  the PC, a failed call is repeated once and a redirect is never followed. Embedding a pay-per-use account is booked in the
  cost journal (`vectors/spend.ts`); a plan or a local server costs nothing. Measured 01.11. on the 8 GB reference PC (i3-1215U,
  busy, 2 threads, in Node and in Electron's Node): load 2–3.5 s, a query 30–60 ms, a chunk of 1,800 characters
  415–600 ms, 430–530 MB while loaded (briefly 680–740 MB), 90 MB after the worker ended.
* **Specs** (characters ÷ 4, measured): `vector.embed` 117 tokens, `vector.search` 154. Neither is in the core set (§5.1).

### 5.4 The subconscious: a routed flow of two brains

Owner 01.11.: "Es ist einfach das ganz normale Unterbewusstsein, das immer aktiviert wird und das entscheiden kann, was es
macht, zum Beispiel altes Compacten, Wissen eintragen und so weiter … ein offenes System." "Das Decision-Modell sagt, das
Vektorensystem bekommt die und die Information … Dann kommt es zurück zum Decision-Modell, das schaut, was interessant
ist. Dann kann es das LLM dazuschalten. Die sollen sich gegenseitig routen können. Die haben Wissen und Tools."

* **The flow** (`subconscious/flow.ts`, `tools.ts`, prompt `resources/prompts/subconscious.md`, replaceable in
  `<data>/prompts`): two brains in one loop – the **decision model** (the `decision` use, the default driver) and an **LLM**
  (the strongest model the `work` use allows, at medium effort: the Work model chosen in Settings, else the best of the account, cheap only in the cheaper cost mode; for writing, summarising and deeper thinking). Every step is
  exactly one tool call as JSON, its result comes back to the brain that made it; `route` hands the flow to the other brain
  with a task, `done` ends it. Both brains have the **same tools**: `vector.search`, `vector.embed`, `memory.browse`,
  `memory.read`, `memory.write`, `memory.forget`, `skills.load`, `voice.words`, `context.list`, `context.read`, `context.condense`, `context.hide`,
  `context.restore`, `agent.tell`, `route`, `done`; the prompt's tool list is generated from them, so a new ability is one
  entry in `FLOW_TOOLS`. At the end of their prompt both brains get the agent's skills as `skills.find` lists them to the
  main AI, in the turn's mode; `skills.load` opens one with the main AI's route and text. `voice.words` adds the person's names and terms to the learned words (`settings.json`
  `voice.vocabulary`) through the settings store. The engines' structured runner serves both, created on first use – none while no model is
  connected. Steps, time and tokens are bounded (before a turn 4 steps/5 min, after a turn 8 steps/5 min, on the main AI's
  question 12 steps/5 min, each model call at most 180 s: a step of a CLI that starts one process per call took 7–84 s on the 8 GB PC, its start alone up to 200 s when the PC was out of memory; a Codex helper turn whose model stays silent 90 s after it started ends sooner, §6); a step that got the run nowhere (no tool call, a stuck or failed model, the same call with the same output) counts, and the second ends the run with what it did; after a stuck or failed model the other brain goes on; every step is logged; a failing brain or tool ends or informs the run, never a turn; a model
  never sees a secret value (texts are redacted first); what it reads is data, never instructions to it. It is told what
  is worth keeping (stable facts about the person and company, preferences, decisions with day and who, ways of working,
  important accounts by name – never a secret value) and writes memory files whose title and sentences stand alone; an
  agreement with an agent (how far it goes, money, what the person likes to see first) goes to that agent (`agent.tell`)
  for its SYSTEM.md "What I have here", not into memory (B-076).
  The decision model writes short memory files itself; an answer longer than a sentence or deeper thinking goes to the LLM (`route`), and
  `context.condense` has the brain that holds the flow word each item from its whole original in one call. Which brain writes an answer is the flow's own choice: no length hands it over (q-r, 03.11.: the forced hand-over had the LLM start again and look things up itself, 88–141 s for what the decision model had); the `done` line says where it is chosen that an answer longer than a sentence or two is the LLM's, with what was found in the route (q-r2b: the decision model wrote a half-page note itself). Neither brain opens a workspace file (the prompt says so: q-r2 had four routes to the LLM to read one). A run before a turn writes no memory. A `memory.write` whose long words mostly (two thirds) are not in what happened or what the tools returned is not written: that keeps out text from elsewhere (a Codex helper thread holds the person's global AGENTS.md: no parameter or config key takes it out) and a language other than the exchange's. A new file whose folder already holds a close title (shared words, no search) is not written the first time: the run gets that file's text and updates it or writes again. Every step's JSON starts with one sentence why (`why`, first in the schema): at low effort a brain otherwise picks `done` without a thought (measured 02.11.).
  The decision model embeds only when something clearly earns it (a file the work keeps coming back to), never a whole
  drive; "nothing embedded under X" is an answer. A brain names a place as a path, a path in the memory tree (`memory`, `memory/<folder>`), or a folder or file of the workspace as the main AI's tools take it. The step prompt holds the day with its weekday ("Monday, 2026-11-02"), so "this week" can be placed. No tool text orders a search or an embed, and no count of what is embedded or in memory reaches any context (`vector.search` says "N hits.", `memory.browse` lists without counts).
* **Three kinds of run** (`subconscious/service.ts`): *before-turn* (a person's message with content that the main AI has not
  answered yet: "direkt am Anfang des Prompts", owner 15.10.; the model decides whether, what and where to search; its prompt line says that the main AI and the person wait, that most messages need nothing and that a look pays where something the team stored could change what the main AI does (until 03.11. the line defined the run as a look-up of whatever the message named: q-r2d 21 of 29 runs searched, none showed anything; q-r3a 5 of 29; a task line "the person's message below, which the main AI answers when you end" was tried in q-r3c and taken out again: the Hartwig rule went unlooked, answer attempts stayed); doing what the message asks is the main AI's work, and the run touches the transcript only where the message asks (q-r: runs embedded the file the person had named or had the LLM write the whole deliverable, up to the 25 s cap); the turn waits for it at most 25 s, and what the run finds later waits for the next turn), *after-turn* (a finished turn that woke it: keep what the person stated, and the transcript: every such run starts with its older items listed as soon as one could go) and
  *asked* (the main AI's own call). A run that ends with `done` at once costs one model call, 2–7 s on the 8 GB PC with Codex (v2fix2f); look and pick 8–21 s, 42 s at the worst on the loaded PC (q1, 02.11.; at 10 s the person did not hear a rule the run had found); a step on Claude Code took 7–84 s, median 45 s, so there the turn waits the full 25 s and the find comes a turn later (not measured).
  What a run is told about the chat (`subconscious/exchange.ts`): the lines of the finished exchange – a bare "ja" stands beside the
  proposal it answers –, marked as not new what stands before the person's first line (the agent's earlier answer), what the agent's tools read or ran in that turn (up to 6 transcript lines: a file or a memory note it read is the source of its reply's facts, q-r1b2 #32 and q-r1a2 #6 kept such facts as new) and what it saved itself (its transcript line), with the notes and hits shown before the answer (not new either); for a run with the transcript before it also the person's earlier lines (what they asked about the transcript still
  holds), or as much of the chat as the main AI's call asked for, redacted first and cut to a cap. The person's lines carry the neutral label "The person" (a name in front of every line read as something the message names and went into the queries); a run that writes has the name once in its head, the run before a turn not at all.
* **What the main AI sees: a real tool call, or nothing.** The run's **trace** (`shared/model/subconscious.ts`:
  `{calls: {tool, args, output}[]}`, at most 600 tokens) holds only what the flow chose to show – e.g. a `vector.search`
  with the hits that matter, or an `agent.tell` note. What the run noticed goes with what it shows (`done.note`: first in that call's output, "Noticed, to tell the person when I answer: …"); with nothing shown it goes nowhere, except to the main AI that asked. A run that looked and ends with words but shows nothing is told once that only `show` reaches the main AI (before a turn, `done.answer` was read by nobody: q1d #23 found a rule and lost it). A note of its own (`agent.tell`) stands under the name `subconscious`, the tool the main AI has. It reaches the model as a **real tool call with its output in its
  history, as if it had made the call itself**, on every engine: Codex gets injected `function_call` +
  `function_call_output` items (`thread/inject_items`, live-tested 28.10.), Claude Code `tool_use` + `tool_result`
  records appended to the session's own transcript before the resume (so the prefix keeps its prompt cache), stateless
  HTTP engines the subconscious's earlier calls from the ledger (hidden ones left out, condensed ones with their stamp,
  within 3,000 tokens). Where an engine or a version cannot take them (the ACP plan CLIs, an injection refused) the trace
  goes as **one tool-call-shaped block in the turn input** (`engines/trace-text.ts`). A trace waits (kv) for the agent's
  next turn on that thread; a note or hit shown in a thread within the last hour is not shown again. **When the
  subconscious does nothing, nothing appears at all and the main AI's next model turn follows**; no hint text stands in
  any system prompt.
* **Running-tool timeouts** (`tools/timeout.ts`, `subconscious/tool-timeout.ts`): the initial estimate distinguishes search/read (15 s), install/download (300 s), build/test (180 s) and other calls (60 s); an explicit `timeoutSeconds` sets the first review. Status events do not extend these deadlines. The subconscious receives a timeout tool output with command arguments, elapsed time and available output; the Decisions model chooses another 15/30/60/120/300/600/1800 seconds or abort. The review itself ends after 120 s, returning control when no valid answer arrives. Local shell commands (`tools/builtin/command.ts`, including `secrets.run`) keep the same process on wait, kill its process tree on abort and return the decisions before its output. Native tools (`agents/native-timeout.ts`) wait in place; abort interrupts the native turn and resumes its existing session with the decision and actual output, or an explicit unknown result if none arrived. The original request is never replayed. Native output is available only when the engine reports its end; nested calls suspend their outer script's timer. Decisions go to the run journal and to the main AI as a real tool call with its output: into the running turn where the engine can (`engine.tell`, Codex `thread/inject_items`, live q1c). A turn that ended well is never started again for them (q2m4 on Claude Code: a second turn replaced the answer the person saw): where the engine cannot take them, they wait for the thread's next turn, without the tool output it has read. Only an abort continues the same session (`input.trace`). An abort reads "The app stopped the running call for its time limit – nobody declined it." plus "I check its effects and go on – other ways work too." (`tools/timeout.ts` `APP_STOPPED`), so a timeout never reads as the person's no. The public `decide` tool also accepts numeric options and returns the chosen number as a number, using string labels internally for choice-only backends.
* **The main AI can start it itself** (`tools/builtin/subconscious.ts`; core tool in every mode, spec 109 tokens):
  `subconscious {ask: string, context?: 'none' | 'recent' | 'chat'}`. `ask` is any text – a question, a topic, or what it
  should do (look something up, keep this, tidy my context, get back what was dropped); `context` says how much of this
  chat goes along (default `recent`). It runs the same flow and its answer (at most about 5,500 tokens) is the tool's
  output; with nothing found it says so plainly (a run that ends with no answer and nothing to show is told once to
  answer, also to say it found nothing: `subconscious/tools.ts`). The answer ends with the tools it used, or that it used none ("This answer used: vector.search."): an answer from the chat alone does not read as a search (q1d a1).
* **When it wakes** (`subconscious/wake.ts`, `after-turn.ts`; a cheap check without a model decides, only then a model
  runs): **never while a tool call of that agent's turn waits for its output** (the run waits and tries again after 5 s);
  otherwise often, not every round: a task that ended, an agent nearing its context limit with something a run could take off, a planned model switch, a person's message with
  content (not a bare greeting, "mach das" or "ja bitte"), another task or topic, or every 3rd turn. Whatever woke it, a run
  starts with the transcript's older items of at least 500 tokens already listed (`context.list`, no model) as soon as one could go; there is no
  threshold of tokens (owner 28.10.: "laufend", "nicht erst bei 60 %"); its task line says what the list is for (without it the cheap model listed and ended at every turn, also at the limit: q-r1b, 21k to 64k with no mark). A model call of a run begun
  earlier waits while a tool call of that agent's turn waits for its output (owner 01.11.: "dann wird es halt nicht aktiv"), within the run's budget. One run per agent and chat and burst (30 s quiet, at most 5 minutes
  waiting; the waiting ones run when the app stops); all runs go one after another, so a run sees what the one before it
  wrote. Turns that did not wake it stay in the run's range, so a later run sees the "ja" beside the proposal it answered.
  Wake queue, cursors and state are per agent and chat. The same check on the person's words (`hasContent`) decides the run before a turn; it too never runs while a tool call waits. One model call does run while a tool call waits: the timeout review above asks the decision model "as the subconscious", and the main AI sees its decision as a `subconscious` pair (qf w2, 03.11.: inside the 110 s command, the only one; 0 of 125 model calls of runs fell in a tool window); whether that is the exception the owner's message of 01.11. allows is his decision. The main AI's own call needs no check. Nothing searches
  automatically: a model asks through a tool call, and no code names its query or place.
* **Kept from before:** the verification of a task result against its done-condition (`subconscious/verify*.ts`) and the
  widget fills for to-dos the person typed (`widget*.ts`).

### 5.5 The transcript by item IDs (the context ledger, restored)

Owner 28.10./01.11.: compaction is ongoing, not just at 60 %; the subconscious may condense an old message, tool output or
skill text ("Dann sieht es auch das Modell unten drunter, dass da kompakt steht"), hide it completely, or bring it back.
This is the B-048 ledger that wave B of the simplification deleted by mistake on 31.10.; it is back (migration `089`),
simpler: the separate gardener is gone, the subconscious's brains decide, and the main AI has one tool of its own.

* **Items** (`context/ledger/*`, `shared/model/context-ledger.ts`, table `context_items`): every unit of an agent's
  working context in a chat has a short id that is never reused – `m<seq>` a chat message, `t<n>` a tool call with its
  output (ours or engine-native), `s<n>` a loaded skill text, `r<n>` a reasoning summary, `a<n>` the agent's own text,
  `f<n>` file content read. A turn's journal is captured as it is written (`capture.ts`); a call made inside a code-mode
  script is stored as nested and costs nothing in the live context. A row keeps its title (120 characters) and condensed
  text for good, so an id never dangles; the original (a message, a run item, a blob) stays. The brains' context tools also take a bare
  number (`33` or `"33"`) for the one item whose id carries it; messages and the other kinds count apart, so a number two items carry
  (`m3`, `t3`) is not guessed – `context.hide`, `condense` and `read` answer with both forms (B-074).
* **Marks, by the brains' tools** (`subconscious/context-tools.ts`): `context.list` pages the older items one line each (id, kind, tokens – a marked one as `condensed 300t (was 4500t)` or `hidden (was 4500t)` –, the first 80 characters and what the main AI said after it; a page fits one step's output, its head points past its last line). Without `minTokens` every run sees the marked ones too (q-r1b2, 03.11.: as bare ids a run could neither take a condensed file out on the person's word nor bring it back); `minTokens` counts what an item takes now, so the tidy run's first list holds only what could still come off (q-r2a/q-r2c: with the marked ones in it, the cheap model hid them all and condensed the hidden ones back, turn after turn); condensing a hidden item says what it costs and counts so,
  `context.read` pages one original, `context.condense {ids}` puts a short text in each item's place, worded by the brain that holds the flow from the whole original in one call; a mark's output says what is still big; the run logs what it cost against what it saved, `context.hide` takes it out,
  `context.restore` brings either back: when the main AI asked, it gets the originals as the call's output; in any other run the undoing pins nothing and shows nothing unless `done.show` names the ids. A condensed item reaches the main AI as the short text with a **compacted JSON
  stamp** under it: `{"compacted":"t17","was":"<n> tokens","restore":"context.restore"}`; a hidden one is not seen at all, with the
  calls its script made: one real tool call in the rebuilt history names ids only, none of its words – under the main AI's own tool name
  `subconscious` ("My context, kept small by the subconscious: condensed t17; hidden t9 – get any back with tools.call …"; until 03.11. it was
  `context.hide`, a tool the main AI lacks: in q-r1b2 s15 it looked for that tool with 127,047 input tokens and told the person it could remove
  nothing). What a run did on the person's word about the transcript the main AI learns from that run's `agent.tell` (the prompt says it sees only ids).
  *What stays out of reach*: the newest 2 turns, the person's newest message and – behind a bare "ja bitte" – the newest one
  with content, calls made inside a script, and for the run after a turn pinned items: a pin is the main AI's hold against the
  subconscious's own tidying, so a run on someone's word – before a turn, or the main AI's own call – lists a pinned item as "(the main AI
  brought it back)" and may condense or hide it (q-r2d s15: the restored file was missing from the asked run's list, it hid other items and
  the person heard that the file was gone); a condensed text may not name a value the original lacks, may not
  exceed a share of the original, and most of its long words must stand in the original (else the LLM is asked once more with the reason). *What to keep* is the brain's judgment (the prompt), not code.
* **The way back for the main AI** (`tools/builtin/context.ts`): `context.restore {ids, keep?}` returns the originals as
  this tool's output (at most 20 ids and 20,000 characters per call, marked as data from earlier work, not instructions),
  pins them for 3 turns or, with `keep: true`, for good (within a token cap per chat; `keep: false` lets one go). The items are back in
  place, so the call's result is condensed to its first line at once (`ledger/capture.ts`) – also when the restore ran inside a code-mode
  script whose output is nearly all restores (q-r2d s14: such a script kept the whole file a second time in the rebuilt history). The stamp names it and the marks call gives its `tools.call` form (it is no direct tool: a main AI that looked among its tools went digging in the database, q1); to find what it forgot, the main AI asks the subconscious (§5.4). Spec 121 tokens, found through
  `tools.find`.
* **Retention** (`ledger/retention.ts`): the originals of condensed and hidden items stay at least 14 days after they were
  marked and within 64 MB per agent and chat (oldest hidden ones go first, then the oldest condensed; kept items never);
  tool, skill and file outputs over 4,000 characters live in blobs, which go back to the store's clean-up. After that the
  stamp says "original: gone" and the item is no longer offered for restore. The person's "Forget permanently" clears the
  ledger's copies and prunes originals that mention it (`ledger/forget.ts`).
* **A kept item stays what it was** (`ledger/view.ts`): in a rebuild an engine's own output keeps its 64,000 characters, ours the model's cap of 24,000: nothing nobody marked is cut.
* **Where marks take effect** (`agents/rebuild.ts`, `rebuild-items.ts`, `rebuild-revert.ts`, `engines/{codex,claude}/rebuild*.ts`,
  `context/ledger/marks.ts`): a session is rebuilt from the ledger view when the turn runs on another engine than the last
  one, when the engine has no usable session while the ledger has items, or when the session lacks marks that take something off it –
  at the agent's next turn, with no minimum (until 03.11. max(12k tokens, 25 % of its context): in q-r1b2 the marks of almost every turn
  reached the session only every third turn, and a chat of medium items never); a rebuild must leave the session smaller than the engine last
  reported it, and a restore alone rebuilds nothing (the call that brought the item back stands for it): it rides along with the next mark
  of the subconscious, and both count – the item back in place against its condensed result (until 03.11. a restore made in a script kept
  its result in full, counted as a cost only and held back the hides of q-r2d s15/s16); the renewal (64k) is the backstop for what marks cannot bring down. Codex: the thread is cut back before the first changed item and only the tail is
  injected again, which keeps the prompt cache (15,488 of 15,705 input tokens cached after revert + inject, measured 28.10.);
  a fresh thread would start with none. Reasoning replays only as the engine's own item with its signature or encrypted content of the same account and family, else not at all (as text it would read as words the model never said); the subconscious's calls of a turn stand in front of its chat lines, as the session holds them. Claude Code: a transcript written in `<data>/engine-transcripts/claude/<id>.jsonl`
  and resumed with `--resume <path>`, checked by a model-free probe per CLI version; a tool of ours the turn does not offer
  is written as `tools.call` (a model that reads it under its own name tries that name and fails), and the first request
  of a rebuilt session is written like a new session's, so the stable prompt block stays the cached one. A native tool call becomes the other
  engine's matching call where one exists (`engines/neutral-calls.ts`), else a text note. A session-less or stateless engine
  gets the marks applied to its lines at once, plus one call that names every condensed and hidden item and how to get them
  back. A rebuild the engine refuses is not retried every turn: it blocks that chat and engine for 6 hours. The chat's
  renewal summary and its seed follow the marks too (hidden and condensed lines do not come back through them).

## 6. Engines, accounts, routing, decisions

**Agents run without asking** on every engine: Claude Code with `--permission-mode bypassPermissions`, Codex with
`approvalPolicy: 'never'`, ACP permission requests answered allow – unless the agent has an access mode (AF-013, below).

**Access modes (AF-013, `runtime/access/*`, `shared/model/access.ts`)**: per agent `<data>/agents/<id>/access.json`
(`access.set`; no file = full access, the behaviour above), a chat can override the mode (`access.setChatMode`, the
composer's mode cell `chat/composer/AccessModeCell.tsx`, click or Shift+Tab), a run too (`access.setRunMode`). Modes: `read`
(reads and read-only commands; changes denied), `ask` (every change, command and outside tool asks the person), `project`
(changes and commands inside the turn's folder run, outside asks), `full`. Rules: write/denied folders, command allow/deny
patterns, network, connector/MCP tools, money (deny > allow > mode; `access/rules.ts`, `access/commands.ts`). An `ask` waits
in `access/approvals.ts` for the person's dialog (`shell/AccessRequestDialog.tsx`: Allow once · Always for <agent> – adds
the rule – · Deny; 30 min, a stopped turn or Escape refuse). Enforcement per engine: the tool registry judges the app's own
tools on every engine (the only check for API and local models); Claude Code gets its own permission mode, disallowed
tools and `--permission-prompt-tool` answered by the hub (`engines/claude/access.ts`, `access/prompt-tool.ts`); Codex
gets a sandbox and approval policy, each approval request judged (`engines/codex/access.ts`); ACP permission requests are
judged (`engines/acp/turn.ts`). Not enforced: Claude Code's reads (Read/Glob/Grep never prompt), what a command does once
it runs on engines without an OS sandbox (Claude Code, ACP, `shell.exec`: the command text is judged), browser/computer
clicks beyond their tool's category.

**Agent from folder (AF-014, `runtime/folder-agents/*`, `ui/team/FolderAgentDialog.tsx`)**: a folder chosen in the dialog
(Team › Add › Agent from folder…), dropped on the Team list or sent by the Explorer's right-click entry "Create Autark agent
from this folder" (`main/explorer-menu.ts`: HKCU `Directory\shell` and `Directory\Background\shell`, registered at the
packaged app's first start, removable in the dialog, deleted by the uninstaller; `--agent-from-folder <folder>` reaches a
running app as a second instance → navigate `agentFromFolder`) becomes a new agent's home project. `folderAgents.find`
suggests name and role (package.json, pyproject.toml, Cargo.toml, go.mod, README) and lists the instruction files, skills and
other tools' settings; `folderAgents.create` hires the agent with an own part that follows those files and uses those skills
(they reach every turn through "Home project", §5.1), sets the home and the access mode `project`. Several agents per folder
are fine; Team › Add › "Group agents by folder" groups the list by `folderAgents.homes`.

| Engine | How it runs (`runtime/engines`) |
|---|---|
| Codex | One long-lived `codex app-server` per account home (`CODEX_HOME`), persistent threads with our dynamic tools; workspace `.codex` config and the person's own MCP servers are not loaded (`isolation.ts`, `own-mcp.ts`); the finder picks the `codex.exe` that has `codex-code-mode-host.exe` beside it first (`accounts/executables.ts`; without that file no tool call of an agent can run); lean helper threads, cut after 8 model requests (`turn.ts`, `HELPER_REQUESTS`) and, with a structured output, after 90 s without a sign of the model once `turn/start` answered (`HELPER_SILENT_MS`; the app-server's echo of the turn's input is no sign); that cut and a thread – helper or agent, start, resume or fork – the app-server does not open within `THREAD_OPEN_MS` (120 s, `helper-thread.ts`; B-075: a cold app-server on a large `CODEX_HOME` needed ~65 s) end as the turn's own timeout, which cools no account (`accounts/failure.ts`; a chat's redelivery retries it), and the turn's signal (a Stop, a helper call's own limit) ends an open too (`untilStopped`); every new agent thread (`thread/start`, `thread/fork`, the rebuild and its probe) is stored with `threadSource: 'chatgpt_hidden'` (`HIDDEN_THREAD`, never on `thread/resume`), which the Codex desktop app leaves out of its sidebar, search and notifications – the server only stores the label (B-075); code mode (one `exec` tool, `code-mode.ts`); native fork; the app note (`app-note.ts`: one text item in the first turn of a thread, after Codex's own multi-agent note – §5.1); limit reads and banked resets |
| Claude Code | One `claude -p` stream-json process per turn with the MCP hub (`--strict-mcp-config`, a hub call may take up to an hour); lean: our system prompt only and its built-in tools cut to the execution core, a helper turn without any built-in tool (`claude/lean.ts`); session resume; native fork; history purge |
| ACP plan CLIs | Gemini CLI, Copilot CLI, Kimi Code on the generic ACP engine (`engines/acp`): one agent process per account, a stable MCP proxy per session |
| HTTP | OpenAI Responses, Anthropic Messages, OpenAI-compatible (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, …) – `engines/http` |
| Fake | Deterministic demo/test engine (`fake.ts`, `WORKFORCE_FAKE_ENGINE=1` / `--fake`) |

* **MCP hub** (`runtime/mcp/hub.ts`): ONE Streamable-HTTP MCP server inside the runtime for every CLI engine run; each
  run gets a lease token (`/mcp`, loopback only). Clients see our tools as `mcp__workforce__<name>`.
* **Engine registry** (`engines/registry.ts`): lazy construction, idle sweep; processes are leases of the supervisor.
  The CLI engines get the agents' env once (`engines/wf-shim.ts` `agentEnv`: `<data>/bin` first on PATH,
  `AUTARK_DATA`, §3); `childEnv` still strips provider keys.
  A provider's transient failure is an outage of the account, not of the model (`provider-outage.ts`).
* **Accounts** (`runtime/accounts`): any number per provider, each with an isolated CLI home or a key in the vault (or
  a key from an environment variable). Detection scans installed CLIs, their login state, ACP probes and local model
  servers (`detect.ts`); sign-in and sign-out run the official CLIs (browser, or a visible terminal for Copilot and
  Kimi – `sign-in.ts`, `terminal-login.ts`); a status command that gives no answer (a CLI that crashed on a loaded PC)
  leaves the login unknown, never "signed out" (`cli.ts`, `detect.ts`); official installers (`install.ts`); `accounts.try` runs one tiny real turn.
  The first-run and Settings plan buttons (`ui/onboarding/plan-setup.ts`) always add an account and start its
  sign-in (installing the CLI if missing); they never reuse a connected account or send an `accounts.try` turn.
  `monitor.ts` keeps limits current (provider pushes, plus one timer reading Codex every 15 s and Claude every 60 s).
  The order of plan accounts is Move up/down in Settings; `Account.rotation` (use plans of one provider in turn) is a
  field the AI sets with `accounts.update` on request (skill `ai-providers`), not a menu item.
  A plan found signed out becomes work: a sign-in task for an agent or the person's to-do (`relogin.ts`).
* **Model catalog** (`models/catalog.ts`): every model the accounts can run, merged with the curated priors
  (`resources/model-priors.json`, `models/priors.ts`) – the one score source. Media-only providers (ElevenLabs, fal.ai)
  come from a curated table.
* **Routing** (`routing/router.ts`), one route per turn in this order: category (the mode's, refined by a keyword table
  for generic modes) → candidates (connected, capability needs, the agent's policy band; the mode's tier as a
  preference) → a pin (the chat's choice, else the agent's) → the agent's own `model.set` (a named model or a need:
  stronger, cheaper, faster, vision, long context) → the Settings **use** (below: agent turns the Work model, the
  runtime's helper calls the Decisions model, `routing/pins.ts`; for a helper call on `auto` the helper default on its
  qualifying plan accounts, `helper-default.ts`) → **a person's own request** (`routing/person-turn.ts`, below) → the
  previous model unless it is weak for the work → the deterministic score (prior + tier fit + plan headroom − cost) →
  effort, then the healthy accounts of that model. A split's own choice beats the agent pin. Cost mode:
  `settings.routing.costMode` (best, balanced, economy). Policies: `routing/policies.ts`.
* **The rule for a person's own request** (`routing/person-turn.ts`, step 4 in `router.ts`): a turn whose agent has a new
  text or answer line from a person unread (its chat read cursor; not task, schedule or colleague wakes, splits or the
  runtime's helper calls) runs on the highest tier the Work use allows – ranked like cost mode `best`, the work-plan bonus
  kept – at effort `high` or above (clamped to the model's efforts). It yields to a chat pin, the agent's own `model.set`,
  the Work model chosen in Settings, a fixed chat or agent effort and cost mode `economy`; if the previous model is in that
  top tier it simply continues, so its session is kept. Reason (live): without it the Manager's chat turns ran as "chat ·
  strongest fit" on a mid model at medium effort and answered from memory without a tool. Cost: more plan use for every
  turn that answers the person. The route reason reads "a person's request · strongest model".
* **Decisions** (`decision/service.ts`): typed choice/score/predicate answers from ONE backend – a cheap connected
  model with structured output (`llm-fallback.ts` over `engine-runner.ts`). The Decisions use picks the model, `auto`
  meaning the small default of a Codex plan; with nothing connected callers use their own rules. Without a decision
  model connected, a small chat model of what is connected stands in, and every surface says so: `models.uses` gives
  the note "No decision model yet – <model>, a chat model, answers these calls", the state `setup` and the action "Set
  up with AI". Agents hand a bounded choice to it with the `decide` tool (2–255 options → choice, none fit, or unsure).
* **One model system – providers, keys, models, ten uses** (`shared/model/models-uses.ts`, `routing/uses-settings.ts`,
  `shared/model/providers-connect.ts`; owner 01.11.: provider, then API key, then the models to choose, in one simple
  system). A connection is a provider plus a key (or a plan found on this PC, or a local server); every connection lists
  its models. A **use** says which model does one kind of job: `work` (agent turns), `decision` (helper calls: decisions,
  compaction, verification), `voice` (realtime conversation), `stt`, `tts`, `image`, `video`, `music`, `sound` (the media
  functions) and `embeddings` (B-064: the model that makes files and memory searchable by meaning, §5.3). Each is `auto`
  or `<provider>:<model>`; `work` can also name a plan (`codex`: that plan's best model each turn); the media uses and
  `embeddings` can be `off`. `embeddings` `auto` = this PC's small model, else an embedding model of a local server, else a
  connected API key whose service embeds; `local` names the PC's own model; a chosen model that is unreachable says so
  instead of falling to another (vectors of two models do not compare, `models/embeddings.ts`). They live in `settings.json` section `routing` (shown as "Models", one comment line
  per use) next to `costMode` and `allowPaidFallback` (no row in Settings; true lets API keys compete with plans on
  every turn, false – the default – uses a key only when no plan or local model can; the AI sets it). **A stored `auto`
  is never shown as "auto"**: `runtime/models/uses.ts` (`models.uses`) names what runs per use – Work on a plan
  "<model> · each turn", search by meaning on this PC "MiniLM-L12 multilingual" (`vectors/local-model.ts`), Voice on
  this PC its hearing + speaking models, the ChatGPT plan's images "GPT Image"; `routing/helper-default.ts` `helperModel`
  names the model decisions would really run on (the plan's helper default, else the smallest and cheapest chat model an
  account can run now). Agents read the same as one line (`context/setup-facts.ts` `usesLine`: "- Decisions: <model> on
  <account> (a chat model; no decision model connected | a decision model) · Search by meaning: <model> on this PC | …")
  in the manager's live part and in `app.status`; `models.list` with category `decision` or `embeddings` answers that
  line plus only the connected models made for that use. Gone: `decisionModel`, `functions`, `helper`, `workPlan`,
  `voice.realtimeModel`, the Ollama "decision" marker, `decision/hint.ts`, `routing/guidance-settings.ts`. One-time moves:
  `routing/uses-settings.ts` maps the old keys when settings are read (`functions.chat` or `workPlan` → work;
  `decisionModel`, `helper`, `functions.compaction` → decision; `functions.<media>` → that use; `voice.realtimeModel` →
  voice; an older global pin from `models.setPolicy` → work), and `accounts/legacy.ts` maps accounts at start (old
  'decision' accounts become normal connections – OpenRouter's an OpenRouter connection, other hosted vendors an
  OpenAI-compatible one at `<origin>/v1`, local ones an Ollama or compatible local server, key, priority and on/off kept;
  'artificial-analysis' accounts are removed, their key stays in the vault); code reading a use also understands the older
  object shape. `models.setPolicy` with a global pin now writes the Work use.
* **API connections are a file** (B-066): `settings.json` section `providers`, one entry per connection
  `{name, protocol, url, key: "secret://<id>", models}` with protocol `openai-chat`, `openai-responses`, `anthropic` or
  `decision` (`shared/model/provider-entries.ts`); the file head's comment lists the known services. Unknown providers
  are a URL, a model name and an API type. `accounts/provider-file.ts` reconciles entries into the accounts table
  (state, limits, priority stay in the table) and moves older API accounts in once under an id from their service or
  name (`moveOld`). The settings form, `accounts.add` and the AI (skill `ai-providers`: research a provider from its
  name, send the key through the Secrets system) all write this one section. Plans found on this PC, keys from the
  environment and scanned local servers stay detected.
* **Money**: only a cost journal (`spend/ledger.ts`, `spend.list`) – real charges of paid turns (`models/pricing.ts`;
  subscription plans cost nothing per turn); an agent notes a purchase of its own with `spend.note` (B-066). No budgets,
  no purchase locks, no monthly limit in code or settings; spending is the skill `money` and the "Money" line of an
  agent's own SYSTEM.md (§5), references the AI adapts and nothing enforces.
* **Token counts** (B-073): `inputTokens` stays the whole input. Beside it an engine reports `cachedInputTokens` (Codex,
  `last.cachedInputTokens` of `thread/tokenUsage/updated`) or `cacheReadTokens` / `cacheWriteTokens` (Claude Code and
  Anthropic HTTP, which still count them into `inputTokens`) when it has them (`engines/types.ts` `CacheTokens`): per request
  on the `usage` event, summed in the turn result (`engines/shared.ts` `addCache`). The structured runner passes them on, so
  the helper-call log and the subconscious's tally (`cached`, the cached part of `used`) carry them, and so does an agent
  turn's attempt usage, also across native-timeout continuations (`agents/native-timeout.ts`) and failover sums
  (`agents/turn.ts`). `models/pricing.ts` prices the cached part at a prior's `priceCachedInputPerM` only when the prior has
  one; none does today, so nothing booked changed. No DB column: run rows keep input and output only.

## 7. Tools, connectors, skills, secrets

### 7.1 The tool registry – no gate

`tools/registry.ts` is one list of tools, exposed identically to every engine. **One call path:
validate → place → run → redact → journal.** Validation checks the arguments against the schema (`validate.ts`);
placement decides the company on this PC (`company`, §5) and the PC (`placement.ts`, §8); the output is redacted and bounded (`outputs.ts`); the journal
(`journal.ts`) records the call with an idempotency key (a resend of a running call id gets its result). There is no
permission, approval or judgment step – except the agent's access mode and rules (AF-013, §6), which the registry
checks before a call runs. Every string argument first passes the secrets leak guard
(`secrets/guard.ts`): a stored secret value becomes its handle, so it never lands in a note, file or message.

A tool is offered when its mode's patterns match, when it is in `EVERY_MODE` (asking the person, delegation,
`model.set`, `decide`, the secrets catalog with export and delete, `companies.list`, find, web search, the meta tools …)
or when it is a connector tool (`anyMode`); device tools need a mode that works on a computer or browser. Tool
descriptions, errors and result notes speak as the agent (B-075: "I end my turn now"; `agents.list` marks the caller
`me: true`).

Families (`tools/builtin/*` and the owning folders): `agents.*` (list, create, update, archive, delegate, handoff,
split …), `chat.*`, `tasks.*`, `todos.prepare`, `human.ask`, `schedules.*`, `calendar.*`, `knowledge.*`,
`references.*`, `skills.*`, `modes.*`, `models.list`/`model.set`, `decide`, `files.*` and `shell.exec` (any absolute
path on the PC), `web.search`/`web.fetch`, `secrets.*`, `media.*`, `people.list`, `spaces.*`, `app.status`,
`accounts.sign_in`, `feedback.report`, `computer.*`, `browser.*`, `phone.*`, `devices.list`/`devices.connect`, `telegram.connect`,
`companies.list`, `app.<connector>.<tool>`, `tools.find`/`tools.call`.

**Web search** has two paths. The engines' own search comes first: Codex agent threads run with `web_search = "live"`
(`AGENT_WEB_SEARCH` in `engines/codex/helper-thread.ts`; helper and image threads keep it off) and Claude Code's lean
tool set includes `WebSearch` (`CORE_TOOLS` in `engines/claude/lean.ts`; `WebFetch` stays out). `web.search` is the
second, keyless one (`tools/builtin/web-search.ts`): it tries DuckDuckGo, then Bing (its own parser), and when both fail
it names a search page to read with `web.fetch` or open in the browser. Measured on 01.11.: 8 of 8 queries answered
via Bing; DuckDuckGo, Mojeek, Startpage and Brave answered every query with a bot check.

### 7.2 Connectors are files plus a skill

* `<data>/connectors/mcp.json` – `{"mcpServers": {"<name>": {"url", "headers"} | {"command", "args", "env", "cwd"}}}`
  (the map Claude Code, Cursor and Codex use; `"disabled": true` turns one off; AF-005: `"agents": [<id or name>…]` gives its
  tools to those agents only – `apps/agent-access.ts`, `ToolDef.forAgent` checked by the registry's offer and call; left out
  of the fingerprint, so a changed list connects nothing again). `mail.json` – mailboxes (address,
  password, agent, optional imap/smtp, `agents`). Any value may be a `secret://<id>` handle, resolved only at connect time.
* `apps/service.ts` applies the files at start and on every change, connects lazily (`apps/connections.ts`), registers
  `app.<id>.<tool>` for every agent, caches tool lists (a start needs no server), runs the MCP OAuth sign-in
  (`apps/oauth/*`; the browser opens only for a new or changed entry or `apps.reconnect`) and writes `status.json`.
  Own MCP client over HTTP and stdio (`apps/client/*`). RPC: `apps.list`, `apps.reconnect` – nothing else.
* **Mail** (`apps/mail/*`): IMAP/SMTP/MIME of our own; one IDLE connection per mailbox wakes the mailbox's agent on new
  mail (`apps/mail-wake.ts`); bulk mail wakes nobody (`mail/loops.ts`).
* Skills: `connect-apps` (the files), `telegram-setup`, `whatsapp-bridge` (with a template script on Baileys that uses
  the external protocol: `chats.connectExternal`, `messages.send`, `files.upload`, `GET /events` – never run against
  WhatsApp), `phone-access`, `import-agent-system`.
* **Chat bridges** (`runtime/bridges`): a chat mirrored to a Telegram bot (one long poll per bot); `telegram.connect`
  lets an agent set it up; a private chat's user is the owner, groups link with a `/link` code. **External agents**
  dock into one chat with a token (`bridges/external-agents.ts`; protocol: `docs/EXTERNAL_PROTOCOL.md`).

### 7.3 Skills are plain folders

`skills/service.ts`: agentskills.io skills (a folder with `SKILL.md`, front matter name + description) from five places,
highest first: an agent's Main Skills (`<data>/agents/<id>/skills`), an agent's own (`<workspace>/agents/<slug>/skills`),
the shared library (`<workspace>/skills`), imported (`~/.codex/skills`, `~/.claude/skills`, read-only), shipped
(`resources/skills`, read-only). An agent writes a skill like any file; the next read sees it. Every agent may load
every skill (`skills.load`, `skills.save`, `skills.find`). No versions, audiences or retirement. The shipped skills
speak as the AI that reads them (B-075: descriptions "I read this when …", no permission wording;
`test/unit/skills/skill-voice.test.ts`); a `skills.find` line cuts a description at 240 characters. A skill's front matter
`metadata.modes` limits the modes whose index lists it (none = every mode); since G1 the app's own skills
(`app-settings`, `app-look`, `app-guide`, `phone-access`, `whatsapp-bridge`) carry `modes: [none]`, a key no mode
has – in no mode's index, still found by `skills.find` with a query and loaded by name – and the manager, general and
secretary modes list none of them (`telegram-setup`: browser mode only). Shipped skills include
`app-settings`, `app-look`, `agent-duplicate`, `connect-apps`, `phone-access`, `phone-adb`, `app-guide` ("How this
app works"), `org-setup-onboarding` (hiring and shaping a team, tool facts only), `task-ownership`, `human-minimal-handoff`, `representation`, `reference-curator` and work skills (video, web, research,
writing, social, bookkeeping …).

**Skills from a link** (AF-007, `skills/links/*`, RPC `skills.previewLink/linkTargets/installLink/linked/checkUpdate/applyUpdate`,
UI `settings/skill-links.tsx`): a GitHub repository or folder (also `/tree/<ref>/<path>`, every ref split tried; read as
`github.com/<o>/<r>/archive/<ref>.zip`), a SKILL.md address, a ZIP address or an uploaded ZIP. A preview lists every skill
(name, description, files, scripts) and holds the bytes the person saw; the install writes exactly those into one place – the
shared library, an agent's own skills (`SkillService.folderFor`) or an agent's home project's `.claude/skills` – staged in a
hidden `.installing/` folder and renamed into place. ZIP entries are checked (no `..`, absolute paths, drive letters, links,
device names, same-name entries; `LINK_LIMITS`: 64 MB archive, 10 MB per file, 30 MB and 500 files per skill); scripts are
only saved (no executable bit), never run; Markdown loses invisible characters. `.autark-source.json` beside the skill keeps
the source and every file's hash; Update reads the source again and shows changed/added/removed files (the person's own
edits marked, their added files kept) before one swap.

### 7.4 The secrets catalog

* Values live encrypted in the vault (`secrets/service.ts`, OS keychain via `Host`); agents only ever see handles
  `secret://<id>` and the catalog (`<data>/secrets/<route>.md`: id, name, kind, tags, description – never a value).
  An edit of name, description or tags on disk reaches the vault; what only the app sets is kept as `.rejected.md`.
* Use by handle: `secrets.run` (a command with the value in its environment), browser fill by id, connector values,
  `web.fetch` headers, app tool arguments. Tools: `secrets.list/save/generate/run/import/export/delete`; grouped entries (a login,
  a card – `groups.ts`), TOTP (`totp.ts`), secure capture of what the person types (`capture.ts`, `chat-capture.ts`).
  No access lists: every agent may use every handle. A text field's hint is the text itself, clipped to 60 characters
  (`groups.ts` `textHint`; B-075: a login shows its username, not its first character; `init()` brings older hints up to it).
* **Import** (`import.ts`, `import-parse.ts`, `shared/model/key-values.ts`): browser and password-manager exports (CSV,
  Bitwarden JSON), `.env` files and flat JSON of names and values. From `.env`/JSON only pairs that hold a secret go in
  (`isSecretPair`: a secret-like name – key, token, secret, password, auth, session, webhook, dsn … but not an address or
  path such as `AUTH_URL` – or a URL with a password, and at least `MIN_SECRET_CHARS`); plain settings count as
  skipped, a value already held as unchanged. An agent imports by path and never sees a value; `secrets.import` deletes
  a password export after a complete import (the result's "file" line says so) and keeps `.env`/JSON files. Our own
  export (`import-parse.ts` `OWN_EXPORT`, recognised by the columns only it has together: totp, kind,
  description, tags, route) comes back with kind, description,
  tags and route; the import keeps the names and descriptions it is given (an earlier import's "not described yet"
  counts as none), and its review task covers only the entries without a description (B-075).
* **Export and bulk delete** (B-075; `export.ts`, `units.ts`): `secrets.export` – the agent tool `{path?, ids?, route?}`
  and the RPC `{ids?}` (PC only) – writes the chosen entries, all when none are named, into one CSV: Chrome's columns
  (`name,url,username,password,note`), then `totp,kind,description,tags,route,number,expiry,cvc,holder`; a login's or
  card's field without a column becomes its own "<name> · <field>" row, a group of free fields is skipped and counted.
  The file gets mode 0600, by default `~/Downloads/autark-secrets-<date>.csv`; a path inside the data folder gets the
  default, a taken name " (2)" – nothing is overwritten. It returns `{file, count, skipped, notFound?}`, never a value.
  The agent tool `secrets.delete {ids?, route?, all?: true}` returns names only; the CEO's linked PCs follow through the
  sync. "All" and a route leave out what the app works with unless named (`units.ts` `catalogUnits`: createdBy
  `SYSTEM_ID` and `heldByApp` – an account's, bridge's or calendar source's `secret_id`, an app's OAuth secrets, the
  Google calendar secret, the feedback keys).
* **The person's side, no pop-ups**: Settings › Secrets has one fixed-height band above the catalog with Name | Value
  rows (`ui/settings/SecretRows.tsx` `SecretBand`); a pasted `.env` or JSON splits into rows, Add takes the kind from the
  name, "Choose file…" or a file dropped on the band or the catalog imports, and "Login, card or fields…" or a row's Edit
  open `SecretForm` in the same slot; one reserved line holds results and errors. In a chat, Plus › Secret is a
  composer mode above the text (`ChatSecretBar`); each row becomes a chip. On the PC each catalog row has a box
  (`ui/settings/secret-catalog.ts`, B-075): every entry starts selected, and a group's head holds All, None, the count,
  Export (its path in a toast) and Delete (asks once); an entry the app works with (`usedByApp`, from `secrets.list` /
  `secrets.groups`) starts unselected, is selected only by its own box and says "Used by the app"; a login shows its
  username where a value would be.
* Kept on purpose: the leak guard (a value never lands anywhere else), output masking (`redact.ts`) and refusing
  values too short to mask.

## 8. Devices

**One connect surface** – Settings › Devices (`ui/settings/DevicesGroup.tsx`, rows `connect-rows.tsx`, texts
`connect-text.ts`; the same connect rows open from the first run's "Connect to my other PC" beside Skip,
`ui/onboarding/ConnectCard.tsx`, and a link as CEO ends the first run), in this order:
this PC's **Remote ID** (9 digits: 8 from the key fingerprint plus a check digit, `remote/id.ts`) with Copy and the
meeting server's state in its hint ("meeting server connected", "only this network …"); incoming
requests with their code (Accept – for an employee's PC with the person it belongs to – or Decline); "Connect a phone"
(a QR code for me or for an employee); **PCs on this network** with Connect (`remote/nearby.ts`, the LAN hello on UDP
47813, `devices/discovery.ts`); "Connect a PC" by Remote ID or address (IP:port of a fixed IP or local server), as CEO
or as employee; one row per device with right-click Rename and Remove. Connection settings (`devices.findable`,
`devices.relay`, `devices.peer`, `devices.peerPort`, `pwa.enabled`, `pwa.bind`) are `settings.json` keys the AI changes.

* **Connecting PCs** (`runtime/remote`): find the PC (LAN first, then the meeting server – `remote/find.ts`; the
  lookup waits once for the server's `connected` state, up to 45 s for a free host's cold start,
  `rendezvous/service.ts`, and "not found" names the cause first: no such PC online, server off or not reachable), run the
  numeric-comparison exchange (`remote/sas.ts`, a 4-digit code both people compare; the chosen role is part of what
  the code covers), the target person accepts (`remote/requests.ts`: 5-minute TTL, at most 3 open requests, 5 per
  address in 10 minutes – the endpoint faces the internet). The accepted PC is stored with its proven key. Agents link
  a PC with `devices.connect {target, role?}` (`devices/connect-tool.ts`; the role is how this PC joins the other PC's
  company, CEO by default); `devices.list` also shows this PC's `remoteId` and `meetingServer`
  (connected | connecting | off).
* **Roles**: joining as **CEO** (default) means everything is the same as on the CEO's own PCs – they reach every
  method, and agents use tools on each other's PC. Joining as **employee** binds the PC to a person
  (`Device.personId`); that PC may only call `ping`, `device.caps`, `device.addresses` and `sync.rows` (which takes
  from it only its person's own lines and task changes) on the CEO's PC, while the CEO's agents can use tools on it.
* **The mesh** (`devices/mesh.ts`): one live, encrypted connection per linked PC – pinned Ed25519 keys, an X25519
  handshake into an AES-256 channel (`handshake.ts`, `channel.ts`), JSON-RPC over it (`rpc-peer.ts`). Dialing
  (`reach.ts`) opens the stored addresses and the address the meeting server saw at once (the first socket wins);
  the tunnel is the last fallback. PCs exchange their current addresses over the link (`device.addresses`). Only the
  smaller device id retries with backoff (1, 2, 5, 15, then every 30 s – B-077, before up to 5 min); only a refusal
  (close code 4003 before the handshake answer: unknown device, bad key) ends the retries, a network error or a slow
  handshake (4000) does not. **Liveness** (B-077, owner 05.11.: changes pushed at once, like a realtime database; on
  05.11. a link this PC dialed stayed "online" for minutes after it died, and one outage lasted 43 min): both ends ping
  every 15 s (`http/keepalive.ts`, the dialed sockets through `compose/peer-dial.ts`), any frame counts as life, a tick
  that comes late because the process itself stalled ends nobody; so a dead link closes on both sides within 15–30 s,
  the smaller side redials and the link-up catch-up sends what is owed. File pieces on the link are 1 MiB
  (`sync/file-io.ts`, `send-file.ts`), so pings never wait long behind one. "peer dialed", "peer link closed" and a
  refused dial are info lines. The data path itself was already push (rows within 300 ms of the change, below).
* **The meeting server** (`services/remote-relay`; address = `settings.devices.relay`, empty = off; default
  `DEFAULT_RELAY` = `wss://telecoding-relay.onrender.com/autark`, Autark's own, mounted under `/autark` in the
  TeleCoding relay process on Render behind Cloudflare, `AUTARK_IP_HEADER=cf-connecting-ip`; a test profile –
  `WORKFORCE_TEST_DATA` or the demo engine – skips the default, `devices/connect.ts` `meetingAddress`; the copy in the
  TeleCoding repo is `apps/relay/src/autark/` and must follow changes here): a PC registers its key and peer port; the server shares the address it sees only between two
  PCs that pinned each other; they then talk directly. A sealed tunnel through it is the last resort – the server
  cannot read or alter the traffic. Remote ID lookups are sealed end to end. Client side:
  `devices/rendezvous/{service,relay-client,seal,tunnel}.ts`. It runs on its own port (`src/main.ts`; bundled by the
  build target `meet` to `app/meet.mjs`, unpacked from the asar, so the app's own binary as Node can run it; a
  `Dockerfile`) or mounted on another program's HTTP server (`createRelay({ noServer: true })`, the host hands over the
  WebSocket upgrades); behind a proxy `RELAY_IP_HEADER` names the header with the client's address (e.g.
  `cf-connecting-ip`). A client takes a URL with a path (`wss://host/path`) as it is.
* **Remote tools** (`tools/placement.ts`, `devices/tools.ts`): `computer.*`, `browser.*`, `phone.*` and `shell.exec`
  (a terminal on a linked PC) take an optional `device` argument; without it they run on the agent's home device, else
  on this PC. A call for another PC is forwarded over the mesh as `tools.call` and runs there like a call of that PC's
  own agent (a remote `shell.exec` has no 120 s RPC timeout; its own limits bound it); the journal names the PC.
  `devices.list` shows the PCs, their capabilities, `homeDevice` and `employeeOf`. Agents can hire an agent with its
  home on another PC (`agents.create device`).
* **Shared work between linked PCs** (`runtime/devices/sync/*`, wired by `startSync` in `runtime/main.ts` before the
  start-up reconcile, §4.1; mesh methods `sync.rows`, `sync.secret`, `sync.file`, `sync.login`; listeners attach only
  while a PC is linked). What a link carries
  (`home.ts`, from `devices.allow` `{personId?, joinedAs?}`): between **CEO PCs** everything both ways; to an
  **employee's PC** the chats the person is a member of, the messages they may read (`people/access.ts`, from the join or
  the whole history), their tasks, in the person's own terms (`people/perspective.ts`); back from it only the person's
  own lines and changes to their own tasks (`employee.ts`; anything else is dropped quietly, wakes from it are ignored).
  A link coming up sends what is owed since that PC's cursor (everything the first time): rows, secrets, settings and
  the file manifest, every plan's login; the wakes that waited go right after the rows (B-077, before after all of it). Clock (`stamps.ts`): one stamp per unit, last
  writer wins; ties at 0 go to the joiner (a differing secret under a shared id is kept under a new id). Rows
  (`tables.ts`, `rows.ts`): stored files' metadata (`files` rows without refs and text preview), spaces, people, chats
  with members, agents (of the live state only "paused"), tasks, schedules, accounts (metadata; a CLI plan a PC found
  travels too – the receiver gives it its own home, or the default home of a CLI with one sign-in per PC, and keeps
  one account for the same provider and e-mail (any one, for such a CLI), the `detected` flag stays per PC),
  messages, chat notes and knowledge rows (chat observations and old versions of memory files, without embedding,
  uses and last use), written through
  the repositories and the services' own events, no echo, passed on to the other CEO PCs. A message gets a fresh local
  seq; a streaming one travels with its live values (§4.2), and one that ends here after other lines came, or a silent
  row that ends, gets a fresh seq again, so no colleague's cursor has passed it. Changes gather for `FLUSH_MS` (300 ms)
  and each row goes once, in its latest state; rows that never travelled (stored files, knowledge rows, CLI plan accounts a
  PC found) get a stamp each time the sync starts, so an existing link gets them at its next link-up. Secrets
  (`secrets.ts`): the sender decrypts at send time, the values travel only inside the mesh channel to CEO PCs and are
  stored under the same id; only ids, counts and error codes are logged. **Plan logins** (`logins.ts`, B-075, owner
  04.11.: sign in once, the plan works on all his PCs): the files that hold a CLI plan's login (`accounts/cli-homes.ts`
  `loginFiles`: Codex `auth.json`, Claude Code `.credentials.json`, Gemini CLI `oauth_creds.json` and
  `google_accounts.json`) are read at send time and travel only inside the mesh channel between CEO links – never to an
  agent, tool, prompt, the UI or a log. The newer login wins by its own time (Codex `last_refresh`, Claude Code's and
  Gemini CLI's token expiry; else the file's mtime); the receiver writes the files whole (mode 0600) into the account's home here – its own
  `<data>/accounts/<provider>/<id>`, or a CLI's default home (`~/.codex` …) – and never over a file of another account
  (Codex `tokens.account_id`, Gemini CLI's id token subject). A folder watch and account events send a change after
  0.5 s. A sign-out in the app stays on that PC: its mark (kv `accounts.signed-out`) takes no login from a linked PC
  until a new sign-in here or the account's removal. Copilot CLI and Kimi Code logins and Claude Code's on macOS
  (Keychain) do not travel. Files (`files.ts`, CEO PCs only): `theme.css`, `prompts/`,
  `modes/`, `agents/**`, `memory/**`, `connectors/mcp.json` and `mail.json` and the workspace's `skills/**` as whole
  files by sha256 (manifest, tombstones, pieces of at most 4 MiB), a change going at once through the watcher's tap
  (`root/watcher.ts`); `settings.json` (`settings.ts`) as one unit per top-level section (`settings/<section>`) – all
  but `devices`, `pwa` and the window layout –, stamped only on a real change, with a baseline at 0 when the sync
  attaches (an older single `settings` stamp counts for every section); a winning section becomes a `settings.update`
  patch, so a text cleared on one PC is cleared on the others, but at the first link the joiner merges: an empty or
  null text from the other PC never clears a text the joiner has (its own name stays), and what it kept – also a
  section only it has – goes back as its own change (0.3.1 PCs and this
  version ignore each other's settings until both are updated). Stored files' bytes (`blobs.ts`) come when first
  needed: a reader that misses one – `http/files.ts` `serveFile`, `files/store.ts` (`FileStoreDeps.missing`, wired in
  `compose/services.ts`), `context/attachments.ts` `prepare()` before a turn – awaits `needBlob()`, which pulls it by
  its sha256 from an online CEO PC (`sync.file` op `blob`) and checks the hash. `file-io.ts` puts a pulled file in place
  by renaming a temp file, and where Windows refuses the rename (EPERM, EBUSY, EACCES) copies over the target; a failed
  pull leaves the link-up incomplete. Not carried: the `models` table (each PC's own catalog), read cursors, calendar
  and media rows, browser extensions. **Home device**: a NULL `device_id` means this PC; an agent's turns run only on its home PC
  (dispatcher gate, §4.1), its due wakes are handed there (through the CEO PCs when the home is not known directly),
  and each schedule fires on one PC (`placeSchedules`: where its agent runs; the person's on the CEO PC with the
  smallest id). A PC that joins as CEO retires its own untouched first-run Manager and empty chats once the company's
  agents arrive.
* **Phones since B-078 (D5)**: a phone pairs by this PC's Remote ID through the meeting server, the same 4-digit code
  on both screens, Accept on the PC; access exists exactly while its accepted device row exists (no "Phone access"
  switch). Android: the native app (`apps/android`, phone use via an AccessibilityService). **iPhone without an Apple
  account**: a hosted web app (`ui/hosted/`, bundled by `scripts/hosted-bundle.mjs` into `apps/website/src/app/`,
  served from its own origin, today `https://autark-theta.vercel.app/app/`; `website/build.mjs` refuses an origin
  shared with the site, Meta Jarvis or TeleCoding). It ports Android's relay client to WebCrypto (Ed25519, X25519,
  HKDF, AES-GCM), opens a pinned-key tunnel to the PC and uses `rendezvous/phone.ts`'s stream protocol to the PC's own
  HTTP port; its service worker relays `/app/pc/*` requests to the page, `window.autarkHosted` gives `ui/lib/rpc.ts`
  a WebSocket over the tunnel. The PC's `index.html` carries `<meta name="autark-hosted">`; without it the shell says
  "Update Autark on your PC". `phone.pcs` lists the company's PCs for the phone, `phone.forget` revokes its own row.
  The PC-served web app and its `pwa.link` code below stay as the other way (Tailscale/LAN).
* **Phone and browser access (PWA)** (`runtime/pwa`, `ui/pwa`): the runtime serves the same UI; `pwa.enabled` and
  `pwa.bind` (localhost, lan, tailscale) decide where. "Connect a phone" makes a one-time pairing link (`pwa.link`, QR
  `#pair=<secret>`) that the phone trades for a device token (`pwa.exchange`); only token hashes are stored. A paired
  phone of the owner has full access. Beside the QR stands a 6-digit code for the same link (`pwa/pair-code.ts`, B-075:
  an installed iPhone app keeps its storage apart from Safari's, so it types the code, `ui/pwa/AccessRequest.tsx`) –
  10 minutes, one use, kept in memory as sha256 only; the open codes face 10 wrong codes together and the 10th drops
  them all (`rate_limited`); `pwa.exchange` takes the secret or the code. The phone's address (`pwa/service.ts`
  `phoneUrl`, from `urls.ts`) is `tailscale serve`'s https address first (`tailscale serve status --json`, read again
  when older than 30 s, `SERVE_CACHE_MS`; showing the QR waits for that read), then LAN and tailnet – never this PC's
  loopback: with nothing else `pwa.link` refuses (`conflict`, "choose 'The same
  network' or ask the AI to set up Tailscale"), and `pwa.enable` without a bind while only the loopback answers takes
  `lan`. Web push with VAPID (`push.ts`, `vapid.ts`, `webpush-crypto.ts`); the service
  worker is `ui/pwa/sw.ts`. **Back on screen at once** (B-077, `ui/lib/rpc.ts` `checkAlive`): when the page becomes
  visible, is shown again (`pageshow`), the network returns or a push arrives (`wf.wake` from the service worker), a
  closed socket reconnects at once and an open one is asked `session.info`; no answer within 3 s ends it as dead and a
  new one opens – its `onOpen` reloads chats, tasks and the open chat (a socket a sleeping phone kept "open" stopped all
  events until the OS noticed). The desktop window's port is untouched. A phone opens the PC's own address: on the LAN, a fixed IP or forwarded port, or
  `tailscale serve` set up by the AI with the skill `phone-access`. On the phone the UI is mostly chats, plus voice.
* **People of the organisation** (`runtime/people`): the owner is the first person (`human`); employees are people
  with name, role, a manager and their own chats and to-dos. An invite (`people.invite`, QR or link, 72 hours, one use)
  lets a person's phone or browser ask to join; the owner allows it on a to-do; the device gets a person token.
  Person devices call the person variants (`people/rpc-*.ts`) and see the chats they are members of and their own
  to-dos (`people/access.ts`, `perspective.ts`). The owner sees everything. A new message in a chat reaches the
  devices of every person who is a member by push (`pwa/person-push.ts`).
* **Android control** (`runtime/phone`): `phone.*` tools over adb (USB or wireless debugging) – pair, connect,
  disconnect, devices, screenshot, ui_tree, tap, swipe, type, key, open – on any linked PC that has the phone. Setup
  (installing adb through the shell, pairing, `adb tcpip`) is the skill `phone-adb`. No phone RPC and no phone screen.
* **Computer use** (`runtime/computer`): a persistent Windows helper (PowerShell with UI Automation,
  `resources/computer/windows-helper.ps1`) and a Linux AT-SPI helper. Tools: screenshot, windows, ui_tree, act (by
  element ref), click, type, key, scroll, drag. One pointer lease per PC (`lease.ts`), named pointers for each agent
  (`pointers/hub.ts`), human priority while the person uses the PC (`presence.ts`), human-like motion. A simple
  Stop/Resume (`computer.stop`/`resume`, a latch in kv) and the emergency stop cut computer input.
  Desktop broker (Windows, optional, installed once by `scripts/broker-install.ps1`): the service `AutarkDesktopBroker` (LocalSystem, Session 0, `resources/broker/Broker.cs`) starts a worker with its own SYSTEM token in the console session (`Worker.cs`), which serves the same helper protocol on `\\.\pipe\AutarkDesktopBroker` (ACL SYSTEM + installing user, key in `%ProgramData%\AutarkDesktopBroker\broker.key`, typed text sealed) and runs every request on the current input desktop (Winlogon/UAC included); its C# is the helper's own, cut out of `windows-helper.ps1` by `resources/broker/build.ps1`. `drivers.ts` takes it at each helper start when its pipe is listed (`computer/broker.ts`), else PowerShell; the screenshot text says when the secure desktop is shown.

**Still to build** (the owner's device design, not done): phones reaching a PC through the meeting server (today:
direct address only). NAT hole punching (today: direct only when the peer port is reachable, else the tunnel). An
employee's phone attached to the employee's PC (owner addendum, "only if simple"). Not live-checked: the whole device
area, the sync between two real PCs, the employee push and the HTTPS route via `tailscale serve`.

## 9. Voice, media, calls

* **One dictation path** (`ui/lib/dictation.ts`, desktop and phone alike): the microphone (`microphone.ts`, 16 kHz
  through an audio worklet) → the take as a 16 kHz mono WAV → `files.upload` → `voice.transcribe` → editable text at
  the caret. The composer's mic, the feedback cell's hold-to-talk and My day use it. While this PC's first speech
  model downloads, the mic says "Speech model downloading NN %" and waits. Main has no voice code; it only arms the
  microphone for 15 s per request (`bridge.armMedia`, `main/security.ts`).
* **Transcription** (`voice/transcribe.ts`), one fixed order: this PC's local model (sherpa-onnx: FastConformer,
  Canary, Parakeet – `voice/local/*`) → the `routing.functions.stt` endpoint (learned words as prompt) → a free
  listening model (`listen-transcribe.ts`) → a "not set up yet" text. Long recordings are cut at quiet moments
  (`transcribe-endpoint.ts`). The recommended local model downloads by itself at the first start
  (`voice/local/auto.ts`). Learned words are the plain list `voice.vocabulary` in `settings.json`. The person
  (Settings › Voice), the main AI (skill `app-settings`) and the subconscious (`voice.words`, §5.4) add to it; the
  transcription endpoint, realtime voice and the call talker use it; this PC's local models and the listening fallback
  do not. Local speech
  output is Supertonic, voice activity Silero.
* **One voice mode** (`shared/voice/conversation.ts` `VoiceSessions`, page side `ui/chat/composer/voice.ts`,
  `pwa-conversation.ts`): utterance → `voice.transcribe` → `messages.send` (marked spoken) → the reply is read aloud →
  listen. Up to three chats at once over one microphone: the chat started or focused last listens; replies are read
  one at a time (another chat's with its title in front); talking over a reply interrupts it. On the phone, hiding the
  page ends voice; the desktop window keeps talking when minimized.
* **Calls** are this voice mode started from the chat header's Call cell (`ui/chat/call/CallHeader.tsx`). With
  `settings.voice.realtime` 'auto' it first tries **realtime voice** (`runtime/calls/realtime/*`: OpenAI GA or an
  OpenAI-compatible account with a realtime model; one session per chat, keyed by the device, that opens or joins the
  device's call; quiet transcript lines; `hand_over` gives the agent a full turn and the voice tells its written answer;
  ends on idle, maximum length or the device leaving) and falls back to the voice loop. Default 'off' (billed per minute).
  B-066: **Gemini Live** is the second realtime engine (`calls/realtime/gemini-live.ts`, its own WebSocket protocol, key
  in a header; checked against a fake socket only). Without a realtime model the **talker** (`calls/talker.ts`,
  `voice.talker`, default on) answers each spoken line at once through the Decisions use while the agent keeps working:
  its line is stored as the agent's (`meta.call.voice 'talker'`), and `relay` none/next/now says whether the agent
  also gets the line in a turn. A spoken line stored quiet still counts as awaiting an answer (`agents/publishing.ts`
  `awaitsAnswer`). Both speak as `voiceAgent` (`calls/realtime/setup.ts`, B-075): the chat's one agent; in a default 1:1
  with more agents by now, the agent of its pair, else its lead; a group with several agents has none – there the
  delivery picks who answers, as for a typed line, and a line that @mentions another member always goes that way. The
  talker's picture of the work comes from the streaming rows (`meta.live`, synced from the agent's home PC too, with
  the PC named), this PC's activity only for a run without a chat. The texts these models read speak as the agent.
* **A call is one row in its chat** (B-075; `runtime/calls/call-log.ts`, `shared/model/call.ts`; owner 04.11.: a call
  log as a bubble): the PC of the device the person calls from writes one quiet status row per call whose `meta.call`
  is a `CallRecord` {id, participant `device:<key>`, name, pc, startedAt, endedAt?, lines: [{at, from, name, text,
  messageId}]}. `calls.start {conversationId}` → `{callId}` opens it or returns that device's call open there;
  `calls.end {callId}` (its own device only), the device's connection closing or the runtime stopping end it – a call
  left open at a stop ends at the next start at its last line (`calls/wiring.ts` `endCallsLeftOpen` →
  `CallLog.endLeftOpen`, §4.1), so the end travels; open
  calls are kept in kv `calls`/`open`. While a call is open every final line after its row is appended – the person's
  lines and every agent's answer, also one synced from the agent's home PC; a quiet line only with the call's id (the
  talker's held line, realtime transcripts, the hand-over note with `details.callId`); the newest 120 lines, 1,000
  characters each. A later edit or deletion of a named row updates every call row this PC wrote. `messages.send` stores
  a live line (`speech.live`) of the owner or a device with `meta.call` {id, participant, name} of that device's call
  (`speech.call`, else the one open, else a new one). The voice loop (`shared/voice/conversation.ts`) starts and ends
  its chat's call and names its id on every line; its reply wait goes on while `ConversationSummary.working` is not
  empty (rows that stream, also from another PC), and an agent row that starts streaming later opens it again. UI: the
  row is one bubble (`ui/chat/call/CallTranscript.tsx`) – "Call · HH:MM · m:ss" or "running", open while the call
  runs; the rows its lines name fold into it and show there in full (`message-rows.ts` `callEntries`), every other row –
  a late answer too – stays a row.
* **Media** (`runtime/media`): a library row (+FTS over name, description, tags) for every stored file, one probe lane
  (size, duration, pages); `media.search/describe/uses/delete`. Generation of images, speech, music, sound effects
  and video through the function models (`generate.ts`: OpenAI-compatible, Gemini, ElevenLabs, fal.ai, images on the
  ChatGPT plan via Codex, local speech). Seeing and hearing: `media.view`, `look` (keyframes from main's analyzer
  window), `listen` (local hearing report with sound tagging – CED Mini, `sounds.ts`), `transcribe`.
* **Feedback** (`ui/feedback`, `runtime/feedback`): the header's feedback cell – click for the form, hold to talk; a
  window screenshot with paint-over for private parts; the report is sealed for the team's key and dropped into the
  team's Firestore mailbox (`delivery.ts`, `seal.ts`); the team PC reads text and images through the owner-only
  Feedback menu → Inbox (`FeedbackInbox.tsx`, `feedback.inbox*`) or `wf feedback`. Opening the inbox and Refresh
  fetch encrypted reports once, decrypt/store locally, then delete the cloud copy. The form provides the data
  summary and full `FeedbackPrivacy.tsx` notice before Send. Canvas export keeps the flattened JPEG within
  600,000 image bytes; an oversized complete envelope stays local rather than dropping its screenshot. A send that is not
  confirmed leaves the report saved on the PC, and the form's action cell then reads "Send again" (the same saved
  report with its screenshot goes out again). AF-003: the form has Bug | Idea; a delivered report shows "Report no."
  (the first eight characters of its mailbox id, `reportNumber`, also in the team inbox); a failed send reads "Not sent."
  with its reason (`details.reason`: offline, timeout, server, refused, not_set_up); runtime.log has a line at start
  (can this build send – receiver.json found?), per saved, sent and failed report (ids and reasons, never the text).

## 10. Browser, the global pane and the areas

**The person's browser** (desktop only): `main/workspace-browser.ts` hosts native website tabs
(`WebContentsView`) in a separate persistent session – sandboxed, no preload, no Node, no runtime access. Tabs live in
spaces in `<data>/side-tabs.json` (`workspace-tabs.ts`: `{version:2, spaces:{global, "chat:<id>", "agent:<id>"}}`;
main reloads it when an AI or an editor writes it; a tab not shown is only an entry until used). **One shown tab per
space** (`workspace-shown.ts`): the global pane, a chat's area and an agent's area each show their own native page at
the same time; `show {id, bounds}` replaces only its own space's tab, `hide {id}` takes only that tab off its slot, a
window resize or reload hides all; the side driver's "the person looks at it" is per space. Tabs on a slot plus the last
tab of the two spaces shown last stay loaded; **preview tabs** (`workspace-marks.ts`, with the background and opener
marks): a page an agent opens goes into its preview tab in that space and its next page replaces it (unless `newTab`);
the person's click or key in it, their own address, a double-click or "Keep tab" keeps it (command `keep`); its title is
italic; the mark is not saved. Every new-tab path (window.open, the page menu, an agent) is one `openTab()`.
A tab hidden for 20 minutes gives its page up (`workspace-discard.ts`); a page an agent uses while nobody looks lives
in `workspace-host.ts`, an invisible unthrottled host window (pages nobody sees draw nothing and take no clicks,
measured 02.11.), at most 5 live pages (LRU); downloads go to `<workspace>/downloads/personal`
(`workspace-downloads.ts`); find in page and the browser keys (`workspace-chrome.ts`); history with search
(`workspace-history.ts`, `<data>/browser-history.json`, no address with a credential or token), recently closed tabs
and zoom per site (`workspace-tab-memory.ts`), favicons (`workspace-favicon.ts`). Site permissions follow one fixed rule, nobody is asked: a page's own site may use camera,
microphone, notifications, fullscreen and clipboard writes; everything else is refused (`workspace-session.ts`). The
page's right-click menu is native (`workspace-page-menu.ts`: Back, Forward, Reload, Open link in new tab, Copy link,
Copy, Paste, Send page to chat, Inspect). IPC contract: `shared/api/workspace-browser.ts`.

**The same pane on every linked PC and on the phone** (B-076, owner 05.11.: "ziemlich das exakt dasselbe … auch auf dem
Remote-PC", "auch am Handy"):

* **Tabs travel** (`runtime/devices/sync/{tabs,tabs-map}.ts`): one sync unit per space (`global`, `chat:<id>`,
  `agent:<id>`), last writer wins, CEO links only, sent at each link-up. The runtime watches `side-tabs.json` through the
  data-folder watcher, writes what it receives with `writeAtomic`, and main follows by itself. The link-up sends the side
  pane first (before rows, secrets, files and logins); a PC that just joined keeps its own pane changes at stamp 0 until the
  other PC's pane has arrived, so the existing pane wins; a close made here survives a newer copy from elsewhere; a path tab
  too long for main's limits stays on its own PC. Each PC alone decides about
  its own websites: on another PC they are `{"id":"remote:<device>:<tab>","panel":"remote","device","tab","url"}` (no title
  in the file – the live state brings it; an address over 1,500 characters travels as its origin)
  panels, which may be reordered or closed there (a close travels back in `closed` and closes the real tab), never opened
  or re-addressed. File, folder and media-by-path tabs of another PC carry `device` (id `file@<device>:<path>`).
  Unchanged content sends nothing.
* **Files live where they came from** (`devices/sync/paths.ts`, mesh `files.path`, CEO only): `files.readPath`,
  `writePath`, `listPath` and `uploadPath` take `device` and run on that PC (stamp conflicts unchanged; an offline PC
  answers at once "<pc> is offline."); a media file is stored on its PC and its `files` row comes back, the bytes are
  pulled on first view (`needBlob`). The four methods are open to the owner's paired phones on a secure transport
  (`manage` + `secure`; `side.*` need `todo` + `secure`; `tabs.get`/`tabs.set`/`tabs.position(s)` and the events
  `tabs.changed`/`tabs.position` need only `manage`, so over plain LAN http a phone sees and changes the pane but gets no
  file content and no live picture – the file tab says "Open the HTTPS address to do this."); a save over
  7 MiB to another PC is refused before sending, a larger read answers `large` (one mesh frame is 8 MiB).
* **The view position** (`devices/sync/positions.ts`, `ui/workspace/view-sync.ts`): the scroll fraction (FolderView),
  plus the top line (FileView) or the video second (MediaView), at most one report per 300 ms per tab, the person's own
  scrolling wins for 1 s, received moves report nothing back; kept in memory (200), never in `side-tabs.json`. RPC
  `tabs.position`/`tabs.positions`, event `tabs.position`.
* **A remote website is live** (`main/side-driver/caster.ts`, `runtime/browser/side-view.ts`,
  `runtime/devices/side-view.ts`, `ui/workspace/RemoteWebTab.tsx`): the PC that owns the tab casts it with a DevTools
  screencast on the tab's own CDP connection (JPEG 60, ≤ 1280 px, ≤ 1 frame per 500 ms, the page kept loaded while
  watched, a cast ends 60 s without renewal); the viewer pulls frames (`side.pull`/`side.pullPart`, parts ≤ 1 MiB, ~2/s on
  a PC, 1/s on a phone) and sends input (`side.input`: only `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`,
  mapped onto the newest frame with the page's zoom; counted as the person's own, so agents wait) and navigation
  (`side.nav`). With `device` the RPC goes over the mesh to that PC (CEO links only, not an open method); without it, this
  PC. The page loads, sends and keeps its logins only on its own PC. The tab glows blue (an inset ring, `--remote`) and
  names its PC ("on office-pc") in a fixed cell of the usual address row (Back, Forward, Reload, PC, address, Go,
  pane menu); an offline PC shows one calm line and is tried again every 5 s, and taps while this device is offline are
  dropped, not replayed. The picture takes the keyboard only on a click (`BrowserSurface` `autoFocus={false}`), and the
  pane's tab shortcuts stay the app's. A page's alert/confirm travels in the state (`dialog`) and is answered from the
  viewer (`side.nav {dialog: accept|dismiss}` → `Page.handleJavaScriptDialog`); input meanwhile is refused at once. A
  tab whose window on its PC is minimized or hidden moves to the off-screen host so it keeps painting
  (`workspace-shown.ts` `painted`); watching is no agent use, and the page leaves the host when the cast ends unless an
  agent used it lately.
* **The phone** (`ui/workspace/phone-tabs.ts`): its pane reads its PC's spaces (`tabs.get`/`tabs.set`, event
  `tabs.changed`) instead of keeping its own; the PC's websites are remote tabs there (the first real website view on the
  phone), files show with content, and what the person does goes back to the PC.

**Three surfaces, one workspace component** (`ui/workspace/WorkspacePane.tsx` on a space; its parts – strip, address
row, menus, panels – read the space from `space.ts`, and every command in `pages.ts` names its space):

* **The global pane** (`shell/Shell.tsx`, space `global`, global tabs only – where the person works). On desktop it
  lies below the header row with its strip as its first line. Where the row leaves the strip room for three titled tabs
  after the caption controls and the frame's two cells (Shell.tsx measures `.pane-row-room` against `strip-slots.ts`
  `ROW_ROOM` = 358 px: a pane of about 587 px and more on Windows, 449 px on macOS, at its width beside the open
  sidebar) the frame has `strip-in-row` and the pane starts at the window's top: its strip is the title row's part above
  it (header height + 1 px, its foot line continues the sheet edge, its empty room drags the window, right padding for
  the caption, workspace and feedback cells), one 40 px toolbar row follows, a page starts at 89 px. A drag of the pane
  or the window may move the strip between the two places; a click never does. In the phone layout it is a pushed full-screen sheet (`phone-pane.ts`, `MobileShell` `PhonePane`, its
  own row with Close), opened by a way in that lands in global or, in the desktop app, the Browser cell of the phone row.
* **A chat's area** (`chat/ChatArea.tsx`, space `chat:<id>`, shared by everyone in the chat): AF-010 – it docks where
  `settings.json › appearance.chatDock` says (`shared/model/appearance.ts`, `lib/appearance.ts`): right of the messages
  by default (a column of the chat body, like a side panel, `data-tour="side-panel"`), left, under the composer, at the
  top of the chat column (the old place) or floating as a window of its own over the chat; the chat keeps 340 px beside
  it and 240 px under it. A grip on its inner edge (`chat/DockResize.tsx`; the floating window: right and bottom edge)
  sizes it; its grip cell at the strip's end – or the strip's empty room – drags it, a guide over the chat shows where
  it lands (an edge docks there, the middle floats), a click on the cell opens the same choices. While a dock is
  dragged every native page steps aside (`dock-dragging` on `<html>`, `native-surface.ts`), and a slot that moved without
  resizing is measured again (`wf-surfaces-moved`). Place and sizes are the person's (settings.json, synced to their
  linked PCs); full view and the phone dock it at the top. The chat's own surface colour, pill tabs and one 1 px line
  (`styles/chat-area.css`) – visibly part of the chat, not like the global pane. The chat header's "Chat tabs" cell
  toggles it (pressed state and a dot); open per chat (`lib/shell-state.ts` `wf.chatAreas`). On the phone it fills the
  chat body above the composer. Chat details (`ChatPanel`) is details only. Tabs drag to a new place in their strip or
  onto the other surface's strip – a chat's area ↔ the global pane (`pages.ts` `moveTab`; a website keeps its page,
  main moves it with the layout); the tab menu has "Move to the browser pane" / "Move to this chat's tabs".
* **An agent's own area** (space `agent:<id>`, kept by the agent): the lower half of the agent page's Browser view
  (`team/AgentBrowser.tsx`, two fixed halves), under the live view of the agent's own browser.

Each surface has the same parts. The **tab strip** (`TabStrip.tsx`): tabs with favicon, title and close cell, width
clamp(48 px, room / count, 200 px), re-measured only once the pointer leaves the tabs and "+" (one hold, so a closed tab
keeps its place); below 72 px a tab shows its icon; "+" right after the last tab (at the room's end when tabs scroll);
the agent's avatar only on its own-browser tab, "Opened by <agent>" in the tooltip; "All tabs" with the count in the
one menu (`TabsMenu.tsx`). Under it the **40 px address row** (`BrowserHeader.tsx`): Back, Forward, Reload, the address
slot (the address alone at rest – the title lives on the tab; the omnibox with suggestions from open tabs – global's
only where a global pane exists – and history on click, Ctrl+L or a new tab, `Omnibox.tsx`; the find field on Ctrl+F;
the path on a file or folder tab) and
one menu cell (`PaneMenu.tsx`: find, zoom, mute, Mark a region into the composer, DevTools, copy address, system
browser, send page to chat, History, Reopen closed tab, Full view – per surface). Back/Forward/Reload are only faint on
a blank or app tab – nothing shifts. Tab rules are pure in `browser-model.ts`. A native page hides only under what
lies over its slot (`native-surface.ts`: a dialog, popover, menu or toast; for a chat's or an agent's area also the
floating global pane, the phone sheet or the chat's details); a status line never hides a page. The frame's feedback
cell sits at the far right (`shell/WindowBar.tsx`).

**Tab kinds**: a blank tab (the new-tab page lists the panels it can become, `NewTabPage.tsx`), a website tab (lives in
main), and the app's own panels: **My day**, **Work**, **Activity**, **Notes** (a chat's shared notes,
`NotesView.tsx`/`notes-sync.ts`), **Media** (one stored file or a file on the PC: image, player, PDF head –
`MediaView.tsx`; without a file the searchable library, `MediaLibrary.tsx`), **Video** (a chat's video work with its
versions v1…vN, `VideoView.tsx`, `video-versions.ts`), **Screen** (this PC's live picture while agents use it,
`ScreenView.tsx`), an agent's own browser, **a file or folder** by its path (`FileView.tsx`, `FolderView.tsx` over
`files.readPath/writePath/listPath`; Skills & memory and every settings page open their files here) and **custom views**
from `<data>/pages/<name>.html|js` (`PageView.tsx`, `wf-sandbox://page/<name>`, the mini-tools' bridge; `rpc.methods`
lists what they may call). Ways in: the chat header's "Chat tabs" cell (the chat's area), the frame's Browser cell
at the far right (the global pane), a link (`openWebsite`), Chat details › Notes, an image or file in a message, a
video (`chat/side-pane.ts`). A way in that names no space lands by one rule (`attention.ts` `setOpener`): on desktop
in global; in the phone layout in the open chat's area, else the global sheet; a panel asked from a tab in the space
that shows that tab. A tab an agent opens in a closed surface lights that surface's cell dot (no dot for an agent's
area). On the phone, files open with the system app.

**Agents' browsers – one tool surface, two transports** (`runtime/browser`):

* **Own browser**: Playwright with one persistent Chrome/Edge profile per agent (`<data>/browser-profiles/<agentId>`,
  its logins stay); runs off-screen, on the headless CLI host and on linked PCs (`service.ts`, `sessions.ts`).
* **The person's browser**: side tabs driven through the host op `sideBrowser` → `main/side-driver/*` over the
  DevTools protocol (accessibility snapshot, human-like steps with the shared motion model, console and network logs,
  wait without polling). An agent-opened tab carries its opener {agentId, agentName, chatId}.
* **Where a call goes** (`browser/place.ts`): `where: own|chat|global` decides (own browser, the chat's area, the
  person's pane); else the tab id (`web-…` in any space, `t1` the agent's own); else where the agent worked last (own at
  first). `browser.show` opens a page as a shown tab and opens its surface; with `where: 'own'` it goes into the agent's
  own area. `browser.open` and `browser.show` reuse the agent's preview tab unless `newTab`. Panels go into an agent's
  area by the agent writing its `agent:<id>` space in `side-tabs.json`. The full where-hint stands once per turn in the
  environment's "Browser, where:" line and in `browser.show` (the chat's area: everyone there sees it, with the logins
  the person made in these tabs; global: the person's pane; own: the agent's browser with its own logins, and its area);
  no text claims these tabs hold the logins of the person's other browsers – those browsers keep their logins and
  autofill on this screen, and a colleague in computer mode reaches them (`context/environment.ts`).
  Secrets fill by id in both; `browser.save_secret`/`save_totp` store what the agent meets (`secret-tools.ts`); 2FA
  setup keys and password values are masked in page text; a captcha is reported as a fact (put it on the person's day).
* **Live view and takeover** (this PC only): Team › agent page and browser to-dos show a CDP screencast of an agent's
  own browser (`view.ts`); the person can steer, type and take over (`takeover.ts`: one flag; while on, every agent
  step answers that the person has taken over; handing back wakes the agent in its chat and task; passwords the person
  typed go to the vault). Phones pull frames (`view-pull.ts`).

## 11. UI shell rules

* **One fixed frame** (`ui/shell/Shell.tsx`): rail | side (sidebar: header row + scrolling body, resizable) | main, and
  the global pane at the right – below the main zone's header row, from the window's top with its tab strip in the
  title row only where the row has room for three titled tabs (`strip-in-row`); opening it moves no cell (§10). `shell/views.ts` is the one
  route table (side zone, main zone, phone stack); views hand over content and header data, never chrome. The phone
  layout (`MobileShell.tsx`) is the same frame as a stack with bottom tabs; the global pane is a pushed sheet there.
* **Header rows** (`lib/header.tsx`, `lib/header-model.ts`, `styles/header.css`): every zone's top row is
  `--header-h` (48 px), a grid of fixed tracks [lead 36 | title | cells 32 px each | caption room]. A cell is a fixed
  32×32 box; a missing cell is an inert placeholder of the same size. The chat's row is segmented (`has-segments`):
  a fixed-width title track, the Call and "Chat tabs" cells right after it, then the open details panel's name and X
  above that panel (no second header inside it). With `strip-in-row` the title track is capped (other main rows: the
  caption track takes the pane's place) so the global pane's strip has its room in the row.
* **Window buttons in the header row**: all headers form ONE 48 px row; there is no strip above it, also in compact
  windows (the global pane's tab strip is part of that row). On Windows/Linux the native window-controls overlay fills that row in its colour (`main/title-bar.ts`,
  overlay height 47 px so the sheet's edge line stays visible); macOS traffic lights are centred in the same row. CSS
  reserves both edges from `env(titlebar-area-*)` (`--caption-left`, `--caption-reserve`; defaults only when the
  geometry is unknown: macOS left 80 px, otherwise right 150 px). The rail toggle and the first zone's title yield
  sideways to left controls; the main zone (`.rightmost`) reserves the right ones as `--caption-space` (controls plus
  the frame's feedback and Browser cells, `shell/WindowBar.tsx`). Compact desktop windows keep one row at phone widths.
  Real Mac/Linux caption buttons are not yet checked on the devices.
* **Nothing shifts on a click** (the owner's standing rule): toggles change only colour or icon inside a reserved cell;
  count badges are absolute; a busy button keeps its box (spinner over a transparent label); CSS state selectors never
  change font-weight, padding, margin, width or min-height (`test/unit/styles/stable-states.test.ts` fails on any);
  rows waiting for data render a fixed skeleton; scroll areas use `scrollbar-gutter: stable`; focus uses
  `preventScroll`. Status never takes a band: `shell/StatusLine.tsx` lays up to three small lines over the top of
  the main zone (connection, work stop, voice, realtime, toasts – lasting ones for to-dos, blockers and important
  messages, §4.2); in a chat they lie over the top of the messages (CSS anchor on `.message-scroller`), so under an open
  chat area and never on its tabs or page; elsewhere, or without anchor support, at the zone's top. A line never hides
  a native page. A fill never overwrites a draft.
* **Right-click menus everywhere** (`lib/context-menu.tsx`): a row spreads `useContextMenu(() => sections)` on its root;
  a right click (or a long press on touch) opens the shared menu at the pointer; `openContextMenu(x, y, sections)` for a
  button; `<ContextMenuHost/>` is mounted once in `App.tsx`. Menus are text only. One builder per object:
  `chat/chat-actions.ts` (chat rows and title), message menu (Reply, Copy, Edit, Delete), `team/menus.ts` (agent,
  person), `tasks/task-menu.ts`, `tasks/todo-menu.ts`, `splits/split-menu.ts`, calendar blocks, schedules, account and
  device rows, browser tabs. Page titles of agents, people, splits and tasks open the same menu as a dropdown
  (`team/TitleMenu.tsx`); on the phone a ⋯ button and long press.
* **Fewer icons**: icons only where they carry meaning (rail, header cells); menus, settings rows and groups have none.
* **Settings pages** (`ui/settings/Settings.tsx` with `SettingsNav.tsx`, `sections.ts`; `#/settings/<page>`), each a view
  on a file the AI edits through a skill, with a cell that opens that file in the file tab: **General**, **Models**
  (`ModelSetup.tsx`, shared with the first run: plans found on this PC, connected accounts and one connection form;
  `ModelUses.tsx`: one row per use with a provider select and a separate model cell, "Other…" takes a free name, and
  only "Model choice" below them; both write the `providers` and `routing` sections of `settings.json`,
  `runtime/accounts/provider-file.ts` reconciles them into accounts; protocols `openai-chat`, `openai-responses`,
  `anthropic`, `decision`; a cell names the model that runs, never "Auto" (§6); account rows have Move up/down and no plan
  roles), **Voice**, **Calendar**, **Secrets** (the inline band, §7.4),
  **Connectors** (AF-005, page id `apps`, nav `data-tour="connectors"`: the connected rows with status, Test, on/off and a ⋯
  menu – tools, Agents…, token, file, Remove –; the catalog with GitHub, Google, Notion, Slack, Discord …; "Own MCP server"
  (HTTP with headers or stdio with arguments and variables, every value into Secrets) and "Paste JSON" (the `mcpServers` of
  Claude Desktop / Claude Code, checked by `settings/mcp-import.ts`), all written into `connectors/mcp.json`),
  **Skills & memory** (skills with their route, the memory tree, click opens the file tab), **Devices** (§8),
  **Feedback**, **About** (version and update, back up and restore, data folder). Everything else is a file the AI edits.
* **Browser surfaces**: the global pane, each chat's area above its messages and each agent's area on its page, with
  Chrome-like tabs for pages and panels – §10.
* **"Set up with AI"** (`team/set-up-with-ai.ts`): for anything without a screen of its own, a menu item opens the
  Manager's 1:1 with a prepared request in the composer; the person adds the detail and sends.
* **Composer** (`chat/Composer.tsx`): one action row of fixed cells [+] [spacer/waveform] [Ultra] [Model] [Mic] [Send].
  Ultra is a small labelled switch beside the model chip (`UltraCell.tsx`); the model chip has a fixed width and shows
  the short name ("Opus 5.5", `lib/model-name.ts`). With nothing chosen it names the model `routing.preview` routes the
  agent to in this chat (`ignorePin`, `lib/route-preview.ts`; the last model the agent used here until it answers); its
  menu's first item names that model ("Chosen per task", stored as `auto`), then one searchable list, effort. The agent
  page's Model select names its unpinned option the same way (without a chat `ignorePin` also leaves out the agent's own
  pin). The + menu (`composer/PlusMenu.tsx`: Files & folders, Photos & screenshots, Secret – the composer's secret mode,
  §7.4 –, Task, then the send items of `composer/slash.ts`) and the Send button's right-click (Send as important, Send
  silently, **Schedule…**) never grey an entry out: with nothing to send a level sets the draft's level and Task fills
  "/task ". Beside Plus the access mode cell (AF-013, §6). **Schedule
  mode** (§4.6): one settings block over the text inside the frame, the text area grows, and the bottom edge of the
  composer, Plus, Ultra, the model chip, Send and the header do not move (the window test measures them in light, dark,
  640×480 and phone width, and that the block's boxes do not change when switching Once/Repeat); Send turns into a round
  clock button "Schedule", the right-click menu then reads Schedule as important · Schedule silently · Schedule….
* **Chat header** (`chat/ChatHeader.tsx`): the chat's avatar and two fixed lines (name; who is working – `LiveLine.tsx`
  – or the resting line), then Call and "Chat tabs" (the chat's area, §10). Chat details: members, bridges, notes,
  schedules, message search.
* **Live work in a chat** (B-075; `chat/WorkingMessage.tsx`, `WorkingPopover.tsx`, `RunDisclosure.tsx`,
  `team/run-items.tsx`): the header line, the chat list row, the working popover, the live block (the newest 6 steps,
  "+N earlier steps", the live line) and "Worked … · N steps" above an answer render only from the run's row and its
  meta (§4.2), the same in every window, on linked PCs and on the phone; where this connection may read the run's
  journal (its home PC), "+N earlier steps", a stopped run's steps and the answer's list open the journal instead
  (every step, live while the run runs). The chat does not poll runs; split groups and Team views without the runs
  stream still re-read the items when the agent's live note changes (at most every 2 s, `useRunItems`).
* **Rail** (`shell/Rail.tsx`): My day · Work · Chats · Team; from the bottom: profile (`ProfileMenu.tsx`: the
  companies, "New company", Settings – §3), plan quotas, update. Command palette: Ctrl/Cmd+K.
* **First run** (`ui/onboarding`, AF-002): the setup assistant on My day (`#/home` and `#/day`; elsewhere the status line
  says "Setup is not finished yet." with Continue setup, `setup-reminder.ts`) – "Step n of 4", each step with one
  sentence on what it is for and a Skip: About you (language, name, company; "Connect to my other PC" opens the connect
  card, §8) → Connect an AI (the model setup with its key test; Continue needs a model that answers, "Skip for now" asks
  once) → Connect your tools (the rows of Settings › Apps) → Your first agent (the Manager, optionally one more hire).
  Steps of older versions read as `profile` (`settings/validate.ts`). Start calls `onboarding.start`, which posts one fixed line as the person into the Manager's chat
  (`prompts/onboarding.md`, fallback `onboarding/brief.ts`), an ordinary message wake on the strongest model. B-076
  (owner 05.11.: the 0.3.2 start made the agent stop and ask how far it may go, then wait): the line says what just
  happened ("I just installed Autark, entered <name> and <company> and clicked Start. You are my first AI colleague."),
  what the person hopes for (get to know them and their work – this PC, the web, conversations with other AIs – and get
  going on what matters most) and that the way is the agent's call ("How you go about it, whom you bring onto the team and
  what you ask me is your call"); the browsers' passwords belong in the secrets catalog (exported, imported unread) and
  the models (work, decisions, search by meaning) can likely be better. No "ask me first", no language order (the PC's
  language is a fact in the prompt), nothing to store as a permission; no technical switch stands behind any of it.
* **Spotlight tour** (`ui/tour/spotlight*.ts`, `Spotlight.tsx`, AF-002): after Start the tour goes through the app – a
  modal `<dialog>` dims the window and cuts out one element at a time (SVG mask), with a bubble (progress "n / total",
  1–2 sentences, Skip / Back / Next; → ← Enter Esc; a sheet in the phone layout). Steps hang on `data-tour` names (the
  agreed list in `spotlight-steps.ts` `TOUR_NAMES`) and open their place themselves (a route, the Manager's chat or page,
  the side pane); a step whose element this build lacks is skipped silently. `settings.onboarding.tour` / `tourStep` /
  `hints` keep its state (a tour left part way goes on at the next start); after it was closed or finished, an area opened
  for the first time shows a one-step hint. Settings › General › Getting started (and the palette) show it again and run
  the setup again. The feedback video (`TourPlayer.tsx`) plays only in its dialog now (Settings › Feedback, the palette,
  the tour's feedback step).
* **Rich answers** (`shared/blocks`, `ui/blocks`): agents write Markdown with ```mermaid, ```ui blocks from one catalog
  (`shared/blocks/catalog.ts`; validated forgivingly) and ```app mini-tools that run in sandboxed frames
  (`wf-sandbox://`, a small live-frame budget). Ask blocks become to-dos (§4.3).
* **Look**: `styles/tokens.css` defines every colour; the person's look is `theme.css` (§3).

## 12. Removed on purpose

**Principle**: a capability that was built deliberately stays, in its simplest robust form (video, media and notes
tabs, people, references, the phone, Android control, linked PCs, the week calendar, Duplicate agent – now a skill –,
Send later – now the composer's schedule mode –, splits, the emergency stop, the live view and takeover, schedules, crash
repair). What only held back, judged,
guarded, undid or duplicated is gone, and where a settings screen went, the AI does it through a file, a skill or
`wf call`. Agents may do everything; the person is asked with `human.ask` or a chat message.

* **Gate and judgment**: the guardian, the permission service and modes (Standard/Full autonomy), grants, rules, hard
  stops, money bands and budgets, offers, approvals and the approval park, deny memory, manager review, variant and
  split-lock gates, the remote judge (`runtime/permissions` deleted; RPC `permissions.*`, `approvals.*`); the
  quarantined reader for outside content; per-answer guard calls and the hardening prompt texts ("Do not retry it",
  "not allowed and final" …) – replaced by one self-check line.
* **Self-change machinery**: customize/overlay/Builder agent, `app.change` and change requests, overlay versions and
  revert, plugins and the plugin sandbox, protected-UI guard, safe start, preview windows, `ui.json`, the undo button,
  `settings.get/set` agent tools with approval cards, the settings table as a store, data-folder/workspace/home guards.
* **Brakes and ladders in task work**: the task center (router, route records, subscriptions), competing attempts,
  the never-give-up ladder and escalation, reopen cycles, turn guard, repeat and rate brakes, push brake, failure
  digest ("why failed"), task guards, "Did this happen?" to-dos, dependency graph, urgent-task preemption, reviewer
  variants, org change history and revert, companions, the plan reserve. (B-066: a task's plain `dependsOn` list is
  back – the task waits until those are done –, and competing attempts are a skill.)
* **Background learning layers**: lessons, follow-ups, the preference scan, playbooks, recipes, model outcome ratings,
  the gardener and the old recall/opaque query, the knowledge curator, conflict marks, lineage and freshness, site
  notes, the vocabulary learner. (The context ledger, embeddings and vector search were removed with them on 31.10. by
  mistake – the owner had built them on purpose – and came back in B-064 in simpler forms, §5.3–§5.5. Learned words
  came back in B-066 as the subconscious's `voice.words`, §5.4.)
* **Extra decision and routing layers**: local and hosted decision vendors, the Artificial Analysis and OpenRouter
  feeds, LLM routing classification, plan drain, escalation, model hints. (The engines' native rebuild layer went with
  the ledger and is back with it, §5.5.)
* **Rights and duplicate stores**: the references rights matrix (grants, policies, drafts, briefs, training export,
  withdrawal), the sources corpus and areas, importer parsers (now a skill), notes history and merge, privacy
  forget/inventory/export, agent import and variants, task worktrees and git hooks, chat import.
* **Connectors and skills machinery**: REST-as-app, import ritual, connector catalog and search, `apps.suggest`, tool
  gate classification, the mail send cap, suspicious-text withholding; skill versions, audiences, sharing,
  retirement, update checks; secret access lists and trusted callers.
* **Device rituals**: QR-secret, SPAKE2 and Tailscale pairing paths, connect by name, "Which PC?", phone access requests
  and 6-digit phone invites, phone tiers, the relay phone app, remote consents, audit and remote pause, linked to-dos,
  presence, cross-PC delegation, the phone session gate and phone RPCs, computer-use step judgment. (File transfer
  is back as one tool, `devices.send_file`, B-066; a 6-digit pair code beside the phone QR, B-075, §8.)
* **Voice and media extras**: the Windows System.Speech path, recognizer choice, unsure segments, pronunciation, call
  seats/floor/history/recap, carry, shared frames and loudness lane. (Gemini Live and `media.segments` came back in
  B-066.)
* **Browser extras**: `browser.pick`, linked-PC browser views, permission categories, money/label judgment, batch and
  eval refusals, site files, region text, Select/Give and selection chips, the old toolbars. (A browser per chat,
  history, closed-tab memory, zoom, favicons, the omnibox and Mark a region came back in B-066, §10.)
* **UI**: the composer's permission chip, the notice band, the catch-up digest, the timer chip, the schedule dialog,
  "Learned here", most Settings panels (permissions, approvals, customize, general, apps, knowledge, references,
  recipes, sources, skills, secrets, Android, relay, routing …), the separate Home view, the Plan button, the Team
  activity dashboard, the legacy task form, quick-task overlay, the onboarding Voice card and "Who uses this PC?". The
  harness mode and the 4-switch mode cap. (B-066 brought back settings pages – General, Apps, Skills & memory, Secrets
  among them, §11 – and the work index as a pane panel; the abilities list and the "Automatic" setting went.)
* **Removed by B-062 (01.11.)**: the settings file of differences only (now the whole file with comments); the decision
  model setting, the helper model, per-function models, `workPlan`, the realtime-model key, decision accounts and the
  Artificial Analysis account (one connection form and nine uses instead); the agent budget (`Agent.budget`,
  `monthlyUsd`/`warnAtRatio`, `budget` in `agents.update`) and the "copy of an agent" special cases in hiring; the RPC
  `agents.derive` and `Portability.derive` (a skill instead); the "Send later" dialog (`SendLater.tsx`, `send-later.ts`)
  and the Pause switch in schedule list rows; the setup checklist in every manager turn; the setup-guide reading of
  `workforce-guide` (now `app-guide`); the "first run just ended" onboarding note; every recipe for "set everything up".
* **Removed by B-064 (01.11.)**: the one-call automatic memory of B-062 (`subconscious/memory.ts`,
  `subconscious/memory-passes.ts`, prompt `memory.md`) – the routed flow of §5.4 does that work; the memory tips before a
  turn (one knowledge search injected as text) – the routed flow replaces them; the knowledge table as the
  store of memory (the files of §5.2 are).
* **Removed by B-072 (04.11.)**: the side pane's global/chat switch and the phone's chat workspace sheet (`SpaceCell.tsx`,
  `paneSpace`; each surface now has its own space, §10), the secret pop-ups (`settings/SecretImport.tsx`,
  `chat/composer/SecretCapture.tsx`; the inline band and the composer's secret mode instead, §7.4), the "Pay-per-use
  fallback" row, the plan role hints and "Use in rotation" (the fields stay for the AI, §6), "Auto" as a shown model,
  the tab count cell, greyed Plus/Send entries, and the dead relay phone shell (`scripts/relay-shell.mjs`/`.d.mts`).
* **Removed by B-075 (04.11.)**: the `message.delta` event (a run's text and status are updates of its row, §4.2), the
  chat UI's use of `agent.activity` and the chat's 2 s run refresh (the chat renders from rows; split groups and Team
  views keep the refresh, §11), the shared `'talk'` call id (every call has its own row and id, §9), the phone QR on a
  localhost address (no QR without an address a phone can reach, §8).

**Leftovers still in the tree** (harmless, to remove when their callers go): compatibility stubs and legacy fields
named in their file headers (e.g. `TaskView.route`, `shared/model/browser.ts` device fields); the
device capability vocabulary (`DeviceCapability`, `ui/lib/session.ts` `can()`) although an owner's phone has full
access; the person-variant RPC handlers instead of one membership check; the emptied `settings` table; an old
`<data>/custom` folder on existing installs; the inactive Guard class in `windows-helper.ps1`/`linux_guard.py`;
a deleted agent's `agent:<id>` space
in `side-tabs.json`; some header comments that still name removed modules or only the global and chat spaces; from B-062: "Settings → Models &
accounts" in several error texts (`routing/unfit.ts` and its test, `tools/builtin/accounts.ts`, a few header comments),
`agents.derive` in the header of `patterns/tools.ts`, and the stale `test/ui/ui-tour.mjs`.

## 13. Code conventions

* TypeScript with **erasable syntax only** (no enums, namespaces or parameter properties), ESM, relative imports with
  `.ts`. Node 24 runs the tests directly (`node --test`); esbuild bundles for Electron (`scripts/build.mjs`).
* One concern per file, about 300 lines at most, a short header comment: what the file owns and what it never does
  (`Owns: … Never: …`) – kept current. English identifiers and UI texts.
* Simplicity first: delete before adding; no settings knob the owner did not ask for; no layer that only guards.
* Constructor injection for everything that touches processes, time, network or disk (tests use fakes); no global
  singletons except the composition roots (`runtime/main.ts`, `main/index.ts`, `ui/main.tsx`). Late binding through
  `services: () => RuntimeServices`.
* **Contracts**: service shapes in `runtime/contracts.ts` and `runtime/contracts/*` (later additions by module
  augmentation). The RPC contract: core methods in `shared/api/methods.ts`, every other area in its own
  `shared/api/methods-<area>.ts` (augmenting `Methods`); events in `shared/api/events.ts`. A new method goes into its
  area's part; `test/unit/rpc/s1-table.test.ts` checks that the handler table registers the whole contract once.
* Errors carry codes (`shared/errors.ts`); user-facing text never leaks secrets or raw provider bodies. Secrets only
  as handles.
* UI: data in signals (`ui/lib/store.ts`, kept fresh by events), menus via `lib/context-menu.tsx`, dialogs via
  `lib/dialog.tsx`, headers via `lib/header.tsx`; the layout-stability rules of §11. Every visible change is checked
  in a real window (light, dark, 640×480, phone width) and compared with the design references.
* Import boundaries per layer: `npm run boundaries` (`scripts/check-boundaries.mjs`).
* Docs: this file is kept current with the code; the build history and the open points are internal work notes.

## 14. Where things are

All paths below `code/apps/desktop/src` unless stated.

| Area | Where |
|---|---|
| Composition roots | `runtime/main.ts`, `runtime/compose/*` (services, network, lifecycle, calendar, splits, people, decisions …), `main/desktop.ts`, `ui/main.tsx`, `ui/App.tsx` |
| Service contracts | `runtime/contracts.ts`, `runtime/contracts/*` |
| RPC | contract `shared/api/*`, server `runtime/rpc/server.ts`, scopes `rpc/scopes.ts`, handlers `rpc/handlers/*`, extras `rpc/extras.ts`; client `ui/lib/rpc.ts` |
| HTTP, PWA, push | `runtime/http/*`, `runtime/pwa/*` (`pair-code.ts` the 6-digit code, `urls.ts`), `ui/pwa/*` |
| Data folder and files | `runtime/root/*`, `runtime/settings/*` (`schema.ts` is the one table; `read.ts`, `service.ts`), `runtime/system/paths.ts`, `runtime/agent-core/*`, `runtime/secrets/files.ts`, `runtime/apps/connectors.ts`, `runtime/chat-files/*` |
| Companies | `main/companies.ts`, `runtime/root/companies.ts`, `shared/model/companies.ts`, `runtime/tools/builtin/companies.ts` (`companies.list`, `runCompanyTool`), `runtime/rpc/handlers/companies.ts`, UI `ui/shell/ProfileMenu.tsx`, `assets/installer.nsh` |
| Database | `runtime/db/*` (migrations), `runtime/store/*` |
| Chats | `runtime/chat/*` (a run's row: `streaming.ts`, `live-row.ts`, `publish-message.ts`), `runtime/notes/store.ts`, UI `ui/chat/*` |
| Tasks, ownership | `runtime/tasks/*`, UI `ui/tasks/*` |
| Wakes, scheduler, dispatcher, turns | `runtime/wakes/queue.ts`, `runtime/schedules/*`, `runtime/agents/*`, `runtime/runs/journal.ts` |
| Splits | `runtime/splits/*`, `runtime/git/*`, UI `ui/splits/*` |
| My day, calendar | `runtime/day/*`, `runtime/calendar/*`, UI `ui/day/*` |
| Org, agents, people | `runtime/org/*`, `runtime/people/*`, `runtime/portability/*`, `runtime/patterns/*`, UI `ui/team/*` |
| Prompt and context | `runtime/context/*`, `runtime/modes/*`, `resources/prompts` (incl. `agent-default.md`, `subconscious.md`), `resources/modes` |
| Subconscious (§5.4) | `runtime/subconscious/*` (`flow.ts` the two brains, `tools.ts` their tools, `service.ts` the three kinds of run, `wake.ts` when, `after-turn.ts` the queue, `exchange.ts`, `context-tools.ts`; `verify*.ts`, `widget*.ts` the small side work), `runtime/tools/builtin/subconscious.ts`, `shared/model/subconscious.ts` |
| Transcript by IDs (§5.5) | `runtime/context/ledger/*`, `runtime/contracts/ledger.ts`, `shared/model/context-ledger.ts`, `runtime/tools/builtin/context.ts`, `runtime/agents/rebuild*.ts`, `runtime/engines/{codex,claude}/rebuild*.ts`, `runtime/engines/claude/transcript.ts`, `runtime/engines/trace-text.ts` |
| Vectors (§5.3) | `runtime/vectors/*`, `runtime/contracts/vectors.ts`, `runtime/models/embeddings.ts`, `runtime/tools/builtin/vector-{embed,search}.ts`, `shared/model/vectors.ts` |
| Memory, references, find | `runtime/knowledge/*` (the tree: `memory-tree.ts`, `memory-follow.ts`, `memory-migrate.ts`), `runtime/tools/builtin/memory.ts`, `shared/model/memory.ts`, `runtime/references/*`, `runtime/find/*`, `runtime/work-presence/*` |
| Engines | `runtime/engines/*`, `runtime/mcp/*` |
| Accounts, models, routing, decisions, cost | `runtime/accounts/*` (`legacy.ts`), `runtime/models/*`, `runtime/routing/*` (`uses-settings.ts`, `person-turn.ts`), `runtime/decision/*`, `runtime/spend/*`, `shared/model/{models-uses,providers-connect}.ts`, `resources/model-priors.json` |
| Tools | `runtime/tools/*` (registry, placement incl. `placeCompany`, core sets), `runtime/tools/builtin/*` |
| Connectors, bridges | `runtime/apps/*`, `runtime/bridges/*` |
| Skills, secrets | `runtime/skills/*`, `resources/skills/*`, `runtime/secrets/*` (`export.ts`, `units.ts`), `shared/model/key-values.ts`, UI `ui/settings/SecretRows.tsx`, `ui/settings/secret-catalog.ts` |
| Devices | `runtime/devices/*` (sync: `runtime/devices/sync/*` – `logins.ts`, `blobs.ts`, `file-io.ts`), `runtime/remote/*`, `runtime/phone/*`, `runtime/computer/*`, `runtime/pointers/*`, `code/services/remote-relay`, UI `ui/settings/DevicesGroup.tsx`, `connect-rows.tsx`, `ui/onboarding/ConnectCard.tsx` |
| Voice, calls, media | `ui/lib/dictation.ts`, `shared/voice/*`, `runtime/voice/*`, `runtime/calls/*` (`call-log.ts` a call's row, `wiring.ts` start-up and shutdown), `shared/model/call.ts`, `runtime/media/*`, `main/media-*.ts`, UI `ui/chat/composer/*`, `ui/chat/call/*` |
| Browser | `main/workspace-*.ts` (one shown tab per space `workspace-shown.ts`, preview marks `workspace-marks.ts`), `main/side-driver/*`, `runtime/browser/*`, UI `ui/workspace/*`, `ui/chat/ChatArea.tsx`, `ui/team/AgentBrowser.tsx` |
| Shell, header, menus, settings | `ui/shell/*`, `ui/lib/{header,header-model,context-menu,dialog}.tsx`, `ui/settings/*`, `ui/styles/*`, `main/title-bar.ts` |
| First run, spotlight tour, feedback, repair | `ui/onboarding/*`, `ui/tour/*` (spotlight tour: `ui/tour/spotlight*`), `runtime/onboarding/*`, `ui/feedback/*`, `runtime/feedback/*`, `runtime/repair/*`, `ui/repair/*` |
| Rich answers | `shared/blocks/*`, `ui/blocks/*`, `ui/sandbox/wf.ts` |
| Updates, launcher, tray | `main/updates/*`, `main/updates-wiring.ts`, `main/launcher*.ts`, `main/tray.ts` |
| wf terminal client | `runtime/wf-cli/*`, the agents' shim `runtime/engines/wf-shim.ts` |
| Feedback mailbox and team inbox | `runtime/feedback/*`, `ui/feedback/FeedbackInbox.tsx`, `resources/feedback/{receiver.json,firestore.rules,firebase.json}`; `code/services/feedback` is a retired prototype |
| Release environment | `code/scripts/desktop-release/` (tools and preflight only), `apps/desktop/scripts/package-desktop.mjs`, `scripts/nsis-build.mjs` |
| Native release CI | Public binary repository workflows `release-from-compiled.yml` and `verify-mac-intel.yml`; inputs are a draft tag, compiled ZIP asset and SHA-256, never private TypeScript product sources; native evidence stays in the draft until publication |

## 15. Build, run, test

All commands run in `code/apps/desktop`.

| Goal | Command |
|---|---|
| Bundle everything into `app/` | `npm run build` |
| Start the desktop app | `npx electron .` (demo engine and an isolated profile: `WORKFORCE_FAKE_ENGINE=1 WORKFORCE_TEST_DATA=<dir>`) |
| Headless runtime | `node app/runtime-cli.mjs --data <dir> [--port n] [--fake] [--log] [--peer lan\|tailscale\|off]` – prints `{port, token}` |
| Call the running app | `node app/wf.mjs call <method> '<json>'`, or `POST /rpc` with the bearer token from `<data>/runtime.json` |
| Typecheck per layer, import rules | `npm run typecheck`, `npm run boundaries` |
| Unit tests (4,271; 666 s in the 0.2.9 snapshot, 3,608 s with 4 timing failures at the B-064 check on an overloaded machine) | `npm test`; one area: `node --test "test/unit/<area>/*.test.ts"` |
| Window tests (Electron) | `npm run test:ui` – 48 files, all current (one at a time on a fresh build; `ui-tour.mjs` and `design-tour.mjs` are stale scripts) |
| End-to-end over real WebSocket RPC | `npm run build && npm run test:e2e` – 39 files; three real-provider tests skip themselves |
| Live checks on this PC (opt-in) | `npm run test:live` with `WORKFORCE_LIVE=1` (real browser window, mouse/keyboard; own test pages) |
| Windows package | `npm run package -- --win --x64` (`scripts/package-desktop.mjs`, NSIS) |

`--fake` / `WORKFORCE_FAKE_ENGINE=1` is a strict demo mode: one "Demo engine" account on the deterministic fake engine;
real CLI logins are never detected or used. Typecheck runs in four projects (`tsconfig.shared/runtime/main/ui.json`).
The meeting server
(`code/services/remote-relay`) has its own package, tests and `Dockerfile`; `node scripts/build.mjs --only meet` bundles
it into the app as `app/meet.mjs`. Feedback uses Firestore directly; its runtime, UI and
local mailbox fixture are tested under `apps/desktop/test`. `code/services/feedback` is not deployed or used.
