// Composition of the prompt queues (AF-016): the service on RuntimeServices.promptQueue, watching the run ends, the
// emergency stop and removed chats; the stored queues are checked once shortly after the start. Called once from
// compose/services.ts after the dispatcher and the work stop exist.
// Owns: this wiring. Never: behaviour (runtime/prompt-queue/service.ts).

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/prompt-queue.ts'; // RuntimeServices.promptQueue
import { PromptQueues } from '../prompt-queue/service.ts';

export function createPromptQueues(s: RuntimeServices): PromptQueues {
  const queues = new PromptQueues({ services: () => s });
  s.promptQueue = queues;
  try { queues.watch(); } catch (error) { s.log.warn('prompt queues not watched', { error: String(error) }); }
  return queues;
}
