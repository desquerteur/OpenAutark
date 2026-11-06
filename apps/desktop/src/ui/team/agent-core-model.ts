// A skill's display title from its id ("task-ownership" → "Task ownership"); the id stays its name everywhere
// else. Used by the agent page's skill list and the skill lists in Settings.
// Owns: this one rule (unit-tested in test/unit/ui/agent-core-model.test.ts). Never: calls the runtime.

export function skillTitle(name: string): string {
  const words = name.split('-').filter(Boolean).join(' ');
  return words ? (words[0].toUpperCase() + words.slice(1)).replace(/\bai\b/gi, 'AI') : name;
}
