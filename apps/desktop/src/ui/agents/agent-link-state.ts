// AF-017: the one linker for agent names in message text, rebuilt when the team changes (agent-links.ts).
// Owns: this computed. Never: renders.

import { computed } from '@preact/signals';
import { agents } from '../lib/store.ts';
import { makeAgentLinker } from './agent-links.ts';

/** Rewrites agent names in message Markdown into links to their pages (blocks/MessageBody.tsx). */
export const agentLinker = computed(() => makeAgentLinker(agents.value.filter((agent) => agent.archivedAt === undefined)));
