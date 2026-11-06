// Composition of the decision hub: a connection on the decision protocol when there is one (decision/systemone.ts), then a
// cheap connected model with structured output (decision/llm-fallback.ts over decision/engine-runner.ts), routed like any
// helper call (the Decisions use of settings.json's Models section, routing.decision; 'auto' = nothing picked yet). With no
// model connected every answer is "no answer" and callers use their own rules.
// Owns: this wiring. Never: calls models itself or reads secrets.

import type { RuntimeServices } from '../contracts.ts';
import { DecisionHub } from '../decision/service.ts';
import { LlmDecisionBackend } from '../decision/llm-fallback.ts';
import { SystemOneBackend } from '../decision/systemone.ts';
import { createEngineRunner } from '../decision/engine-runner.ts';

export function createDecisionHub(services: () => RuntimeServices): DecisionHub {
  const s = services;
  const runner = createEngineRunner({
    get engines() { return s().engines; },
    get router() { return s().router; },
    get accounts() { return s().accounts; },
    get catalog() { return s().catalog; },
    get paths() { return s().paths; },
    get clock() { return s().clock; },
    get notifications() { return s().notifications; }, // a helper call that finds a plan signed out: the one sign-in to-do
  } as Parameters<typeof createEngineRunner>[0]);
  return new DecisionHub({
    backends: [
      new SystemOneBackend({ services: s, now: () => s().clock.now() }), // a connection on the decision protocol, when there is one
      new LlmDecisionBackend(runner, () => s().catalog.list().some((model) => model.available), () => s().clock.now()),
    ],
    redact: (text) => s().secrets.redact(text),
    log: s().log,
  });
}
