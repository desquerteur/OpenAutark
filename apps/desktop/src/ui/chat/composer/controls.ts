// The composer's primary cell: Send, disabled without content – and (AF-012) Stop while an agent works in the chat and
// there is nothing to send (a draft keeps Send, so a message still reaches the running agent; Esc stops then).
// Calls are started and controlled above the chat.
// Owns: what the primary cell is. Never: starts voice sessions, or stops agent work itself (composer/stop.ts).

export function composerControls(input: { hasContent: boolean; transcribing: boolean; working?: boolean }): { primary: 'send' | 'send-disabled' | 'stop' } {
  if (input.working && !input.hasContent && !input.transcribing) return { primary: 'stop' };
  return { primary: input.hasContent && !input.transcribing ? 'send' : 'send-disabled' };
}
