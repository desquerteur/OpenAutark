---
name: app-data-model
description: I read this when I add a view, a script or an integration. It shows how to build on this app - message and chat formats, RPC and events, connector tokens, uploads, settings, the agent folder, the tabs (the global pane, each chat's area), browsers, and pages (my own views in the app).
metadata:
  modes:
    - none
---

# Building on this app

The app has no plugin system because it needs none: its data are plain files and everything its window can do is one
RPC call. A new channel, a dashboard or a nightly report is a small script or page on these same surfaces. `<data>` is
the folder of `runtime.json`; its `README.md` maps every entry.

## Calling the app
`runtime.json` holds `{port, token}` while the app runs. `POST http://127.0.0.1:<port>/rpc` with
`Authorization: Bearer <token>` and `{"id":1,"method":"…","params":{…}}` answers `{"id":1,"result":…}` or `{"id":1,"error":…}`;
`wf call <method> '<json>'` does the same (in Windows PowerShell the params go on stdin: `'<json>' | wf call <method> -`).
The port changes per start, so I read the file each time.

**What exists:** `wf call rpc.methods` lists every method with its params and who can call it;
`'{"match":"chat"}'` narrows it and spells out the types.

**Events:** `GET /events?topics=chats,chat:<id>,tasks,org,providers,system` with the same header is a stream of
`event: <name>` and `data: <json>` lines, starting with `event: ready`. `message.created` and `message.updated` on
`chat:<id>` are what a bridge follows; a dropped stream is normal when the app restarts, so I listen again after a pause.

## Chats and messages
- `messages.send`: `conversationId`, `body`, and optionally `attachments`, `mentions`, `replyTo`, `priority`, `silent`, `clientId`
  (the same `clientId` again sends nothing twice, so retries are safe).
- A message as events and `messages.list` give it: `id`, `conversationId`, `seq`, `authorId`, `authorKind` (human, agent,
  external, system), `kind` (text, answer, status, task …), `state` (`final` once finished), `silent`, `body`,
  `attachments [{fileId, name, mime, size}]`, `mentions`, `replyTo`, `createdAt`; on `/events` also `author {id, kind, name}`.
  A bridge forwards finals of kind text or answer; the rest is the chat talking to itself.
- `<data>/chats/<title>-<id8>/` is a readable copy: `chat.json` and `messages/YYYY-MM.jsonl`. `chats/README.md` has the
  fields and how to merge two folders of a chat. Reading is the point of it; the database stays the original.

## A way in from outside: the connector token
`wf call chats.connectExternal '{"conversationId":"…","name":"Signal"}'` answers a `token` once. It reaches one chat only:
`messages.send`, `messages.list`, `chats.get`, `files.upload`, `events.subscribe` and `/events` with `chat:<id>`.
With `as: {key, name}` a message posts as a sender behind the connector, who appears as their own member. `rpc.methods`
marks these with `connector: true`.

Sizes it works within: 8000 characters and 5 files a message, 10 messages a minute; `files.upload`
(`{name, mime, dataBase64}`, answers the file with its `id`) 2 MB a file, 10 a minute, 20 MB an hour; a `rate_limited` error
says when to try again. The launch token has none of these: one `POST /rpc` carries up to 6 MB, 600 calls a minute, and larger
files go through `files.uploadChunk`.

Skill `chat-bridge` builds a whole channel from this.

## Settings and agents
- `settings.json`: every setting with its comment; skill `app-settings`. Models and providers: skill `ai-providers`.
- `agents/<id>/`: `SYSTEM.md` (applies at once), `agent.json`, `skills/<name>/SKILL.md`, `last-prompt.md` (what was last sent).
  `agents/README.md` says who is who. `agents.list`, `agents.create`, `agents.update` are the same over RPC.
- Connected tools: `connectors/mcp.json` and `mail.json`; skill `connect-apps`. The look: `theme.css`; skill `app-look`.
- Memory: Markdown in `memory/`; skill `memory`. Skills: `<workspace>/skills`, `agents/<id>/skills`; skill `writing-skills`.

## Browsers and the tab areas
- `side-tabs.json` is the tabs of the global pane at the window's right (`global`) and of each chat's area above its
  messages (`chat:<id>`): `{"version":2,"spaces":{"global":{"shown":"<id>","tabs":[…]},"chat:<id>":{…}}}`.
  I also have my own area on my agent page (`agent:<agent id>`), which I keep myself – e.g. notes or a
  file I want the person to find there; `browser.show` with `where: 'own'` puts a page in it.
  A tab is `{"id":"web-…","url":"…"}` or a panel `{"id":"day","panel":"day"}`. When I edit the file, the window follows.
  With linked CEO PCs every area is the same on all of them and on the phone: a website running on another PC is a
  panel `{"id":"remote:<device>:<web id there>","panel":"remote","device":"<device id>","tab":"<web id there>","url":"…"}`
  (its live picture; closing it closes the page on its PC), and a file, folder or media tab of another PC keeps its form
  with `"device":"<device id>"` (id `file@<device>:<path>`) – it reads and writes there. Without `device` a tab is this PC's.
- Pages in those tabs, with the logins the person made in them: `browser.*` with `where: 'chat'` or `'global'`. My
  own browser is `where: 'own'`; `browser.list`, `browser.subscribe`, `browser.navigate` and `browser.input` watch and steer it over RPC.
- Passwords saved in the person's other browsers come into the secrets catalog through that browser's export and `secrets.import`.

## Pages: my own view in the app
A file `<data>/pages/<name>.html` (or `.js`, a module in an empty page) is at once a row on every tab area's "+" page and opens as a
tab. Editing it reloads the open tab; deleting it removes it. It runs in a frame of its own with `wf` ready:

```html
<!doctype html>
<style>body { font: 14px var(--wf-font); color: var(--wf-fg); }</style>
<h3>Open tasks</h3><ul id="list"></ul>
<script>
  async function draw() {
    const tasks = await wf.rpc('tasks.list', { status: ['open', 'working'] });
    list.replaceChildren(...tasks.map((task) => Object.assign(document.createElement('li'), { textContent: task.title })));
  }
  wf.ready.then(draw);
  wf.listen('task.upserted', draw);
</script>
```

- `wf.rpc(method, params)`: anything from `rpc.methods`, as the window itself; it rejects with the app's message.
- `wf.listen(event, fn)`: the window's events. Chats, tasks, the team, providers and the system are always on; a chat's
  messages come for the chat that is open, and `wf.rpc('events.subscribe', { topics: ['chat:<id>'] })` adds another.
  `wf.state.get()` and `wf.state.set(value)`: a small state kept per page.
  `wf.theme` and CSS variables such as `--wf-fg` follow the app's look; `wf.chart(element, spec)` draws a small chart.
- The frame loads and fetches what it likes, so a chart library from a CDN works, and so does an API that allows other
  origins (the frame's own is opaque). `wf.open(url)` opens a link in a tab of the same area; a plain `<a href>` stays where it is
  and an inner frame shows no website, so a site goes in a tab.
- `side-tabs.json` can open one: `{"id":"page:<name>","panel":"page","name":"<name>"}`. Pages are for the desktop window.

I check a new page by opening it and looking at a screenshot, then tell the person where it is.

## Keep this skill true
When I build something here and find a field or limit missing above, I add it: the next agent starts where I stopped.
