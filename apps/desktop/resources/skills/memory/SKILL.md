---
name: memory
description: I read this when I want to keep something for later or look for what is already known. It shows how the memory tree works - folders of Markdown files for the company, each branch and each agent, how to write, find, correct, pin and forget entries.
metadata:
  modes:
    - general
    - manager
    - secretary
    - research
    - writing
    - finance
---

# Memory

Memory is plain files in `<data>/memory` (the data folder; `memory.browse` shows it). No list of it ever goes into
anybody's prompt, so it can grow without limit. I open what I need.

## The tree

- `company/` - what the whole company knows. `company/websites/<host>/`, `company/apps/<name>/`, `company/modes/<key>/`
  hold what was learned about a site, an app or a kind of work.
- `branches/<space>/` - what one branch knows.
- `agents/<agent>/` - what one agent keeps for itself. This is where `memory.write` goes by default.
- `references/<person>/` - people's own words, reasons and corrections (skill reference-curator).
- `chats/<chat>/` - notes for one chat only.
- Any topic subfolder I find useful, as deep as it helps: `company/kunden/mueller/`. `_folder.md` says what a folder is for;
  I write one when the name does not say it.
- A file in a `pinned/` subfolder of company, my branch, my own folder or this chat is always in the prompt, together with
  the few skills marked `always` – one set under one cap: a short text stands whole, a long one by its description.
  So a pinned note stays tiny and always relevant.

One entry is one Markdown file:

```
---
title: Rechnung Müller
kind: fact
tags: [kunde]
updated: 2026-11-01T09:30:00.000Z
source: human
valid-to: 2026-12-31T00:00:00.000Z
---

Zahlt per Lastschrift.
```

`kind`: fact, preference, experience, procedure, plan, note. Everything but the text is optional, the description too:
a short note is found by its whole text, and a long one I can give a `description:` line saying when it helps.

## Tools

- `memory.browse {folder}` - a folder: its description, subfolders, newest files.
- `memory.read {path}` - one file.
- `memory.write {folder or path, title, text, description, kind, tags, source, validFrom, validTo}` - creates or updates. The
  same title in a folder updates that file; the old state stays as a version for a while.
- `memory.forget {path}` - deletes a file for good.
- `vector.search {query, in: ["memory/company", "memory/agents/<me>"]}` - finds by meaning. Memory is always embedded: whatever
  is written or edited here is findable at once. I name the folders that fit, or `"memory"` for all of it.
- No embedder available: `vector.search` says so. Then `files.search` over the folder (words) finds it.
- `skills.find {query}` and `knowledge.find {query}` search the whole knowledge catalog – skills, my home project's
  instructions, the public library – by meaning, with two hops, so what lies close to a good hit comes too.

Memory, skills and the public library are one knowledge system: Markdown with a little front matter. What is small and
factual goes to memory; a way of working I read before a kind of work is a skill (skill writing-skills); what helps
everyone outside this company can go public (`library.publish`).

I can also edit the files directly with any tool or editor. The app sees the change and makes it findable.

## What I do

I write memory often and well: after every exchange that taught me something that will still matter in weeks – a fact
about the person or the company, a preference, a decision with its day, a way that worked or failed – I keep it, short,
dated, in the words someone would search for. What I do not write down, the next turn does not know. I search before I
write, so one fact stays in one file. What to keep and how: the skill memory-hygiene.
