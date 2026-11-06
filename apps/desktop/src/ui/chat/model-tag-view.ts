// The small model tag under a message or a task (B-050 K6, the owner's 28.10. "wenn man ein Modell angibt, wird das
// einfach unter der Nachricht hingeschrieben … So würde ich das auch bei Task machen"): a person's message that asked
// for a model (meta.modelHint, stamped by the runtime) shows its short name, a pinned one with a pin; Auto shows nothing.
// An external author's tag is never shown (its meta is untrusted). Kept apart from the model a message was written
// on (meta.model – only in the time's tooltip): this one is a recommendation for whoever takes the work.
// Owns: which messages carry a tag, and its words. Never: renders, or loads the model catalog (`nameOf`).

import type { Message, ModelTag } from '../../shared/model/chat.ts';
import { EFFORT_LABEL } from './live-text.ts';

export interface ModelTagView {
  /** The model's short name (the catalog's, else the id's last segment). */
  name: string;
  pinned: boolean;
  /** The tooltip: "Suggested: …" / "Pinned: …", with the effort when one was asked for. */
  title: string;
}

type NameOf = (id: string) => string | undefined;

function view(hint: ModelTag | undefined, nameOf: NameOf): ModelTagView | undefined {
  if (!hint || typeof hint.modelId !== 'string' || hint.modelId === 'auto') return undefined;
  const name = nameOf(hint.modelId);
  if (!name) return undefined;
  const effort = !hint.effort ? '' : ` · ${Object.prototype.hasOwnProperty.call(EFFORT_LABEL, hint.effort) ? EFFORT_LABEL[hint.effort as keyof typeof EFFORT_LABEL] : hint.effort}`;
  return { name, pinned: hint.pinned === true, title: `${hint.pinned ? 'Pinned' : 'Suggested'}: ${name}${effort}` };
}

/** The tag of a person's or an agent's message; none for Auto, external authors and status lines. */
export function messageModelTag(message: Pick<Message, 'authorKind' | 'kind' | 'meta'>, nameOf: NameOf): ModelTagView | undefined {
  if ((message.authorKind !== 'human' && message.authorKind !== 'agent') || message.kind === 'status') return undefined;
  return view(message.meta.modelHint as ModelTag | undefined, nameOf);
}

