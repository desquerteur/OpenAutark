// Free text from the human's "For you" list → the ask block (widget) that fits it best: the
// decision model chooses among the catalog's ask types (with their one-line descriptions) within
// WIDGET_DECISION_MS (F05: DecisionRequest.timeoutMs – the hub cancels a slower answer); without
// one, when it is unsure or too slow, the deterministic DE/EN keyword fallback decides
// (widget-fill.ts keywordWidget). Either way the block's props are filled from the text
// (widget-fill.ts fillFromText: options, link, script, day and time …) in the validator's shapes.
// fillWidget then lets the cheap model fill what the text gives but the block still lacks
// (widget-fill.ts fillWithModel, at most WIDGET_FILL_MS; service.ts decides whether a model may run).
// Owns: that choice and fill. Never: returns a non-ask block or a type outside the catalog, changes
// the type while filling, or asks a model when none is connected (service.ts passes no runner then).

import type { RuntimeServices } from '../contracts.ts';
import { CATALOG, type UiBlock } from '../../shared/blocks/catalog.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { widgetOfType } from '../tasks/widgets.ts';
import { fillFromText, fillWithModel, keywordWidget } from './widget-fill.ts';

const MIN_CONFIDENCE = 0.3;
const ASK_SPECS = CATALOG.filter((spec) => spec.kind === 'ask');
/** F05: how long a to-do's widget decision may take (the to-do exists already; this only refines it). */
export const WIDGET_DECISION_MS = 8000;
/** F05: how long the cheap model may take to fill a widget's props (in the background as well). */
export const WIDGET_FILL_MS = 30_000;

export async function chooseWidget(services: Pick<RuntimeServices, 'clock' | 'log'> & Partial<Pick<RuntimeServices, 'decisions'>>, text: string): Promise<UiBlock> {
  const now = services.clock.now();
  const trimmed = text.trim();
  const fallback = keywordWidget(trimmed, now);
  const type = trimmed ? await decidedType(services, trimmed) : undefined;
  if (!type || type === fallback.type) return fillFromText(fallback, trimmed, now);
  let block: UiBlock;
  try { block = widgetOfType(type, excerpt(trimmed.split(/\r?\n/)[0] ?? trimmed, 120), fallback); } catch { return fillFromText(fallback, trimmed, now); }
  return fillFromText(block, trimmed, now);
}

/**
 * The props `text` gives for `block`: the deterministic extractors, then `run` (the cheap model,
 * none = no model) for what is still missing. A failed or slow model call keeps the text's props.
 */
export async function fillWidget(
  services: Pick<RuntimeServices, 'clock' | 'log'> & Partial<Pick<RuntimeServices, 'secrets'>>, run: StructuredRunner | undefined, block: UiBlock, text: string,
): Promise<UiBlock> {
  const now = services.clock.now();
  const trimmed = text.trim();
  const filled = fillFromText(block, trimmed, now);
  if (!run || !trimmed) return filled;
  const secrets = services.secrets;
  try {
    return await fillWithModel(run, filled, trimmed, { now, redact: secrets ? (value) => secrets.redact(value) : undefined, signal: AbortSignal.timeout(WIDGET_FILL_MS) });
  } catch (error) {
    services.log.debug('widget fill failed; keeping the props the text gives', { type: block.type, error: String(error) });
    return filled;
  }
}

/** The ask type the decision model picks with enough confidence, else undefined (none, unsure, failed or timed out). */
async function decidedType(services: Pick<RuntimeServices, 'log'> & Partial<Pick<RuntimeServices, 'decisions'>>, text: string): Promise<string | undefined> {
  if (!services.decisions?.available()) return undefined;
  try {
    const result = await services.decisions.decide({
      type: 'choice', purpose: 'widget',
      question: 'Which widget lets the human do this to-do fastest?',
      options: ASK_SPECS.map((spec) => `${spec.type}: ${spec.doc}`),
      context: excerpt(text, 1000),
      timeoutMs: WIDGET_DECISION_MS,
    });
    if (result.by === 'timeout') services.log.debug('widget decision timed out; using keywords', { ms: WIDGET_DECISION_MS });
    const type = result.choice && result.confidence >= MIN_CONFIDENCE ? result.choice.split(':')[0].trim() : undefined;
    return type && ASK_SPECS.some((spec) => spec.type === type) ? type : undefined;
  } catch (error) {
    services.log.debug('widget decision failed; using keywords', { error: String(error) });
    return undefined;
  }
}
