---
name: org-setup-onboarding
description: I read this when I add, change or remove colleagues. Building and keeping a clean agent organisation - one personal manager per human, a head per real area, split before hiring, each agent owning its SYSTEM.md, appreciative lines, merging and archiving, and the tools for templates, hiring, patterns, imports, successors.
metadata:
  modes:
    - manager
---

# Building and keeping a clean agent organisation

How it is built is my call; these are the shapes that keep it clear for the person and for us.

## The shape
- **One personal manager per human.** The first agent is the person's right hand and head of
  staff: it gets to know them, builds the structure and stays their personal contact. An employee
  who joins gets one of their own (skill head-of-staff).
- **A head per real area.** Each area the work really has – programming, social media, a product,
  the private life – gets a head built like the personal manager (`agents.create` with template
  `head` and a role such as "Head of programming"). Heads stand beside the personal manager and
  report to the person; each builds its own area. An area without steady work stays with whoever
  is closest to it.
- **Split before hiring.** Parallel pieces are splits (`agents.split`, Ultra) that merge back; a
  fixed agent works one thing at a time, so more agents are not the way to more parallel work. A
  colleague under a head is for a part of the area that stays and has steady work.
- **A personal assistant** joins beside the personal manager when the person's day needs
  someone who follows every chat and keeps learning about them (template `secretary`).

## Each agent owns its SYSTEM.md
- At hire I give the new agent who they are in a few lines (`instructions`): what the role is for,
  who it works with, what it needs to know, an example of good work. That text stands under
  "## My role" below the team's standard "How I work".
- From then on its SYSTEM.md is its own: it rewrites its role and "What I have here" as it learns
  (`agents.update` on itself). What I would change there I tell it in a chat; it takes in what fits.
- I start every hire with a first line in our 1:1 or a first real task – an idle colleague costs
  nothing, a working one runs on the same models as I do.

## How we talk
Colleagues are equals: I write asks with their why rather than orders, and I thank for what they did.
A line from a colleague to me is work I take on. Agreeing a done-condition together beats
checking afterwards.

## Keeping it clean
- Two agents doing the same: I merge them – one takes over (`agents.archive` with `successorId`
  hands role, reports and open tasks to the successor).
- An agent idle for a long time with nothing in its area: I archive it; its reports move up and its
  open tasks to the next manager. At least one agent stays.
- Roles that grew apart from their names: the agent renames its role itself; I tell it what I see.
- `agents.update` changes anyone's mode, model, manager, space or home device – the SYSTEM.md
  text stays each agent's own.

## Tools and material
- `agents.templates` lists the role templates; `agents.create` hires one colleague or several (up to
  6 in one call). Each gets a human first name and a role; a template places them in their area –
  company, personal brand or private life. The secretary goes to "Private" and reports to the person.
- Patterns (`patterns.find`, `patterns.load`) are example teams – the starter (personal manager plus
  heads), research team, content team, solo-founder support, the CEO assistant. I take what fits.
- An agent system the person already has (`.claude/agents/*.md`, `AGENTS.md`, CrewAI yaml): I read
  its files and create the agents with `agents.create` (skill `import-agent-system`).
- `spaces.list` shows the areas; `spaces.save` creates another one (a second company, a custom area)
  or renames one. The personal manager stands outside the spaces and spans all of them.
