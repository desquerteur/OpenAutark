---
name: rich-answers
description: I read this when an answer has structure, numbers, options, a process, a deliverable, or needs a human reply. When and how I use mermaid diagrams, ```ui blocks (tables, steps, charts, compare, media, ask blocks) and rare ```app mini-tools in answers, with valid examples.
metadata:
  modes:
    - general
    - manager
    - secretary
    - video
    - web
    - computer
    - research
    - writing
    - social
    - finance
---

# Rich answers

Plain Markdown is the default. I add a block where it is clearly faster to grasp than
text. About three blocks per message at most; one is often best.

## Pick the right form
| Content | Use |
|---|---|
| a single key result or warning | `callout` |
| a plan or "what I did" | `steps` |
| rows of data, open invoices, options with attributes | `table` |
| 2-4 options with pros and cons | `compare` |
| KPIs | `stats` |
| numbers over time or shares | `chart` |
| dates, schedule, history | `timeline` |
| links, results, a gallery | `cards` |
| a finished file | `file`; image/audio/video → `media` |
| long-running work | `progress` with a stable `id` (re-send to update) |
| dependencies, flows, states, org | ```mermaid |
| a pick, a yes/no, a file or a step only the human can give | ask blocks: `choice`, `form`, `checklist`, `timer`, `record`, `upload`, `confirm`, `review` |

`ui` fences contain one JSON object (or an array). Optional on any block: `id` (a later
block with the same `id` replaces it), `title`. Ask blocks also take `why`, `due`,
`important:true`, `todo:true`.

Buttons are quick replies I offer, never a permission I wait for: I carry on with the likeliest
answer meanwhile, and a yes/no is a `choice` with `"options":["Yes","No"]`. An ordinary ask stays
in my message. `important:true` puts the question in the strip above the person's input field and
on their "My day" list – I keep it for what needs their hands, presence, identity, a secret they
hold or their taste; `todo:true` puts it on the list without the strip. A click on my buttons
reaches me as their line with what they picked (a form: one `Label: value` line per field),
a reply to my message – I read it like anything else they write, and so is a line they type as a
reply to that message.

## Examples
```ui
{"type":"steps","title":"Video plan","items":[
 {"title":"Script","status":"done"},
 {"title":"Record intro","text":"Waiting for you","status":"active"},
 {"title":"Edit + captions","status":"todo"},
 {"title":"Publish + comment routine","status":"todo"}]}
```

```ui
{"type":"compare","options":[
 {"name":"Hetzner CX22","pros":["cheap","EU"],"cons":["manual setup"],"facts":["4.5 €/mo"]},
 {"name":"Vercel Hobby","pros":["zero ops"],"cons":["no commercial use"],"pick":true}]}
```

```ui
{"type":"chart","kind":"line","title":"Views per day","x":"day","y":"views",
 "data":[{"day":"Mon","views":120},{"day":"Tue","views":340},{"day":"Wed","views":290}]}
```

```ui
{"type":"table","columns":["Invoice","Client","Due","Amount"],
 "rows":[["2026-031","Nordlicht GmbH","2026-10-30","1,200.00 €"]]}
```

```ui
{"type":"file","path":"C:/Users/me/Workforce/videos/teaser-final.mp4","label":"Teaser (1080p, 0:42)","note":"Loudness -14 LUFS"}
```

```mermaid
flowchart LR
  A[Script] --> B[Record] --> C[Edit] --> D[Publish] --> E[Comments x14d]
```

## Mermaid tips
- Labels ≤ 5 words; ≤ ~15 nodes. `flowchart LR` fits pipelines, `sequenceDiagram`
  who-talks-to-whom, `gantt` schedules, `stateDiagram-v2` states.
- Special characters in labels go in quotes (`A["Upload (v2)"]`).

## The `app` fence (rare)
For when no block fits and an interactive tool really helps (a calculator, a small editor,
a colour picker). It runs sandboxed, offline, without network:
```app title="Split calculator"
<style>body{font-family:system-ui;color:var(--wf-fg)}</style>
<input id="a" type="number" value="100"> / <input id="n" type="number" value="3">
<p id="r"></p>
<script>const f=()=>r.textContent=(a.value/n.value).toFixed(2);a.oninput=n.oninput=f;f();</script>
```
`wf.send(name, data)` sends results back; `wf.complete(data)` finishes a to-do.

### A mini-app as the person's to-do
When something is the person's to do and no ask block covers it (e.g. record a voice-over against the
finished video), I make the app their to-do: `todo=true`, and `reason=` says why only they can do it –
`physical` (presence, recording), `taste` (their decision; the default),
`review` (they look at a result) or `identity` (signature, ID). It appears on their "My day"
list under its `title`, and it is done when the app calls `wf.complete(data)`; the data
reaches me as their line "Done in mini-app" with one `key: value` line each. `permissions=`
asks for the microphone or camera.
```app title="Time the intro" todo=true reason=physical
<p>Read the intro script aloud once and enter how long it took.</p>
<input id="sec" type="number" placeholder="Seconds"> <button id="done">Done</button>
<script>done.onclick=()=>wf.complete({seconds:Number(sec.value)});</script>
```

#### Handing files back
A to-do app can store a recording, image or document with `wf.upload(blob, name)` (audio,
video, images, PDFs and text; up to 100 MB per file and 10 files per app). It resolves to
`{fileId, name, mime, size}`; that goes into `wf.complete(data)`. The file then arrives attached
to their line, with where it is stored. Files the data does not name are
dropped; when it names none, all stored files are handed back. When the host refuses a file
(type, size, a device that cannot store files), `wf.upload` rejects with the reason: the app shows it
and lets the person try again.
```app title="Voice-over" todo=true reason=physical permissions="microphone"
<p>Read the script aloud, listen back, then send the take.</p>
<button id="go">Record</button> <button id="end" disabled>Stop</button> <button id="send" disabled>Send take</button>
<audio id="play" controls hidden></audio>
<p id="out"></p>
<script>
let recorder, parts = [], recording;
go.onclick = async () => {
  recorder = new MediaRecorder(await navigator.mediaDevices.getUserMedia({ audio: true }));
  parts = []; recorder.ondataavailable = (e) => parts.push(e.data);
  recorder.onstop = () => { recording = new Blob(parts, { type: recorder.mimeType }); play.src = URL.createObjectURL(recording); play.hidden = false; send.disabled = false; };
  recorder.start(); end.disabled = false;
};
end.onclick = () => { recorder.stop(); recorder.stream.getTracks().forEach((track) => track.stop()); end.disabled = true; };
send.onclick = async () => {
  send.disabled = true; out.textContent = 'Saving…';
  try { const take = await wf.upload(recording, 'voice-over.webm'); await wf.complete({ take }); out.textContent = 'Sent.'; }
  catch (error) { out.textContent = error.message; send.disabled = false; }
};
</script>
```
Secrets come through secret form fields, not through an app.

## Pitfalls
- Invalid JSON (trailing commas, comments, single quotes) - the block will not render.
- Blocks for trivial content ("a table with one row").
- More than ~8 options in a `choice`; long tables in chat - they go in a file.

## More detail on demand
When my tools include `ui__help` (our `ui.help`), I call it with one topic instead of guessing:
`app` for the full mini-app guide (the `--wf-*` theme variables, one column without inner
scrolling, `wf.state`, `wf.upload`, `permissions=`, `todo=` and `reason=`), `mermaid`, a block type such as
`chart`, `record` or `form` (its props, the answer I receive, an example), or `blocks` for the
list of topics. It only reads the guide; nothing is posted.
