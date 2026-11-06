---
name: youtube-publishing
description: I read this when a video is ready to go on YouTube. Publishing it end to end - title, description, chapters, tags, thumbnail, captions, upload settings checklist, verification of the live video, and the comment follow-up routine.
metadata:
  modes:
    - video
    - social
---

# YouTube publishing

## 1. Before upload
- Final file verified (see `ffmpeg-editing`): H.264/AAC, `yuv420p`, constant fps, loudness
  about -14 LUFS, no black frames at start/end.
- Rights: music, footage and fonts are licensed or own. When that is unclear, I hold the upload and ask.
- Which channel/account: the one the human connected; I check I am signed in to the
  right channel before uploading.

## 2. Metadata
- **Title** - ≤ 70 characters visible, the promise first, no clickbait the video does not
  deliver. I draft 3 options in channel voice and pick one or ask with a `choice`.
- **Description** - first 2 lines carry the value (shown above "more"). Then: short summary,
  links (with UTM if the human uses them), chapters, credits, disclosure if sponsored.
- **Chapters** - `00:00 Intro` first, at least 3 entries, each ≥ 10 s, from the edit timeline.
- **Tags** - a few specific ones; they matter little.
- **Thumbnail** - 1280×720, < 2 MB, readable at small size: one face or object, ≤ 4 words,
  high contrast. I make 2 variants; when it shows their face, the human picks.
- **Captions** - an SRT from the transcript (better than auto captions).
- **Settings** - audience ("made for kids" yes/no, I ask when unclear), category, language,
  visibility (private → scheduled/public), paid promotion flag when applicable, end screen
  and cards if the channel uses them.

## 3. Upload
- I use YouTube Studio in my own browser profile (or the API when the human connected it).
- I upload as **private** first, fill all fields, wait until processing finishes (HD can take
  longer), then set the scheduled time or public.
- I record the video id and URL in the task.

## 4. Verify live
- I open the watch URL logged out (or in a clean tab): plays, correct thumbnail, title,
  description links work, chapters show, captions available.
- I check Studio for copyright claims or restrictions.

## 5. Follow-ups (always)
I schedule the comment routine (`proactive-follow-ups`):
```
after 2 h: first comments - answer questions, heart good ones, pin a helpful comment
daily for 7 days, then weekly x4: new comments, spam cleanup, escalate sensitive ones
after 7 days: short stats line (views, watch time, CTR) in the task
```
I also consider: a short-form cut for Shorts, a community post, adding the video to a playlist,
linking it from the website.

## Report
The live link and how I checked it (logged out, captions on) are what the reader needs;
extras and the comment routine I mention where they matter to them. No fixed format.

## Pitfalls
- Wrong channel (brand vs personal). I verify before upload.
- Publishing before processing finishes (low resolution at launch).
- Answering complaints, legal or press comments without the human.
