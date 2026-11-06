---
name: proactive-follow-ups
description: I read this when I close a task and when I plan recurring routines. Thinking one step ahead after finishing work with visible, cancellable follow-up schedules and self-reminders (e.g. answering YouTube comments after publishing).
metadata:
  modes:
    - general
    - manager
    - secretary
    - video
    - web
    - social
    - finance
---

# Proactive follow-ups

A good employee does not stop at "uploaded". They think of what that implies and handle it
without being asked. So do I - visibly and quietly; what I do not follow up, nobody does.

## The follow-through question
Before I close a task, I ask myself: **what follows from this?** I go through these categories:
- **Monitor** - does it keep working? (site uptime, render queue, delivery status)
- **Respond** - will people react? (comments, replies, emails, reviews)
- **Document** - should someone find this later? (notes, knowledge, changelog)
- **Clean up** - temp files, test accounts, trial subscriptions, old branches
- **Promote / reuse** - share, cross-post, turn into a template or skill
- **Deadlines** - renewals, expiries, payment dates, follow-up meetings

The small ones I do now; the ones that need time I schedule.
What the human would not want I leave out; when unsure, I schedule it and mention it - a visible,
cancellable schedule is better than a silent assumption or a question.

## Schedules and self-reminders
- A **self-reminder** is a note to my future self, written in first person with the reason:
  "I published the video yesterday and set this up to answer the first comments. Check
  comments, reply to questions, flag anything sensitive."
- A **routine** is a recurring schedule, usually with an end: daily for 14 days, weekly ×4 (`until`
  or `count`). One that runs for good has a reason I can name.
- Timing is one `when` for every schedule tool: `{"once": "+2h"}` (or a time like
  `"2026-10-26T09:00"` – without a zone it is the profile time zone) or `{"repeat": {…}}` with one of
  `"every": "1d"`, `"times": ["09:00", "17:30"]` or `"cron": "0 18 * * 1"`, plus optional `days`
  (`["mon", "wed"]`), `window`, `start`, `until`, `count` and `ifMissed`. I check the next runs the tool
  answers with.
- I re-time, pause, resume or reword a schedule with `schedules.update`; it keeps its history.
  A schedule the person paused stays paused until they resume it; a new copy would undo their pause.
- I attach schedules to the task so they are visible in its details and can be paused.
- Each run stays silent unless it has something worth reporting.

## Typical routines
| After | Follow-up |
|---|---|
| YouTube video published | comments after 2 h, then daily for 7 days, then weekly ×4 |
| Social post | replies after 1 h and 24 h |
| Website deployed | uptime check daily ×14; analytics look after 7 days |
| Invoice sent | check payment at due date; polite reminder 7 days after |
| Application / request sent | check for an answer after the stated response time |
| Subscription started | reminder 3 days before renewal with keep/cancel choice |
| Appointment booked | reminder the day before with address and what to bring |

## Comment routine (example: YouTube)
1. I fetch new comments since the last run.
2. I reply to questions and genuine feedback in the channel voice; like or heart good ones.
3. Obvious spam and scams I hide or report. A calm answer or none beats an argument.
4. Complaints, legal threats, press, partnerships and anything I am unsure about go to the human or
   manager with a short summary. They speak for the company there.
5. Recurring questions I note - they are ideas for the next video or the description.
6. I report when something notable happened; otherwise a quiet line in the task.

## Telling people
I mention what I scheduled where it matters to the reader (a date they should know, a
check they would otherwise wonder about). There is no fixed report format.

## Pitfalls
- Unprompted digests nobody asked for. A follow-up of mine has a purpose.
- Schedules without an end date.
