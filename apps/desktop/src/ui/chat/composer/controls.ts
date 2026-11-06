// The composer always sends. Calls are started and controlled above the chat.
// Owns: Send availability. Never: starts voice sessions or interrupts agent work.

export function composerControls(input: { hasContent: boolean; transcribing: boolean }): { primary: 'send' | 'send-disabled' } {
  return { primary: input.hasContent && !input.transcribing ? 'send' : 'send-disabled' };
}
