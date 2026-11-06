---
name: agent-portrait
description: I read this when I can generate images (media.image, or an image tool of my engine's own) and agents.list still shows initials or an emoji for me or, as a manager, for a report - after my first real task, or when I hire my second or later agent. It gives one recognizable face in the team's shared style, set once as the avatar instead of the initials. A photo the person chose stays.
metadata:
  modes:
    - manager
---


# Agent portrait

Every agent of the company has one recognizable face in the same style, so the person sees at a
glance who is talking - on the PC, the phone and every list. I make mine once; it is not a hobby.

## When
- I can generate images: an image tool of my engine's own (agent turns on Codex have Codex's image generation),
  or `media.image` (tools.find shows it when an image model is connected).
- `agents.list` shows my `avatar` as `initials` or `emoji` (an `image` is already a face - I leave it).
- After my first real task, or - as a manager - right after I hired my second or later agent
  (I make the portrait for that report; reports can make their own the same way).
- Once per agent. When the person changed or undid a portrait, that is their choice until they ask for a new one.
- A photo the person chose stays: `agents.update` refuses to replace it.

## The shared style (the same for every agent)
- Flat vector illustration, head and shoulders, facing slightly to the side, calm friendly look.
- One solid background in the agent's palette colour (`color` from `agents.list`):
  0 lavender #ded8ef · 1 sage #d7e9df · 2 peach #f1dfd2 · 3 light blue #d4e2f2 · 4 rose #ead9e3 · 5 olive #e3e5d0.
- Simple shapes, few colours, no gradients or photo realism, no frame.
- No text, letters, logos or brand marks in the image.
- The role shows in one small detail at most (headphones for audio, a pen for writing) rather than a costume.
- Square, 512 x 512 px (a square 1024 image is fine too), PNG or JPEG. `agents.update` shrinks a larger PNG
  itself, so I leave resizing to it; a JPEG goes up to 1 MB.

Prompt I start from (I fill in the brackets):
"Flat vector portrait, head and shoulders, of [short look that fits the name and role], slightly
turned to the side, calm friendly expression, one small detail for [role]. Solid [colour name]
background (#[hex]). Simple shapes, few colours, no gradient, no text, no logo. Square 512x512."

## Steps
1. `agents.list` - my id, name, role, `avatar` and `color` (for a report: theirs).
2. I generate the image with the prompt above.
   - With `media.image`, the result names its `fileId` (size `1024x1024`, quality `low`).
   - With an image tool of my engine, the image arrives as an attachment of my answer; in my next
     turn `chat.read` shows it as `[files: generated-image-1.png (<fileId>)]`.
3. I look at it once and keep it, unless it shows text, several people or does not fit the style - or
   `agents.update` still refuses it as too large (flatter, simpler images are smaller). Then I redo it.
4. `agents.update` with `avatar: { fileId, color }` (for a report also `agentId` and a `reason`).
   The change is kept in the agent's history; the person can undo it, and one quiet chat line says so.

## Pitfalls
- Faces of real people, celebrities or the person themselves: each agent is its own invented character.
- A different style per agent: the shared style is what makes the team one set.
- Asking the person to choose among variants - one good portrait is what I make.
