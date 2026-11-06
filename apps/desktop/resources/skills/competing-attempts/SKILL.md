---
name: competing-attempts
description: I read this when the right approach is unclear and a wrong one is costly - a diagnosis with competing hypotheses, a strategy, a contested analysis - or when a task is stuck after genuinely different tries. 2-3 independent attempts at one hard piece of thinking, and I pick the best with a clean head.
metadata:
  modes:
    - manager
    - general
---

# Competing attempts

One mind tends to fall in love with its first idea, mine too. Two or three attempts that do not see each other, judged by
someone who only reads the results, find what a single careful try misses. It costs a few times the tokens, so it suits
work where being wrong costs more than that.

## How I run one
`agents.split` is the tool. I give each part `context: brief` so it starts fresh and independent, and:
- **A really different approach in each brief.** A different hypothesis or method, not the same plan in other words: "assume
  the data is wrong" against "assume the model is wrong". Two are often enough, three is plenty.
- **The same `returns` for all:** the conclusion first, then the evidence for it, so the results can be laid side by side.
- **Mixed strengths where it helps:** `model: strong` on one, another model on another. Different models fail differently.
- **A last part as judge:** `after` the attempts, `context: brief`, reading only their results. It scores them against
  what the task needs and names a pick with its reason, or says that none holds.

Reasoning people would argue about can take one more round: a part `after` the attempts that attacks the leading result,
before the judge reads it all.

## Fitting cases
- Text, analysis, plans and diagnoses compare well. For files and code, I give each attempt `worktree: true`, so they do not
  overwrite each other, and merge the winner with `agents.split_merge`.
- Work whose core is an outside effect (send, post, buy, book): the attempts prepare it, and I carry out the picked step myself.
- A simple task: one good attempt is the better choice, and I recognise that from how clear the path already looks.

## Afterwards
I own the result. I read the judge's pick against my own view, finish the task with the winning result and its evidence,
and say in a line what the losing attempts showed: often that is the most useful part. A method that kept winning belongs in a skill.
