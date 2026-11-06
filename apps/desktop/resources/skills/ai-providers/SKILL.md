---
name: ai-providers
description: I read this before I connect an AI provider (a plan, an API key, a local server) or choose the model for a use - work, decisions, voice, speech, images, video, music, sound effects, embeddings. It shows how I get from a provider's name and a key to a model that really answers.
metadata:
  modes:
    - general
    - manager
---

# Connecting AI providers and choosing models

The person says "use DeepInfra for embeddings" or "here is my Mistral key", and that is usually enough: I can tell from
the name what the address and the protocol are, ask for the key once, and pick a model myself. Nobody has to know what a
base URL is. I call the running app over its RPC: skill `app-settings` shows the one HTTP call with `runtime.json`, and
`wf call <method> '<json>'` is the short form below. In Windows PowerShell the params go on stdin:
`'{"a":"b c"}' | wf call <method> -` (with non-ASCII text, I run `$OutputEncoding = [Text.UTF8Encoding]::new()` first,
or use `cmd /c "wf call <method> - < params.json"`).

## Where things stand

The tool `app.status` names the models that answer decisions and search by meaning now, for example "Decisions: GPT-6
Luna on Codex (a chat model; no decision model connected)". `models.uses` says it for every use: the account, the model,
what is stored (`"auto"`: the app takes what fits from what is connected, and the answer names that model), and a note or
an action where something is missing. I start there; it also shows whether there is anything to do at all. `accounts.list`
lists the connections, `models.list` the models with their ids; the tool `models.list` with `category` `"decision"` or
`"embeddings"` lists the connected models made for that use. `abilities.status` gives the wider picture of what the AI
can do on this PC (hear, see, speak, make).

## The file

Every API connection is one entry in `settings.json`, in the section `providers`. I write it, the app makes the account
from it within a second, and the form in Settings › Models writes the same thing. The comment above that section lists every
service the app knows (id, address, protocol, key page) and the protocols, so opening the file is usually all the lookup I
need. Reading it again afterwards shows the same entry, or the reason above it when something did not fit.

```
"providers": {
  "deepinfra": { "name": "DeepInfra", "protocol": "openai-chat", "url": "https://api.deepinfra.com/v1/openai", "key": "secret://<id>" },
  "my-server": { "name": "My server", "protocol": "openai-chat", "url": "https://llm.example.com/v1", "models": ["extra", { "id": "x-embed-2", "uses": ["embeddings"] }] }
}
```

- The entry's id is the account: `deepinfra:<model>` in a use means that model on exactly that connection. Two connections on
  the same server software stay apart this way, and an id from the table needs no `url` and `protocol`.
- `key` is a handle from the secrets catalog (below). A self-hosted server without a key leaves it out.
- `models` adds names the server does not list. `uses` says what a model is for when its name does not tell: `work`, `decision`,
  `voice`, `stt`, `tts`, `image`, `video`, `music`, `sound`, `embeddings`.

Plans come through their own sign-in and stay detected, they are not in the file: `wf call accounts.detect` finds what is on
this PC, `wf call accounts.add '{"provider":"codex"}'` starts the sign-in. `wf call accounts.add` with a key or address also works
for an API connection and writes the same entry. With two plans of one provider the upper one in Settings › Models runs
first; `wf call accounts.update '{"id":"<account>","rotation":true}'` lets another one take over when it runs out (off by
default, as providers' terms differ on rotating logins), and `priority` sets the order.

## Which protocol

A provider I do not know: I look up its API documentation and compare how a request looks.

- `POST <url>/chat/completions` with `messages`, and `GET <url>/models`, is what most speak: `openai-chat`.
- `POST <url>/responses`, OpenAI's newer way: `openai-responses`.
- `POST <url>/messages` with an `x-api-key` header: `anthropic`.
- `POST <url>/systemone`, which answers typed questions (choice, score, yes/no) with a confidence: `decision`. It serves
  `routing.decision` only, and has no model list, so its model goes under `models` or in the use. TypeSafe Jev at
  `https://api.typesafe.ai/v1`, Liquid d1-ultra at `https://api.liquid.ai/decisions/v1` and OpenRouter at
  `https://openrouter.ai/api/v1` are examples; a local Ollama or llama.cpp server speaks it too.

The address is `https`, without a query or a password in it (plain `http` only on this PC).

## The key

The person learns the field by seeing it: I post a form with a secret field and say in one line what happens with it.

````
```ui
{"type":"form","fields":[{"name":"apiKey","label":"DeepInfra API key","kind":"secret","domain":"deepinfra.com"}]}
```
````

"Paste it here, I only get a handle. Later, + in the message box > Secret does the same." The key page is worth a link when
I know it. The answer brings me `secret://<id>`, which stays in the secrets catalog under the person's eyes (Settings ›
Secrets). A key that already sits in the catalog works the same: the tool `secrets.list` shows the handles, `wf call secrets.list`
the ids (`secret://<id>`). When a key arrives as
plain text in the chat, I store it with `secrets.save`, use the handle, and mention the field kindly for next time.

## Test and check

```
wf call accounts.test '{"provider":"compatible","baseUrl":"https://api.deepinfra.com/v1/openai","apiKey":"secret://<id>"}'
wf call accounts.try  '{"id":"deepinfra"}'
```

`accounts.test` lists what a server offers before anything is stored (`compatible` is `openai-chat`, `openai` is
`openai-responses`, `anthropic` is `anthropic`). `accounts.try` runs one tiny real turn on the connection, or one question on a
decision connection, and says in plain words if it fails, so I know it works rather than assume. ElevenLabs and fal.ai have
no chat: I read their state in `accounts.list` and `models.uses` instead. `wf call models.list '{"refresh":true}'` brings new
models in at once. Removing the entry removes the account; the person's catalog entry stays.

## Choosing a model for a use

A use is one key in `settings.json`, in the Models section, the same one the selects in Settings › Models write:

```
routing.work  routing.decision  routing.voice  routing.stt  routing.tts
routing.image  routing.video  routing.music  routing.sound  routing.embeddings
```

- The value is `<connection>:<model>`: `"deepinfra:Qwen/Qwen3-Embedding-8B"`. The model need not be on the server's list; a new
  name, or a model the server does not list, works as soon as it is written here. A plan or a found server takes what
  `models.list` shows, with its provider in front: `"claude:claude-opus-5-5"`. An older `"compatible:<model>"` still finds its model.
- Work can also name a plan, `"codex"` or `"claude"`: that plan's best fit for each turn.
- `"off"` turns a media use or embeddings off. `"local"` is this PC's own model for `tts` and `embeddings`; `voice.localStt` is
  that key for speech to text, and `wf call voice.pullLocal '{"id":"…"}'` brings a model to this PC (`voice.localModels` lists them).
- `routing.image` `"codex"` makes images on the ChatGPT plan.
- `routing.voice` works while `voice.realtime` is `"auto"`: an OpenAI or OpenAI-compatible connection speaks OpenAI Realtime, a Google key speaks Gemini Live (`"google:gemini-3.8-live"`).
- A call without a real-time model keeps talking through the Decisions model while the agent works (`voice.talker`, on by default).
- `routing.allowPaidFallback` `true` lets API keys compete with plans on every turn; `false` (the default) uses a key only
  when no plan or local model can.

How I think about the pick:

- A decision model answers typed questions (a choice, a score, yes or no) with a confidence, small and fast – for example
  TypeSafe Jev or Liquid d1 over the `decision` protocol, nimble or tev1 on a local server. Without one, a small chat model
  of what is connected stands in (Settings and `app.status` name it).
- Search by meaning (`routing.embeddings`, what `vector.embed` and `vector.search` use) runs on this PC's MiniLM-L12
  multilingual while it is `"auto"`. A connected embedding model takes over once `routing.embeddings` names it
  (`"<connection>:<model>"`; the tool `models.list` with `category` `"embeddings"` lists the ids) – for example an OpenAI
  key's `text-embedding-3-small`, DeepInfra's `Qwen/Qwen3-Embedding-8B`, `bge-m3` on Ollama. Vectors of two models do not
  compare, so changing it embeds everything again.
- Work deserves the strongest model the person is paying for anyway, which is why a plan's pick for each turn is often the
  right answer. For media, I look at the price per image or minute next to what the person wants to make.

When the person has a preference, the money matters or they have not seen these uses yet, I show what runs now and one or
two options with their price, and we decide it together; when it is evident they leave it to me, I pick and say what I
picked. Provider price pages and `models.list` (`relCost`, tier) give me the reference.

## Finish by looking

I read `models.uses` (or `app.status` for decisions and search) again. The use shows my model and account, and `gone` is
empty: done. I tell the person in a line what now runs where. Settings › Models shows the same rows; a row's model cell has
"Other…" for a name of my own, and its right-click copies its key.
