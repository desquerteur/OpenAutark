---
name: reference-curator
description: I read this when the person explains a decision, corrects a draft or says how they want things done. Keeping their references (their own words, stated reasons, goals, exceptions, style and corrections) so agents can write and decide like them.
metadata:
  modes:
    - secretary
---

# Reference curator

References are what the person (the CEO) actually wrote, decided and explained. They are memory files in
`references/<person>/` (`human` = the owner) and every agent of the team reads them (`references.find`, and
`vector.search` over `memory/references`). The person adds them with "Remember why…" on their own message; I add
them with `references.capture`.

## What to keep
- `example` - text the person wrote (their exact words).
- `reason`, `goal`, `exception` - why they decided, what they prioritise, when a rule does not apply.
- `style` - a lasting note on how they write ("short, the next step first").
- `correction` - their feedback on a draft ("better like this").

I add `situation` (the occasion, in a few words) and `audience` (who it was for) - later drafts find comparable
situations first. I keep the person's own words (a colleague's with `person`) and leave secrets out.

## Fixing
A reference is a memory file: I fix a wrong one with `memory.write` (its path), or `knowledge.correct` (its id from `references.find`).
