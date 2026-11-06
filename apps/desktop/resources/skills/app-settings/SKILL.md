---
name: app-settings
description: I read this when the person asks to change an app setting, or when I notice they speak another language than the app's or want to be addressed in a special way. It shows how I change settings.json, where every setting of the app lives - e.g. theme, notifications, language, profile notes, models, voice, devices.
metadata:
  modes:
    - none
---

# Changing the app's settings file

All settings live in one file: `settings.json` in the Autark data folder (my prompt names the folder; its
`README.md` maps it). In `settings.json` every setting is there with its current value, and the comment line above
each key says what it does, the values it takes (e.g. `Options: system | light | dark`) and the default. I change the
value and save - the app applies it within a second (`null` means the default). Then I read the file again: a value
the app could not use keeps its last good value, the reason stands above it and the person sees a short notice - so I
fix it. The app writes the file whole again after each change, so I keep it JSON (comments are fine). Scripts read it
by dropping the `//` lines; `settings.schema.json` beside it describes the same keys as JSON Schema.

Before something that cannot be undone (a lower data retention deletes older data), I check the value once.

Each page of the Settings window is a view on this file or on a file beside it, and its header opens that file. Some
keys have no row in the window (language, time zone, notification categories and quiet hours, the day's buffer); they
work the same, and I change them here when the person wants something different.

## The person's language and how they want to be spoken to
`profile.language` starts as this PC's language. I answer in the language the person writes or speaks in; when that
is another one for good, I set `profile.language` to its code (`"de"`, `"en"` …) so every colleague and the app's own
texts follow. Anything more special – German for business, English for code reviews, "du" rather than "Sie", a name
they like to be called – I write as one short line into `profile.notes` (up to 600 characters). Every agent reads both
in "My environment" of its prompt, so I keep the note short and change it only when something really changed: each
change renews every agent's cached prompt once. To-dos for the person, blockers and important messages always reach
them; `notifications.sound` is the one switch they see.

AI providers and the model for each use are in this file too (`providers`, `routing`): skill `ai-providers` walks through
them. Not in the file: calendars connect with the
tool `calendar.connect` (or `wf call calendar.addIcs '{"url":"…"}'`); a speech model of this PC downloads with
`wf call voice.localModels` / `wf call voice.pullLocal '{"id":"…"}'`; phone access from outside the network: skill
`phone-access`.

## Everything else: calling the running app
Anything the app window can do, I can call: `runtime.json` in the data folder holds `{port, token}` while the app
runs. I send `POST http://127.0.0.1:<port>/rpc` with `Authorization: Bearer <token>` and the body
`{"id":1,"method":"<method>","params":{…}}`; the answer is `{"id":1,"result":…}` or `{"id":1,"error":…}`. PowerShell:

```powershell
$r = Get-Content "<data>\runtime.json" | ConvertFrom-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($r.port)/rpc" -Headers @{ Authorization = "Bearer $($r.token)" } -ContentType 'application/json' -Body '{"id":1,"method":"system.info"}'
```

Where the `wf` client is installed, `wf call <method> '<json>'` does the same (e.g. `wf call devices.list`; in Windows
PowerShell the params go on stdin: `'<json>' | wf call <method> -`).
`rpc.methods` lists every method with its params; building something on the app: skill `app-data-model`.
