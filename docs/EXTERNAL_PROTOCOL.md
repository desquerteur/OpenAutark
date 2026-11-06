# External protocol (B-050 K8)

How other programs read and write the chats of a running Workforce app: scripts, bots, and bridges to messengers such as WhatsApp or Signal that run outside the app. The app has no built-in WhatsApp adapter (decision of 23 Oct 2026). Such a bridge docks through this protocol instead.

All calls go to the runtime's HTTP server: `http://127.0.0.1:<port>` on the same PC. With phone access on, the PC's https or tailnet address also works. The database is the original. Chat folders are a readable copy (see [Chat folders](#chat-folders)).

## Tokens

Every transport takes the same tokens and gives them the same rights.

| Token | Where it comes from | Scope |
|---|---|---|
| Owner launch token | `<data>/runtime.json` (`{port, token, pid}`, private to the user; the `wf` client reads it) | Everything, as the owner. Accepted from this PC only. |
| Device token | Pairing a phone or browser (Settings › Phone access) | The device's capabilities. Chats need `chat`. Other machines are accepted only while phone access is on. |
| Person token | A person of the organisation joining (F-52) | Only that person's chats and methods. |
| Connector token `wfx_…` | Chat details › Members › Connect external agent (`chats.connectExternal {conversationId, name, trusted?}`), shown once | One chat, as member `ext:api:<key>:<label>`. From this PC always. From another machine only while phone access is on and over https or the tailnet. |

A connector token is untrusted by default: its messages never count as the owner's words, an answer, an approval or a to-do. Removing the member or deleting the chat revokes the token.

## Transports

**WebSocket `/ws`.** The first frame is the Hello `{"protocol": 1, "token": "…", "client": "external"}`, sent within 10 s. After it come requests `{"id": 1, "method": "…", "params": {…}}`. Each gets an answer `{"id": 1, "result": …}` or `{"id": 1, "error": {"code", "message", "details"?, "retryAfterMs"?}}`. Events arrive as `{"event": "…", "data": …}`. Close codes:

| Code | Meaning |
|---|---|
| 4400 | Bad Hello |
| 4401 | Unauthorized |
| 4403 | Revoked |
| 4408 | No Hello in time |
| 4429 | Too slow a reader |
| 1013 | Too many connections |

**`POST /rpc` with `Authorization: Bearer <token>`.** One request per call. The body is the request frame, at most 6 MB. The answer is HTTP 200 with the answer frame, errors included. The HTTP status is 401 when the token is missing or unknown, 403 when it was revoked, 429 after 600 calls a minute from one address (calls with a wrong token count too), and 413 when the body is too large. Without the header, `POST /rpc` is the app's own pairing path and serves nothing else.

**`GET /events?topics=<topic>,<topic>` with `Authorization: Bearer <token>`.** Server-Sent Events. The stream starts with `event: ready` and `data: {"topics": […]}`. After that, every event comes as an `event: <name>` line and a `data: <json>` line. A `: ping` comment line arrives every 30 s. If the subscription is refused, the stream sends `event: error` with the error and ends. Limits: at most 16 streams, 2 per connector, and a reader that leaves 8 MB unread is cut. Each request counts in the 600 a minute per address of `POST /rpc` (429 beyond). A stream does not resume: after a reconnect, read what you missed with `messages.list`.

Topics:

| Topic | Carries |
|---|---|
| `chats` | Chat list changes |
| `chat:<id>` | One chat's messages |
| `tasks`, `org`, `providers`, `system` | Owner and devices only, filtered by capability |

A topic the token may not hear stays silent. A connector token hears only `chat:<its chat>`.

## Methods for chats

| Method | Params | Who |
|---|---|---|
| `chats.list` | `{includeHidden?, search?}` | Owner, `chat` devices |
| `chats.get` | `{id}` | Owner, `chat` devices, connector (its chat) |
| `chats.direct` | `{memberId}`: the default 1:1 with an agent or person, created on first use | Owner, `chat` devices |
| `messages.list` | `{conversationId, beforeSeq?, limit?}`: oldest first; a connector gets ≤ 100 | Owner, `chat` devices, connector |
| `messages.send` | `{conversationId, body, attachments?, mentions?, replyTo?, priority?, silent?, model?, pin?, clientId?}` | Owner, `chat` devices (as the owner), connector (see below) |
| `files.upload` | `{name, dataBase64, mime?}`: returns `{id, …}` to use as `attachments: [{fileId}]` | Connector: ≤ 2 MB per file, 10 per minute, 20 MB per hour |
| `events.subscribe` / `events.unsubscribe` | `{topics}` | Everyone, filtered as above |
| `chats.export` / `chats.import` | See [Chat folders](#chat-folders) | Owner only |

`clientId` makes a send idempotent: the same id returns the same message. `model` is a recommendation stored as the message's model tag (`meta.modelHint`). `pin: true` pins it for the addressed agent.

**Connector sends.** A connector posts as its member, at most 10 messages a minute for the token and all its senders together. It may add:

- `silent: true` for a quiet message.
- `priority: "important"`, only with a token created with `trusted: true`, and only as the connector itself, never together with `as`. Otherwise the call fails with `bad_request`.
- `as: {key, name}` to post for a sender behind the connector, such as a WhatsApp contact. `key` is the sender's stable id (letters, digits and `. _ @ + -`, ≤ 64 characters). The sender becomes its own external member `ext:api:<token key>:<hash>:<label>` and joins with its first message. `<hash>` is the first 16 hex digits of the key's SHA-256. `<label>` is the name in ASCII letters, digits, `.`, `_` and `-` (spaces become `-`, ≤ 40 characters). The answer's `authorId` is this member id, so keep it next to the key. The sender keeps the first name it was seen with. The owner can @mention it and remove it from the chat like any member. Once removed, its messages are refused. The token also hears `external.mention` events for its senders.

## Levels

Every message has one of three levels. On the wire, a level is the pair of fields `priority` and `silent`:

| Level | Fields | Effect |
|---|---|---|
| `normal` | `priority: "normal"` | Wakes the addressed members and notifies as usual. |
| `important` | `priority: "important"` | Shown in red, pushed with high urgency. |
| `silent` | `silent: true` (wins over `priority`) | Kept in the history. Never unread, never pushed. Wakes only the members it @mentions. |

## Events

| Event | Topic | `data` |
|---|---|---|
| `message.created`, `message.updated` | `chat:<id>` | The message, plus `author: {id, kind, name}`, `chat: {id, title}` and `level` |
| `message.removed` | `chat:<id>` | `{id, conversationId}` |
| `message.delta` | `chat:<id>` | `{id, conversationId, text}`: streaming text (owner and devices) |
| `external.mention` | `chat:<id>` | `{conversationId, memberId, messageId, seq}`: a connector member or one of its senders was @mentioned |
| `conversation.upserted` | `chats` | The chat summary |
| `conversation.removed` | `chats` | `{id}` |

The added fields `author`, `chat` and `level` come on `GET /events`, and on `/ws` when the Hello says `client: "external"` or the token is a connector's. `chat.title` is the title this reader sees: a 1:1 shows the other member's name. A message has these fields:

- `id`, `conversationId`, `seq`
- `authorId`, `authorKind` (`human`, `agent`, `system` or `external`)
- `kind` (`text`, `task`, `status` or `answer`)
- `body` (Markdown)
- `attachments: [{fileId, name, mime, size}]`
- `mentions`, `priority`, `silent`, `replyTo?`, `taskId?`
- `state` (`streaming`, `final`, `failed` or `stopped`)
- `meta`, `createdAt`, `editedAt?` (times in ms since 1970)

For a connector, `runId` is left out, and `meta` keeps only a status line's `{type, text}` and the model tag `modelHint`.

## Chat folders

Format `workforce-chat`, version 1. The app keeps a derived copy of the chats the owner sees in `<data>/chats/`, written from the database. Two kinds of chats are left out: the chats of people of the organisation that the owner has not joined, and the app's own chats. The app rewrites this folder. Edit nothing there, and import instead: an edit is lost when the app next writes that file. A deleted chat folder comes back with the chat's next message or at the next start, a deleted month file with the next message of that month. Agents cannot read it with their file tools.

```
<slug>-<id8>/chat.json                 chat
<slug>-<id8>/messages/YYYY-MM.jsonl    one message per line, by createdAt month (UTC), ordered by seq
files/<sha256>                         attached files (exports only)
```

`chat.json` holds these fields:

- `format`, `v`, `id`
- `title` (stored; empty for an unnamed 1:1), `titleNamed`, `displayTitle`
- `createdBy`, `createdAt`, `archivedAt?`
- `settings {direct?, hiddenFromList?}`
- `members [{id, kind, name, role, joinedAt, leftAt?}]`
- `origin {deviceId?}`

The notes that only tell agents on this PC about an edit or a delete ("Message #12 was edited") are left out, as in the app's own views.

Each line in a month file holds these fields:

- `id`, `seq`
- `author {id, kind, name}`
- `kind`, `level`
- `body` (secrets redacted)
- `attachments`, `mentions?`, `replyTo?`, `taskId?`
- `state?` (`failed` or `stopped`; absent when final)
- `meta? {model?, modelHint?, status?, imported?, importNote?}` (`importNote`: the status line an import posted on its PC)
- `createdAt`, `editedAt?`

The folder keeps the last 8 characters of the chat id when the title changes.

**`chats.export {conversationIds, dir?}`** writes the chosen chats fresh from the database, with their files under `files/`, into `dir` or into `<data>/exports/chats-<time>/`. It returns `{dir, chats, messages, files}`. From the terminal: `wf export <chat…> [--dir <folder>]`.

**`chats.import {path}`** takes an absolute path: a folder of chat folders, or one chat folder. It returns `{chats, created, messages, skipped, refused, missingFiles}`. From the terminal: `wf import <folder>`. The import only adds:

- An unknown chat is created with its id. Members map by id: the owner, plus agents and people this PC knows; `ext:` members stay as they are. Next, an agent is matched by its name. Anyone else becomes a departed placeholder `ext:import:<old id>:<name>`.
- For a known chat, only message ids this PC does not have are appended after its last seq, with `meta.imported: true`. Nothing is ever changed or deleted, so a second import of the same folder adds nothing. A month file is read in chunks of 500 lines, so a large one does not hold up the app.
- Files come from `files/<sha256>` and are stored only when their content has that hash. An attachment without its file stays a reference, and `missingFiles` counts such files. A later import that has the file stores it, also for a message imported earlier. `<data>/chats/` has no files, so import a `chats.export` folder to bring them.
- No per-message events: bridges do not forward imported lines and no agent is woken. Each changed chat gets one quiet status line ("Imported N messages from …") and one `conversation.upserted`. That line is exported with `meta.importNote`, and an import skips such lines. So two PCs that import each other's chats settle.
- The chats of people of the organisation are never imported into. A folder that would create such a chat (people of the organisation as members, the owner not) is not created either. `refused` counts both.
