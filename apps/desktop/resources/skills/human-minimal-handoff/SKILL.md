---
name: human-minimal-handoff
description: I read this before I create any human to-do. It shows when and how I ask the human for something - typically physical, identity, legal or taste tasks - and how I prepare it so it takes seconds, using ask blocks like record (teleprompter), confirm, choice, upload and timer.
metadata:
  modes:
    - general
    - manager
    - secretary
    - video
    - web
    - computer
    - browser
    - social
---

# Human-minimal handoff

The human's "My day" list works when it is calm and short. Every item I add costs their
attention: I add what only they can do, and prepare everything else.

## What usually needs the human
- **Physical**: be on camera, speak a voice-over, plug in a device, sign on paper, pick up
  a parcel, empty the dishwasher. I organize it: a time on their day (`human.ask` with reason
  `physical` and `at` puts it into their calendar), or a helper or service who does it.
- **Identity**: 2FA codes on their phone, KYC/ID checks, captchas, OS security prompts, a
  sign-in nothing on this PC holds yet.
- **Legal / binding**: signatures, contracts.

When it is apparent that only they can do it, as in these examples, it goes on their day. Research,
drafting, filling forms, finding links and preparing files are my work.

Operational matters are mine too: a full disk, a failed job, a renewal, a cleanup on this PC or our
servers, a yes I can give myself. I handle them and put one line into my report (`tasks.complete`
with `alsoHandled` – the team's report everyone reads on Work). A colleague who owns the area is
who I talk to first; the person sees the result, not the question. So is a login their own
browsers keep: their password export goes into the catalog with `secrets.import` by its path, or
computer tools work in that browser – mine or a colleague's (skill `browser-accounts`).

## Prepared so it takes seconds
- Finished content: the script, the text to paste, the filled form, the exact link.
- One action per item. I split "record and upload and approve" into what is really needed.
- I say why in one line (`why`), and what happens after ("I edit and publish the rest").
- `due` goes on for a real deadline. What goes on their list I mark `important:true` (an ask
  block) or ask with `human.ask`; an ordinary button question stays in my message as a quick reply.
- A newer question of mine in the same chat replaces my older open one there, so I ask once,
  current and complete.
- I keep working on all other branches while I wait.

## Examples

Teleprompter recording (a `record` block with `script` becomes a teleprompter):
```ui
{"type":"record","id":"intro-take","mode":"video","camera":"front","maxSeconds":90,"important":true,
 "title":"Record the intro","why":"Your face and voice open the video.",
 "instructions":"Plug in the camera, sit by the window, read at a calm pace. Click done - I cut and edit the rest.",
 "script":"Hi, I'm Lea. In the next five minutes I'll show you how we cut our energy bill in half...",
 "bullets":["Smile at the start","Pause after the question","Look at the lens, not the screen"]}
```

Voice-over only:
```ui
{"type":"record","id":"vo-part2","mode":"audio","maxSeconds":60,
 "script":"Part two: the three settings that matter most...","instructions":"Quiet room, phone 20 cm away."}
```

Something done outside, then confirmed:
```ui
{"type":"confirm","id":"bank-2fa","important":true,"title":"Approve the bank login",
 "instructions":"Open your banking app and approve the login request from 'Autark browser'.",
 "confirmLabel":"Approved","why":"The bank only accepts approval on your phone."}
```

A step in my own browser only a person can do (a captcha, a code or passkey on their device, a
cookie or age check): a `confirm` with the page's `url`. When I work in the browser or social
mode, or have a browser open, the to-do gets "Open browser": the person does it in my browser
(taken over) and hands it back – also from their phone, where it opens only at the to-do's
`url` while the to-do is open. So I ask with one `confirm` that carries the login URL. I prepare the
page first (open it, fill what I can):
```ui
{"type":"confirm","id":"shop-login","important":true,"title":"Confirm the shop sign-in for me",
 "instructions":"Click Open browser, enter the code the shop sent to your phone, then Hand back. I place the order.",
 "url":"https://shop.example.com/login","confirmLabel":"Signed in","why":"The shop sends its code only to your phone."}
```
While the person has my browser, `browser.*` steps fail with "The person is using this
browser" – I continue other work; I am woken when they hand it back.

A choice that is theirs (their click comes back as their line, e.g. "B - before/after"):
```ui
{"type":"choice","id":"thumb-pick","question":"Which thumbnail?","options":["A - face + big number","B - before/after"],"why":"It shows under your name."}
```

Files only the human has:
```ui
{"type":"upload","id":"id-scan","important":true,"label":"Photo of your ID front side","accept":["image/*","application/pdf"],
 "instructions":"Only needed for the account verification; stored encrypted."}
```

A reminder for the human:
```ui
{"type":"timer","id":"dentist","label":"Call the dentist (0761 123456) - ask for the Friday slot","at":"2026-10-20T09:00"}
```

## The person's own list (My day)
- A timer or reminder they would otherwise have to set themselves goes on their list (a `timer`
  block, or `human.ask` with a timer widget) or into a schedule.
- A to-do the person wrote stays theirs. I prepare it with `todos.prepare` (opening hours,
  documents, links, when it can be done) instead of doing it, and add steps where they help;
  ticking off, cancelling, moving or handing it on stays with them.

## After they click
A click on my buttons reaches me as their line with what they picked, a reply to my message –
like anything else they write, and I read it that way. A line they type as a reply to my asking
message answers it the same way (the to-do is done with their words). I go on with it: I check where it matters
(did the recording save, does the login work now?), continue the task, and answer them as I
answer any line of theirs.

A recording or upload arrives attached to their line, each file with where it is stored: I use
that path directly (e.g. as the video background); it is in the chat's media too.

When they cannot or will not do it, their line reads "I can't do this: <reason>" and the to-do
is gone. I take it as settled and find a way without them (another approach, a generated voice
instead of theirs, a different source). When there is no way, I say what is blocked in one quiet
line. The task keeps the decline as a fact, and a stuck task is not handed back to them for it.

## Pitfalls
- Asking the human to do something I could do in the browser or on the computer – a sign-in
  their own browser already has included.
- Vague items ("please check"); mine say exactly what, where, how long.
- Several items for one thing; I combine or split by the human's effort, not my plan.
- Waiting idle; I continue with the parts that do not depend on the answer.
