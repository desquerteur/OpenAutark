---
name: agent-duplicate
description: I read this when the person or the team menu's "Duplicate…" asks me to duplicate, clone or copy an agent ("Duplicate <name>") - a clone with the same role, mode, SYSTEM.md, skills, model settings and place in the team, under a new first name.
metadata:
  modes:
    - manager
    - general
---

# Duplicate an agent

A duplicate is a clone: I copy the agent's folder and hire the copy with the same fields. No button or method does it -
this skill is the whole feature, so the copy is as good as I make it.

1. **I read the original.** `agents.list` gives id, role, team, manager, space and the PC it works on; `wf call
   agents.get '{"id":"<id>"}'` the rest (mode, skills, `modelPolicy` = effort and model pin, `voice`). Its folder is
   `agents/<id>/` in the data folder (my prompt names it): `SYSTEM.md`, `skills/`, `agent.json`.
2. **I hire the copy** with `agents.create` (the tool, or `wf call agents.create '{…}'` – in Windows PowerShell the params
   go on stdin: `'{…}' | wf call agents.create -`): the original's `role`, `mode`,
   `managerId`, `spaceId` and `device` (its PC's name), and as `instructions` the original's own part of `SYSTEM.md`
   (from "## My role" on, without the role heading and line) with the original's name replaced by the copy's and what a
   second agent needs of its own - its own account, inbox or channel, any standing agreement the person wants
   different. The team's standard comes on top by itself. `name`: the first name the person gave; without one I leave
   it out and the copy gets a free first name. The result shows the copy's `system.path` - its folder is the directory
   around it. From there the copy's SYSTEM.md is its own.
3. **I copy the skills** in a terminal (`cp -r` / `Copy-Item`): the original's `skills/` into the copy's folder, with the
   name replaced there too. `agent.json` stays as the hire wrote it: the original's holds its id, name and home
   project. The app picks the files up within a second.
4. **An own part longer than a hire takes** (8,000 characters): the copy gets the start with the hire, and I tell it in
   our 1:1 where the original's `SYSTEM.md` lies, so it takes in the rest itself.
5. **I carry over the rest** with `agents.update` on the copy: `effort` and `pin`, `voice`, `team`, `home`. The copy
   starts with initials; when the original has a face, the copy gets its own (skill `agent-portrait`) - a portrait of
   its own, not the original's.
6. **Memory, when it should come along:** `wf call knowledge.list '{"scope":"agent","scopeId":"<id>","limit":200}'`, then
   `knowledge.remember` with `scope: "agent"` and `scopeId: "<copy id>"` for each note that still holds.
7. I tell the person in one line who was copied, the copy's name and what differs from the original.

Secrets stay handles (`secret://…`) in every copied file; I write no value. The original's reports, tasks and chats stay
where they are; when the person asks for them too, I hire or add them separately.
