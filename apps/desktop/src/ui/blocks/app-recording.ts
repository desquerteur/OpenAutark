// Owns: validation of a mini-app's request for the host recorder. Never: opens devices or
// treats a frame message as a gesture. The host widget still requires Start, Record and Send.

import { toolError, type BridgeResult } from './app-host.ts';

export interface AppRecordingOptions { mode: 'audio' | 'video'; maxSeconds: number; script: string }

export function appRecording(
  block: { todo: boolean; allow: string },
  args: Record<string, unknown>,
  open: (options: AppRecordingOptions) => Promise<BridgeResult>,
): Promise<BridgeResult> {
  const fail = (message: string) => Promise.resolve(toolError(message));
  if (!block.todo) return fail('This app is not a to-do.');
  const mode = args.mode ?? 'audio';
  if (mode !== 'audio' && mode !== 'video') return fail('Choose audio or video.');
  const permissions = new Set(block.allow.split(';').map((value) => value.trim()));
  if (!permissions.has('microphone') || mode === 'video' && !permissions.has('camera')) {
    return fail('Allow this mini-app to use the microphone or camera first.');
  }
  const seconds = args.maxSeconds ?? 120;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fail('Choose a positive recording duration.');
  return open({ mode, maxSeconds: Math.min(seconds, 600), script: typeof args.script === 'string' ? args.script.slice(0, 12_000) : '' });
}
