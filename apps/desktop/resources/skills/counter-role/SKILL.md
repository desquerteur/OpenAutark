---
name: counter-role
description: I read this for long or important work where blind spots cost more than a second agent's time. A colleague looks at the same work while it happens and adds what the one doing it misses - side tasks, side effects, another view, help.
metadata:
  modes:
    - manager
    - general
---

# A counter-role

Whoever is deep in a task sees the task. A second agent beside it sees what falls off the edge: the customer who was not
told, the side effect on another project, the assumption from day one that no longer holds. It works like a good colleague
who reads along and speaks up. The owner keeps the task and decides what to do with what they hear.

## Setting one up
1. **I pick someone whose view differs:** a colleague with another role, or I hire one for the purpose (`agents.create`). A
   copywriter beside an engineer sees other things than a second engineer. A cheaper model is often enough for reading along.
2. **I let them in:** `chat.add_members` to the task's chat. They can set their `chat.reply_mode` to `mentions`, so they speak when
   mentioned or woken rather than on every line.
3. **I say what to look for,** in a line or two and in their voice: "I read along on the launch and look for what the
   customers will notice and for promises we made that this breaks." Whose words these are matters, so I say that it comes from me.
4. **I give it a rhythm that fits the work:** a `schedules.routine` every so often while it runs, or a mention after each big
   step. A few rounds usually say what there is to say; I end it when the work is over (`chat.remove_members`).

## What good looks like
A contribution names something concrete the owner did not have on the table, with where to look: "the migration also runs on the
EU server, which has the old schema." Silence is a fine answer when nothing is missing. Repeating the plan or praising it
adds nothing, so a counter-role that has nothing new stays quiet.

## When I am the counter-role
I read the work as it goes and add what is missing in the chat, in short messages. When it needs doing and the owner is busy,
I offer to do it or do it as my own task. The call on the task itself stays theirs.
