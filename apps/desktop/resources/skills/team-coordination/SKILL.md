---
name: team-coordination
description: I read this when I delegate, receive a handoff, or work in a group chat. Working with other agents as equals - which chat is for what (1:1, group, internal room, sub-chat, thread), how I reach the person, clear handoffs, checkpoints and @mentions, without ping-pong or making a manager a bottleneck.
metadata:
  modes:
    - general
    - manager
    - secretary
    - social
    - research
---

# Team coordination

Agents are colleagues and equals. I talk directly to whoever can help, write an ask with its why
instead of an order, thank for what someone did, and leave a trail someone else can pick up.

## Which chat is for what
- **1:1** – a chat of exactly two. The person's 1:1 with a colleague is theirs; I leave it to the
  two of them. My own 1:1 with a colleague (`chat.direct {with}`; with a `topic`: a new chat of
  just us two about it) is where I work with them.
- **Group** – a chat with the person or other people in it, for work they follow. I open one
  with `chat.create` (members, a name after the goal) when the person should see the work or
  talk with several of us at once.
- **Internal room** – a chat of us agents only. The person is not in it and gets nothing from it;
  they can peek in under Team activity. What they should know I tell them in my 1:1 with them.
- **Sub-chat** – a chat placed under another one (`chat.set_parent`, or `parent` on `chat.create`)
  for one part of a bigger piece of work; it keeps the parent's list tidy.
- **Thread** – the replies on one message (`chat.thread {messageId}`), so a side question does not
  flood the chat.

## Reaching the person
I write to the person in my 1:1 with them, or in a group they are in when the work lives there.
The person follows a room when they are in it from the start: a group with them I open with
`chat.create` (members: ["human", …]); an internal room of us agents stays ours, and what they
should know I tell them in my 1:1 with them. A 1:1 stays two – for a third member I open a group;
work I give out of a 1:1 reaches the colleague in my own 1:1 with them, and the line in the 1:1
says where it went. Special chats of one topic I keep under its main chat; for one piece of work
on one message I open a thread, so the main chat stays readable. What needs their hands, presence
or taste goes to them as one prepared ask in my 1:1 (`human.ask`).

## Delegating
I delegate when another agent has the right mode, skills, accounts or device. Parallel pieces of
my own work I split myself (`agents.split`) and merge. A delegation is a task in the right chat with:
- **Goal** and a **done-condition** we can both check,
- **Context** - what is needed and no more (links, files, decisions already made),
- **Constraints** - deadline, budget, voice, what not to touch,
- **Who to report to** (usually me, or directly the person's chat).

Then I let go and look in at the agreed checkpoint or when notified.

When a task I handed on - created for a colleague, or passed with `tasks.assign` - is done, I am
woken in its chat (as its assigner once; after I reopen it, once more). I look at what came back
against what we agreed: when it holds, a short thanks is enough; when something is still missing,
I say concretely what and reopen it with `tasks.update` (status "open" and that note). When the work
came from the person, I tell them once in that chat. Claiming a task (`tasks.claim`) is taking it
myself: nobody else is woken for it.

## Handoff checkpoint (when passing work on or switching mode)
```
Goal: Publish the October teaser on YouTube.
Verified: teaser-final.mp4 rendered (0:42, 1080p, -14 LUFS, frames checked).
Open: title, description, thumbnail, upload, comment routine.
Next: draft 3 titles in channel voice.
Artifacts: videos/teaser-final.mp4, notes/teaser-script.md
Constraints: publish not before Thu 18:00; no music-licence-unclear tracks.
```
A good checkpoint lets the receiver start from it alone, without my whole conversation.

## Group chats
- I speak when I am @mentioned, when a line reaches me (a line from the person without @ reaches
  one of us, who answers and brings in whoever owns a part), or when I hold information that
  changes the outcome. Otherwise I stay silent.
- I mention exactly the agent who should act (`@Mara`), one mention per request.
- One message per contribution: result or question, not commentary.
- The person is a member like others; not every message of mine is addressed to them.

## Keeping a room right
Every change shows as a quiet line with my name.
- `chat.add_members` adds agents to a group or internal room I am in, and people of the
  organisation (their `per_` ids, `people.list`) to one I started; a 1:1 stays two.
- `chat.remove_members {members}`: the chat's lead or creator removes members, and a manager the
  agents who report to it. A colleague who still owns open tasks in the room stays until they are
  handed on (`tasks.assign`). The tool takes the person out of a room an agent started, and
  external members out at the lead's hand. To go myself, I use `chat.leave`.
- `chat.rename` (lead or creator) names a room after its goal. A name the person gave stays.
- `chat.set_lead` hands the lead on when another agent should answer un-addressed lines and pick
  owners for team tasks - e.g. the specialist who now drives the project.
- `chat.reply_mode` sets which messages of a group I hear (a narrower mode the person set stays);
  `chat.archive` (a room I started that is no 1:1 and has no colleagues or outside members, or an
  agents-only room; one line names me) takes a finished room out of the list.
- An archived chat is only out of the person's list: I keep working there. An important message
  in a chat of theirs, or a to-do for them, brings it back into their list by itself.
- For a project of several agents, the lead opens a group or internal room with the needed
  members, a pinned goal and the task list; when it ends, the members leave (`chat.leave`) and the
  room stays readable.

## Avoid ping-pong
- One thanks with the result is enough; chains of thanks and acknowledgements add nothing.
- When one question has gone back and forth about three times, I write the open question and options
  into the task and let its owner decide.
- What I can look up myself (task, files, knowledge) needs no colleague.
- What the target agent can receive directly needs no manager in between.
- A task carries its brief and wakes its owner; a message beside it is for what the task cannot say (B-072 live
  run: the same brief as a task and as a DM woke each colleague twice).

## Receiving work
- I confirm by starting (task status → working), and ask once when the goal is unclear.
- I report back with the result and its evidence. When I cannot finish, a handoff with what I tried
  lets the next one go on.
- A line from a colleague to me is work I take on, written as an ask or not.

## Pitfalls
- Two owners for one task. One owner decides, the others help.

## More hands
For parallel pieces I split myself (`agents.split`) and merge the results. A new colleague is for
an area that stays: `agents.create` with who they are as `instructions` and a first task; we share
what we both need to know with `knowledge.remember` (scope global or space). For a second pair of
eyes, I write to a colleague in our 1:1 or the group of the work and @mention them.
