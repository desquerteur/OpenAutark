---
name: remotion-video
description: I read this for motion graphics, explainers, animated captions, intros/outros and data animations. Animated videos as code with Remotion (React) - project setup, compositions, frame-based timing, assets, fonts, rendering with the CLI, and the common failures.
metadata:
  modes:
    - video
---

# Remotion video

Remotion renders React components frame by frame into video, so I write everything visible as a
pure function of the current frame - the one rule behind most failures.

## Setup
- New project: `npx create-video@latest` (I pick the blank or a fitting template), then
  `npm install` in the project folder. Existing project: I read `src/Root.tsx` and
  `package.json` first and keep all `remotion` / `@remotion/*` packages on the **same
  version**.
- Preview: `npx remotion studio` (runs a local server; I open it in the preview pane).
- Licence: Remotion is free for individuals and small teams; larger companies need a company
  licence. When the human's company might be larger, I mention it once.
- When the project already has an official Remotion agent skill or `AGENTS.md`, I follow it.

## Composition
```tsx
// src/Root.tsx
import { Composition } from 'remotion';
import { Teaser } from './Teaser';
export const RemotionRoot = () => (
  <Composition id="Teaser" component={Teaser}
    durationInFrames={30 * 42} fps={30} width={1920} height={1080}
    defaultProps={{ title: 'Half the energy bill' }} />
);
```
- Vertical short-form: 1080×1920. Square: 1080×1080. I match the fps of the footage (25, 30,
  or 60) and keep one fps throughout.
- `calculateMetadata` fits when duration depends on input (audio length, data).

## Timing
```tsx
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
export const Title: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const scale = spring({ frame, fps, config: { damping: 200 } });
  return <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>{text}</AbsoluteFill>;
};
// in the parent: <Sequence from={30} durationInFrames={90}><Title text="…" /></Sequence>
```
- I think in frames: seconds × fps, with a small timing table (scene, from, duration) at the
  top of the file.
- Inside a `<Sequence>`, `useCurrentFrame()` starts at 0 again.
- I clamp `interpolate` (`extrapolateLeft/Right: 'clamp'`) unless I want overshoot.
- `<Series>` gives back-to-back scenes, `@remotion/transitions` transitions.

## Assets
- Files go in `public/` and load with `staticFile('music.mp3')`.
- Images: `<Img>` (waits for loading), not `<img>`. Video: `<OffthreadVideo>` for footage.
  Audio: `<Audio>` with `volume` (can be a function of frame for fades).
- Fonts: `@remotion/google-fonts/<Font>` `loadFont()`, or local fonts loaded before render.
- Data fetched at render time goes through `delayRender()` / `continueRender()` - or better,
  I pass data as props.

## Render
```
npx remotion render src/index.ts Teaser out/teaser.mp4 --codec=h264 --crf=18
npx remotion render src/index.ts Teaser out/test.mp4 --frames=0-89     # quick check
npx remotion still src/index.ts Teaser out/frame.png --frame=120       # one frame
npx remotion render ... --props='{"title":"New title"}'
```
- On machines with little RAM I use `--concurrency=1` or `2` and close the studio before a full
  render.
- Transparent overlays: `--codec=prores --prores-profile=4444` or VP9 WebM with
  `--pixel-format=yuva420p`.

## Verify
- I render 2-3 stills at key frames and look at them before a full render.
- After the render: `ffprobe` duration/fps/resolution, frames extracted at scene boundaries,
  the start and the end listened to for audio sync. Then I deliver with a `media` block.

## Common failures
| Symptom | Cause / fix |
|---|---|
| Animation works in studio, frozen or jumpy in render | CSS transitions/animations, `setTimeout`, `requestAnimationFrame` - derive everything from `useCurrentFrame()` |
| Different result every render | `Math.random()` / `Date.now()` - use `random('seed')` from remotion |
| Blank images or missing fonts in frames | `<img>` instead of `<Img>`, font not loaded, missing `delayRender` |
| "delayRender timed out" | a fetch or asset never resolved; check URL, pass data as props |
| Audio out of sync | mixed fps, variable-frame-rate source - convert footage to constant fps with ffmpeg first |
| Render crashes / out of memory | lower `--concurrency`, use `<OffthreadVideo>`, smaller proxies |
| Version mismatch errors | align all `remotion` and `@remotion/*` versions |
