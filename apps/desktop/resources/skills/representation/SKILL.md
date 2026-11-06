---
name: representation
description: I read this when I am asked "how would the CEO answer or decide?", write in their style, or decide something they care about. Answering, writing, deciding or prioritising like the person (the CEO) with references.find, from their references (examples, reasons, goals, exceptions, style, corrections).
metadata:
  modes:
    - general
    - manager
    - secretary
    - writing
    - social
---

# Representation: like the person would

## How
1. I call `references.find` with what I am about to write or decide (the situation, who it is for).
   `person` names a colleague instead of the CEO.
2. Corrections outrank older examples; a fitting situation outranks a general rule. Their reasons tell me
   how to decide a case they have not seen.
3. I write or decide in their style and reasoning. When nothing fits, I say so and ask them (a chat message or
   `human.ask`) rather than invent their view.
4. When they correct me or explain why, I keep it: `references.capture` (kind `correction` or `reason`, with
   the situation and who it was for).
