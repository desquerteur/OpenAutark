// B-058 G13: media.music (music and songs), media.sound (sound effects) and media.video (short clips, also from a
// stored image) on the one generation flow (media-generate-flow.ts) with the function models music / sound /
// video (Gemini API, ElevenLabs, fal.ai – providers/*.ts). None of them runs for free: without a model the
// tool says which key turns it on. A video job waits within the tool (up to 6 minutes; the adapter asks only
// its own job, G13).
// Owns: these three tools' arguments, descriptions and stored descriptions. Never: the flow's rules (the
// gate, booking, storage – media-generate-flow.ts) or a provider's request format (the adapters).

import { DURATION_S, GENERATE_LIMITS, VIDEO_ASPECTS, VIDEO_RESOLUTIONS } from '../../media/generate.ts';
import type { ToolDef } from '../types.ts';
import { MEDIA_DESCRIBE_HINT } from './media-common.ts';
import { describedAs, generationTool } from './media-generate-flow.ts';
import { clip } from './util.ts';

const NAME = { type: 'string', minLength: 1, maxLength: 80, description: 'file name without extension' } as const;
const PROMPT = (what: string) => ({ type: 'string', minLength: 1, maxLength: GENERATE_LIMITS.promptChars, description: what });
const SECONDS = (kind: 'music' | 'sound' | 'video') => ({ type: 'number', minimum: DURATION_S[kind].min, maximum: DURATION_S[kind].max, description: 'length in seconds' });
// Review fix: the media tools' shared rule (test/unit/media/tools.test.ts) – every media tool but media.speak/unmark carries the hint, as media.image does.
const STORED = `Stores it in the media library (tag "generated") and returns its fileId and a ready \`\`\`ui media block. A paid model costs money like any purchase. ${MEDIA_DESCRIBE_HINT}`;

type MusicArgs = { prompt: string; lyrics?: string; durationS?: number; instrumental?: boolean; name?: string };

const music = generationTool<MusicArgs>({
  name: 'media.music',
  kind: 'music',
  description: `Create music or a song from a description: genre, mood, instruments, tempo; lyrics are sung (instrumental: true for none). ${STORED}`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: PROMPT('style, mood, instruments, tempo, language of the vocals'),
      lyrics: { type: 'string', maxLength: GENERATE_LIMITS.lyricsChars, description: 'words to sing, [Verse]/[Chorus] sections work' },
      durationS: SECONDS('music'), instrumental: { type: 'boolean' }, name: NAME,
    },
    required: ['prompt'], additionalProperties: false,
  },
  summary: (args) => `Create music "${clip(args.prompt, 60)}"`,
  request: (args) => ({ prompt: args.prompt, lyrics: args.lyrics, durationS: args.durationS, instrumental: args.instrumental }),
  status: 'composing music',
  stored: (args, made) => ({ name: args.name ?? args.prompt, description: describedAs(args.lyrics && !args.instrumental ? 'song' : 'music', made, args.prompt), tags: ['generated', 'music'] }),
});

type SoundArgs = { prompt: string; durationS?: number; loop?: boolean; name?: string };

const sound = generationTool<SoundArgs>({
  name: 'media.sound',
  kind: 'sound',
  description: `Create a sound effect from a description (e.g. "door creaks open, then a slam"); loop: true for a seamless loop. ${STORED}`,
  inputSchema: {
    type: 'object',
    properties: { prompt: PROMPT('the sound, its source and character'), durationS: SECONDS('sound'), loop: { type: 'boolean' }, name: NAME },
    required: ['prompt'], additionalProperties: false,
  },
  summary: (args) => `Create sound effect "${clip(args.prompt, 60)}"`,
  request: (args) => ({ prompt: args.prompt, durationS: args.durationS, loop: args.loop }),
  status: 'creating a sound effect',
  stored: (args, made) => ({ name: args.name ?? args.prompt, description: describedAs('sound effect', made, args.prompt), tags: ['generated', 'sound'] }),
});

type VideoArgs = { prompt: string; durationS?: number; aspect?: string; resolution?: string; imageFileId?: string; name?: string };

const video = generationTool<VideoArgs>({
  name: 'media.video',
  kind: 'video',
  description: `Create a short video clip from a description, optionally starting from a stored image (imageFileId). Takes up to a few minutes. ${STORED}`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: PROMPT('scene, action, camera, style, sound'),
      durationS: SECONDS('video'), aspect: { type: 'string', enum: [...VIDEO_ASPECTS] }, resolution: { type: 'string', enum: [...VIDEO_RESOLUTIONS] },
      imageFileId: { type: 'string', description: 'stored image the clip starts from' }, name: NAME,
    },
    required: ['prompt'], additionalProperties: false,
  },
  summary: (args) => `Create video "${clip(args.prompt, 60)}"`,
  request: (args) => ({ prompt: args.prompt, durationS: args.durationS, aspect: args.aspect, resolution: args.resolution, imageFileId: args.imageFileId }),
  status: 'creating a video',
  stored: (args, made) => ({ name: args.name ?? args.prompt, description: describedAs('video', made, args.prompt), tags: ['generated', 'video'] }),
});

export const avGenerationTools: ToolDef[] = [music, sound, video];
