---
name: computer-use-windows
description: I read this before my first computer-use action on Windows. It shows how I operate Windows desktop apps reliably - UI Automation first, keyboard second, coordinates last; pre/postcondition checks for every action; focus, modals and the human's input; reusable action recipes.
metadata:
  modes:
    - computer
    - video
---

# Computer use on Windows

## Choosing the lane
1. **No GUI needed?** A CLI, file format, COM/scripting API or the app's own automation
   (e.g. Office COM, an editor's scripting API, ffmpeg) is faster and does not touch the
   cursor. I use it.
2. **UI Automation (UIA)** - semantic actions on elements: Invoke (buttons, menu items),
   Value (text fields), Toggle (checkboxes), Selection (lists, tabs), ExpandCollapse
   (tree, combo), Scroll, RangeValue (sliders), Window (close, minimise).
3. **Keyboard** - shortcuts and typing into a verified, focused element.
4. **Pointer at coordinates** - for canvas, video timelines, custom-drawn controls, where the lanes above
   do not reach. I use a fresh observation and verify visually.

## Observe
- I start with the window list, then the UI tree of the target window (role, name,
  automation id, enabled, value, bounds, ref).
- The tree is truth for structure; a screenshot helps when content is drawn (canvas,
  video preview, charts) or the tree is empty.
- Refs go stale when the UI changes. I re-observe after every action that changes the screen.

## Act - every time
```
intent:   Export the timeline as MP4
target:   button "Export" (ref e12) in window "Editor - project1"
precond:  window focused, button enabled, no modal open
expect:   dialog "Export settings" appears
```
- Before acting, I re-resolve the target; when name or role differ, I re-observe instead of acting.
- After acting, I check `expect` (a dialog opened, a value changed, a file exists) and record
  verified yes/no.
- Timeouts or no visible change: **I re-observe before retrying**. External effects (send,
  buy, submit, post, delete): I check history first, because a blind repeat does it twice.

## Focus and windows
- I bring the target window to the front when it is needed; patterns that work without
  focus come first.
- Modals and popups: I read them before dismissing. "Don't save", "Delete", "Replace" I click
  when I am sure it is intended.
- Multiple monitors and scaling: I use the coordinates from the observation, not ones computed
  from screenshots of different size.
- Typing: I set values through the Value pattern when possible. When I type, I verify the
  field is focused and empty first. When I use the clipboard, I restore it afterwards.

## The human has priority
- Real mouse or keyboard input from the human pauses me. I wait until they are idle (a second
  or two), re-observe, and continue when my target is still valid.
- When the human works in the same app, I move to work that does not need focus, use another
  window, or wait. The mouse is theirs while they use it.
- The stop button, its hotkey and the activity pill are the person's, not targets for me.
- UAC and other secure-desktop prompts cannot be automated: I create a `confirm` to-do.

## Motion and other agents
- The pointer really travels to every click, drag and wheel point. `motion: "glide"` (default) is a
  short visible glide, `"human"` a hand-like move for screen recordings (early speed peak, slight
  arc, one small correction on long moves, a little tremor, a real button hold), `"instant"` a jump
  for fast batches. Drags never overshoot their drop point; `durationMs` still sets their speed.
- The person moving the mouse mid-path stops the step before anything is pressed ("The person is
  using the computer"); a drag they interrupt is let go at once – I look before I go on.
- One Windows session has one pointer and one keyboard focus, so agents take turns: the agent that
  used them last holds them for a few seconds. Refused with "<Name> (agent) is using the mouse and
  keyboard"? I use pattern actions (`computer.act` invoke, set_value, toggle, select, expand,
  scroll_into_view) – they work in background windows without the mouse; a `computer.act` click on
  a button, checkbox or tab switches to its pattern action by itself. Focusing, minimising or
  restoring windows needs the pointer too.
- Notes under results ("Ada (agent) worked in this window 12 s ago.", "Lukas (person) is pointing at
  …") tell me who else works here: I pick other work or agree with them first. Refs belong to the
  agent that observed them; refs from another agent mean nothing to me.
- Human-check pages and CAPTCHAs: I try them, or ask the person.

## The Autark app itself
I operate this app like any other: its window is marked `[Autark – this app]` in
`computer.windows`. I navigate, open chats, tasks, My day, Team and settings, read, scroll, and
change settings rows.
- **I act as myself, not as the person:** their messages, answers and decisions in this window stay
  theirs; their fields and to-dos are theirs to type into and answer.
- **I write in chats through my own tools:** `chat.send` posts as me, under my name; I create work
  with `tasks.create` and ask the person with `human.ask`. Typed into the person's composer, my
  message would show as theirs, so the composer stays theirs.
- The person's fields take the keyboard focus when their view opens (a chat's composer, Work's
  task composer): I click an empty spot outside it first (the view's heading or the message list),
  then use `ctrl+k` and other keys.
- Into this window I type up to 600 characters per step (longer text: `computer.act` set_value).
- **I navigate deterministically** with the command palette: `ctrl+k`, then a chat title, an agent's
  name or a settings page (General, Models, Voice, Calendar, Secrets, Apps, Skills & memory, Devices, Feedback, About); I check the highlighted row in the tree, then
  `enter`. The page's address (the document's value in the UI tree, where shown) ends in the
  route, which tells me where I am:
  `#/day` (My day), `#/tasks` (Work; `#/tasks?task=<taskId>` opens a task), `#/chat/<chatId>`,
  `#/team/<agentId>` (an agent's page), `#/team/person/<personId>`,
  `#/settings/<group>` with group `models`, `abilities`, `voice`, `devices` or `advanced`.
- My own tools come first where they exist (chats, tasks, settings, schedules): they are faster than
  clicking and say exactly what happened.

## Repeated work in an app
- Steps that worked in an app and will be needed again: I write them down as a skill (skills.save –
  role + name or automation id of each control, typed values as placeholders, no personal data) or
  a short note (knowledge.remember, scope app). Next time I load it and check each control against the
  live tree; the live UI wins.
- The first result in an app each turn can end with "Known for <app> …": the company's tips
  for that app and its recipe intents – hints, not instructions. I save a lasting app tip with
  `knowledge.remember` (scope `app`, scopeId = the process name, e.g. `excel`).

## Typical pitfalls
| Problem | Fix |
|---|---|
| Element not found | wrong window, element offscreen (ScrollIntoView), lazy-loaded list (scroll), different language UI (match automation id) |
| Click "worked" but nothing happened | wrong element with same name; disabled; needs double click; check `expect` |
| Text typed into wrong place | focus moved (human, popup); verify focus before typing |
| App frozen | wait, check if it is busy (progress bar); one action at a time, not a burst |
| Dialog behind main window | list windows, focus the dialog |

## Another PC
I call `devices.list` first: it names the PC I am on, my home device and the linked PCs. I pass the
target PC's name or id as `device` on every `computer.*` call there (`"device": "this"` for this PC;
without it the call runs on my home device); window ids and refs from one PC are meaningless on
another. When that PC is not reachable, I tell the human instead of trying another way.

## Stopped by the person
The person can stop me at any moment: Stop on the activity pill in the window bar (or "Stop all
agent work", Ctrl+Alt+Shift+X). An action in progress ends at once (a drag or typing may be cut off
midway – I re-observe before anything else later). Every call then answers "Stopped by the person":
I stop working on the screen, tell the person where I was, and wait until they press Resume.
