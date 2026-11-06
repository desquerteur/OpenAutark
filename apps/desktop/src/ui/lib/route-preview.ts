// The model routing takes now for an agent while the picker in front of the person has nothing chosen
// (routing.preview with ignorePin: router rules only, no model call). A picker's "nothing chosen" option names that
// model, never a mode word (B-072, owner: if it were automatic, the model would stand there, not "automatic"). In a
// chat the chat's own choice is left out and its runs continue (the composer's model chip); without a chat the
// agent's own pin is left out (the agent page; runtime/rpc/handlers/providers.ts).
// Owns: that one call as a hook and the hint beside the named model. Never: picks, stores or guesses a model.

import { useEffect, useState } from 'preact/hooks';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { rpc } from './rpc.ts';
import { can } from './session.ts';

/** The hint beside the model a "nothing chosen" option names; its label while that model is not known yet. */
export const PER_TASK = 'Chosen per task';

/**
 * The route for `agentId` with nothing chosen in the picker (`conversationId`: in that chat). Undefined until it
 * answers, when it fails and where this connection may not ask. `again`: values on whose change it asks anew.
 */
export function useRoutePreview(agentId: string | null | undefined, conversationId: string | undefined, again: readonly unknown[] = []): RouteDecision | undefined {
  const key = agentId ? `${agentId} ${conversationId ?? ''}` : '';
  const allowed = can('routing.preview');
  const [answer, setAnswer] = useState<{ key: string; route: RouteDecision } | undefined>();
  useEffect(() => {
    if (!agentId || !allowed) return;
    let alive = true;
    rpc.call('routing.preview', { agentId, ...(conversationId ? { conversationId } : {}), ignorePin: true })
      .then((route) => { if (alive) setAnswer({ key, route }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [key, allowed, ...again]);
  // an answer for another agent or chat is never shown
  return answer?.key === key ? answer.route : undefined;
}
