// Media generation tools (MM3, split out of media.ts; B-058 G11/G12): media.image and media.speak on the one
// generation flow (media-generate-flow.ts). media.image runs on the image model in Settings, else on the
// person's ChatGPT plan (one Codex image, no key needed); media.speak on the speech model in Settings, else in
// the local voice (Supertonic 3, downloaded on first use, WAV). generationTools also carries media.music,
// media.sound and media.video (media-generate-av.ts) into media.ts's list.
// Owns: these two tools' arguments, descriptions and stored descriptions. Never: the flow's rules (booking,
// storage – media-generate-flow.ts).

import { GENERATE_LIMITS, IMAGE_QUALITIES, IMAGE_SIZES, SPEECH_FORMATS, type ImageQuality, type ImageSize, type SpeechFormat } from '../../media/generate.ts';
import type { ToolDef } from '../types.ts';
import { MEDIA_DESCRIBE_HINT } from './media-common.ts';
import { avGenerationTools } from './media-generate-av.ts';
import { describedAs, generationTool } from './media-generate-flow.ts';
import { clip } from './util.ts';

const NAME = { type: 'string', minLength: 1, maxLength: 80, description: 'file name without extension' } as const;

type ImageArgs = { prompt: string; size?: ImageSize; quality?: ImageQuality; name?: string };

const image = generationTool<ImageArgs>({
  name: 'media.image',
  kind: 'image',
  description: `Create an image from a description (the image model in Settings, else the ChatGPT plan). Stores it in the media library (tag "generated") and returns its fileId and a ready \`\`\`ui media block. A paid model costs money like any purchase. ${MEDIA_DESCRIBE_HINT}`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: GENERATE_LIMITS.promptChars, description: 'what the image shows: subject, style, composition, text in it' },
      size: { type: 'string', enum: [...IMAGE_SIZES] }, quality: { type: 'string', enum: [...IMAGE_QUALITIES] },
      name: NAME,
    },
    required: ['prompt'], additionalProperties: false,
  },
  summary: (args) => `Create image "${clip(args.prompt, 60)}"`,
  request: (args) => ({ prompt: args.prompt, size: args.size, quality: args.quality }),
  status: 'creating an image',
  stored: (args, made) => ({ name: args.name ?? args.prompt, description: describedAs('image', made, args.prompt), tags: ['generated', 'image'] }),
  extra: (_args, made) => (typeof made.meta?.revisedPrompt === 'string' ? { revisedPrompt: made.meta.revisedPrompt } : {}),
});

type SpeakArgs = { text: string; voice?: string; format?: SpeechFormat; language?: string; name?: string };

const speak = generationTool<SpeakArgs>({
  name: 'media.speak',
  kind: 'speech',
  description: `Turn text into speech (the speech model in Settings, else the local voice) in my voice (agents.update voice) or the one given. Stores the audio in the media library (tag "generated") and returns its fileId and a ready \`\`\`ui media block. Up to ${GENERATE_LIMITS.speechChars} characters per call. A paid model costs money like any purchase.`,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: GENERATE_LIMITS.speechChars },
      voice: { type: 'string', maxLength: 40, description: 'voice of the speech model, e.g. "nova"; the local voice takes 0-9' },
      format: { type: 'string', enum: [...SPEECH_FORMATS], description: 'the local voice always makes wav' },
      language: { type: 'string', maxLength: 8, description: 'ISO code, e.g. "de"; default: the text\'s' },
      name: NAME,
    },
    required: ['text'], additionalProperties: false,
  },
  summary: (args) => `Speak "${clip(args.text, 60)}"`,
  request: (args, ctx) => ({
    prompt: '', text: args.text, format: args.format, language: args.language,
    voice: args.voice?.trim() || ctx.services.org.get(ctx.agent.id)?.voice || ctx.agent.voice,
  }),
  status: 'recording speech',
  stored: (args, made) => ({
    name: args.name ?? args.text, tags: ['generated', 'speech'],
    description: describedAs('speech', made, args.text, made.voice ? `, voice ${made.voice}` : ''),
  }),
  extra: (_args, made) => ({ voice: made.voice, ...(made.language ? { language: made.language } : {}) }),
});

export const generationTools: ToolDef[] = [image, speak, ...avGenerationTools];
