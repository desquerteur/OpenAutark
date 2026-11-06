// Context: the one context service of the runtime (ARCHITECTURE §4 "assemble context").
// prompt() builds {stable, volatile} (B-049 F6: and the volatile part by section); delta() renders unseen chat lines from the canonical
// store (with `includeOwn` for the catch-up of a resumed session); checkpoint() makes the
// portable Handoff; compact() condenses old chat segments into an observation (session renewal
// then sends the full projection, which carries it); prepare() extracts attachment text ahead
// of delta() (optional, async).
// Owns: wiring of the sub-builders, the lazily loaded prompt templates (B-044: the runtime's shared set, which
// takes the person's own versions in <data>/prompts – context/templates.ts), the optional cheap
// text runner for compaction, one compaction at a time per (agent, chat), and the final secret
// redaction of everything handed to an engine (prompt, delta, handoff; compact.ts its seed).
// Never: advances cursors, starts engines or treats memory as instructions (see sub-modules).

import type { ContextService, PromptParts, RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Handoff, ModeInfo } from '../../shared/model/knowledge.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { createEngineRunner, type EngineRunnerDeps } from '../decision/engine-runner.ts';
import path from 'node:path';
import { PromptTemplates } from './templates.ts';
import { buildStable } from './prompt-stable.ts';
import { volatileSections } from './prompt-volatile.ts';
import { buildDelta, unseenAttachments, type DeltaInput, type DeltaResult } from './delta.ts';
import { buildCheckpoint } from './checkpoint.ts';
import { compactConversation } from './compact.ts';
import { AttachmentTexts } from './attachments.ts';
import { redactText } from './render.ts';

export interface ContextDeps {
  services: () => RuntimeServices;
  /**
   * Cheap text runner for the written part of compaction summaries. Default: the engine runner
   * (cheapest routed model) whenever a model is available; `false` = extractive only.
   */
  runner?: StructuredRunner | false;
  /** Folder with the base prompt templates (default `<resources>/prompts`). */
  promptsDir?: string;
  /** B-044: the runtime's one prompt set with the person's own versions (<data>/prompts, compose/services.ts); absent = shipped prompts only. */
  templates?: PromptTemplates;
}

export class Context implements ContextService {
  private readonly deps: ContextDeps;
  private readonly templates: PromptTemplates;
  private readonly texts: AttachmentTexts;
  private readonly compacting = new Map<string, Promise<string>>();
  private engineRunner?: StructuredRunner;

  constructor(deps: ContextDeps) {
    this.deps = deps;
    this.templates = deps.templates ?? new PromptTemplates(
      () => deps.promptsDir ?? (deps.services().paths?.resources ? path.join(deps.services().paths.resources, 'prompts') : undefined),
      () => deps.services().log,
    );
    this.texts = new AttachmentTexts(deps.services);
  }

  // Everything returned to the engine passes the secret redactor (known values → secret://).
  prompt(input: { agent: Agent; conversationId?: string; taskId?: string; thread?: string; mode: ModeInfo; route: RouteDecision }): PromptParts {
    const services = this.deps.services();
    // B-049 F6: the volatile part also by section (built once – some sections show once), each redacted.
    const sections = volatileSections(services, { agent: input.agent, conversationId: input.conversationId, taskId: input.taskId, thread: input.thread, route: input.route })
      .map((section) => ({ ...section, text: redactText(services, section.text) }));
    return {
      stable: redactText(services, buildStable(services, this.templates, { agent: input.agent, mode: input.mode, route: input.route })),
      volatile: sections.filter((section) => !section.failed).map((section) => section.text).join('\n\n'),
      sections,
    };
  }

  delta(input: DeltaInput): DeltaResult {
    const services = this.deps.services();
    const result = buildDelta(services, this.texts, input);
    return { ...result, text: redactText(services, result.text) };
  }

  checkpoint(input: { agentId: string; taskId?: string; conversationId?: string }): Handoff {
    const services = this.deps.services();
    const handoff = buildCheckpoint(services, input);
    const clean = (text: string) => redactText(services, text);
    const out: Handoff = {
      goal: clean(handoff.goal), verified: handoff.verified.map(clean), open: handoff.open.map(clean), next: clean(handoff.next),
      artifacts: handoff.artifacts.map((item) => ({ label: clean(item.label), ref: item.ref })),
    };
    if (handoff.constraints) out.constraints = handoff.constraints.map(clean);
    return out;
  }

  compact(input: { agentId: string; conversationId: string }): Promise<string> {
    const key = `${input.agentId}:${input.conversationId}`;
    const running = this.compacting.get(key);
    if (running) return running;
    const job = compactConversation(this.deps.services(), { templates: this.templates, runner: () => this.runner() }, input)
      .finally(() => this.compacting.delete(key));
    this.compacting.set(key, job);
    return job;
  }

  /** Extracts text of unseen text/PDF attachments so the next delta() can include it. */
  async prepare(input: { agentId: string; conversationId: string; sinceSeq: number }): Promise<void> {
    const services = this.deps.services();
    try {
      await this.texts.prepare(unseenAttachments(services, input));
    } catch (error) {
      services.log.debug('attachment preparation failed', { conversationId: input.conversationId, error: String(error) });
    }
  }

  private runner(): StructuredRunner | undefined {
    if (this.deps.runner === false) return undefined;
    if (this.deps.runner) return this.deps.runner;
    const services = this.deps.services;
    try {
      if (!services().catalog.list().some((model) => model.available)) return undefined;
    } catch {
      return undefined;
    }
    const wiring: EngineRunnerDeps = {
      get engines() { return services().engines; },
      get router() { return services().router; },
      get accounts() { return services().accounts; },
      get catalog() { return services().catalog; },
      get paths() { return services().paths; },
      get clock() { return services().clock; },
      get notifications() { return services().notifications; },
      timeoutMs: 60_000,
    };
    this.engineRunner ??= createEngineRunner(wiring);
    return this.engineRunner;
  }
}
