// AF-017: the resting sub line of an agent's 1:1 chat header – which agent it is, where it works and who hired it:
// "Video editor · Project Autark · hired by Manager". The project part is left out while the header's project chip
// (AF-018, chat/ProjectChip.tsx) already names it; without a project it says "No project".
// Owns: this line's words. Never: reads stores or renders.

export interface AgentChatLineInput {
  role: string;
  /** The agent's project name, if it works in one. */
  project?: string;
  /** The chip beside the name shows the project already. */
  chipShown: boolean;
  /** "You", the hiring agent's name or "Autark". */
  hiredBy: string;
}

export function agentChatLine(input: AgentChatLineInput): string {
  const place = input.project ? (input.chipShown ? '' : `Project ${input.project}`) : 'No project';
  const hired = input.hiredBy === 'You' ? 'hired by you' : `hired by ${input.hiredBy}`;
  return [input.role.trim(), place, hired].filter(Boolean).join(' · ');
}
