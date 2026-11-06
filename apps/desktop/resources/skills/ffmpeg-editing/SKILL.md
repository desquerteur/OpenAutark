---
name: ffmpeg-editing
description: I read this for any footage or audio processing task. Practical ffmpeg/ffprobe recipes for video editing - inspect, trim and cut, concatenate, resize/reframe, mix and duck audio, burn or attach subtitles, normalise loudness, extract frames, and verify output.
metadata:
  modes:
    - video
    - social
---

# ffmpeg editing

I work on copies in the task folder: inspect first, process, then verify. I quote paths (Windows
paths with spaces), and `-y` goes in when I mean to overwrite my own output.

## Inspect
```
ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -of json in.mp4
```
I check: fps (constant?), resolution, rotation, audio streams, duration.
Variable frame rate (phone footage) → convert first:
`ffmpeg -i in.mp4 -vf fps=30 -c:v libx264 -crf 18 -c:a aac -b:a 192k cfr.mp4`

## Trim and cut
- Frame-accurate (re-encode): `ffmpeg -ss 00:01:05.200 -i in.mp4 -t 12.5 -c:v libx264 -crf 18 -c:a aac out.mp4`
- Fast, keyframe-aligned (no re-encode, may be off by up to a GOP): `ffmpeg -ss 65 -i in.mp4 -t 12.5 -c copy out.mp4`
- A middle part out: I cut the two pieces and concatenate.

## Concatenate
Same codec/resolution/fps → concat demuxer:
```
# list.txt
file 'a.mp4'
file 'b.mp4'
ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4
```
Different sources → concat filter (re-encode):
`ffmpeg -i a.mp4 -i b.mp4 -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac out.mp4`
Crossfade: `xfade=transition=fade:duration=0.5:offset=<len_a-0.5>` with `acrossfade=d=0.5`.

## Resize and reframe
- Fit 16:9 into 1080×1920 with blur background:
  `-filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2"`
- Centre crop to 9:16: `-vf "crop=ih*9/16:ih,scale=1080:1920"`

## Audio
- Replace audio: `ffmpeg -i video.mp4 -i voice.wav -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4`
- Music under voice with ducking (inputs: 0 video, 1 voice, 2 music; a stream used twice
  needs `asplit`):
  `-filter_complex "[1:a]asplit=2[vo][sc];[2:a]volume=0.25[m];[m][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[duck];[vo][duck]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -c:a aac`
- Fades: `afade=t=in:d=1,afade=t=out:st=<end-2>:d=2`
- Strip silence for rough cuts: detect with `silencedetect=noise=-35dB:d=0.6`, then cut at
  the reported times.
- Denoise light hum: `afftdn=nf=-25` (I listen before/after).

## Loudness (two-pass loudnorm)
Targets: YouTube/streaming about -14 LUFS integrated, true peak -1 dBTP; podcasts -16.
1. `ffmpeg -i in.mp4 -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null -`
2. With the measured values: `-af loudnorm=I=-14:TP=-1:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true`

## Subtitles
- Soft (selectable): `ffmpeg -i in.mp4 -i subs.srt -c copy -c:s mov_text out.mp4`
- Burned in: `-vf "subtitles=subs.srt:force_style='FontName=Inter,FontSize=18,Outline=2,MarginV=60'"`
  (Windows: escape the drive colon, e.g. `subtitles='C\:/work/subs.srt'`).
- SRT from a transcript with word timings: lines ≤ 42 characters, ≤ 2 lines,
  1-6 s each.

## Frames and thumbnails
- One frame: `ffmpeg -ss 12.3 -i in.mp4 -frames:v 1 frame.png`
- Contact sheet / sampling: `-vf "fps=1,scale=480:-2" frames/%04d.jpg`
- Scene changes: `-vf "select='gt(scene,0.35)',showinfo" -vsync vfr scenes/%03d.jpg`

## Export
Web/YouTube default: `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart`

## Verify
- I ffprobe the output (duration, fps, resolution, audio stream present).
- I look at frames at cut points and listen to the first and last seconds.
- I measure loudness again (step 1) on the final file.

## Pitfalls
- `-ss` after `-i` is slow but accurate; before `-i` is fast (accurate when re-encoding).
- `-c copy` cuts on keyframes - visible jumps at the start.
- `yuv420p` missing → file does not play in some players.
- Odd dimensions with libx264 → `scale=...:-2`.
- Low RAM: long files in segments, small filter graphs.
