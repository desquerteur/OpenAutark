// Model chip in the composer: the chosen model's short name ("Opus 5.5") + effort, else the model the app routes the
// agent to now in this chat (routing.preview, lib/route-preview.ts; its last run here until the preview answers) –
// never a mode word ("Chosen per task" only where this connection may not ask) – in one fixed width (nothing beside it
// moves when the model changes). Menu: first that routed model ("Chosen per task"), one searchable list of the chat
// models and an effort row. A pick is the agent's model in this chat (chats.update settings.models); the first item
// clears it and the effort (pickPatch 'auto'). A connection that may not change the chat sees a plain label.
// Owns: the chip and its menu. Never: changes the agent's identity or global defaults.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationSettings, ConversationSummary } from '../../../shared/model/chat.ts';
import type { Effort, ModelInfo } from '../../../shared/model/providers.ts';
import { Icon, Popover } from '../../lib/ui.tsx';
import { loadModels, messagesFor, models } from '../../lib/store.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { toastError } from '../../lib/toasts.ts';
import { isChatModel } from '../../lib/model-fit.ts';
import { modelShortName as shortName } from '../../lib/model-name.ts';
import { PER_TASK, useRoutePreview } from '../../lib/route-preview.ts';
import { EFFORT_LABEL } from '../live-text.ts';

type Patch = Pick<ConversationSettings, 'models' | 'modelHints' | 'efforts'>;

async function save(chat: ConversationSummary, patch: Patch): Promise<void> {
  try {
    await rpc.call('chats.update', { id: chat.id, settings: patch });
  } catch (error) { toastError(error, 'Model could not be changed'); }
}

/** The agent's chosen model in this chat (an older chat may still hold it as a hint). */
export function chosenModel(settings: ConversationSettings, agentId: string): string | undefined {
  const id = settings.models?.[agentId] ?? settings.modelHints?.[agentId];
  return id && id !== 'auto' ? id : undefined;
}

/** What picking `modelId` (or 'auto': nothing chosen) writes: the model for this agent, no hint; 'auto' also clears the effort. */
export function pickPatch(settings: ConversationSettings, agentId: string, modelId: string): Patch {
  const chosen = { ...(settings.models ?? {}) };
  const hints = { ...(settings.modelHints ?? {}) };
  delete chosen[agentId];
  delete hints[agentId];
  if (modelId !== 'auto') return { models: { ...chosen, [agentId]: modelId }, modelHints: hints };
  const efforts = { ...(settings.efforts ?? {}) };
  delete efforts[agentId];
  return { models: chosen, modelHints: hints, efforts };
}

/** Model the agent last used in this chat (the chip's name while nothing is chosen and the preview has not answered). */
function lastUsed(chatId: string, agentId: string): string | undefined {
  const list = messagesFor(chatId).value;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].authorId === agentId && list[i].meta.model) return list[i].meta.model;
  }
  return undefined;
}

function ModelRow(props: { model: ModelInfo; selected: boolean; onPick: () => void }) {
  const { model } = props;
  const hint = model.available ? undefined : 'Unavailable';
  return (
    <button type="button" class={`menu-item${model.available ? '' : ' unavailable'}`} role="menuitemradio" aria-checked={props.selected}
      onClick={props.onPick}>
      <span class="menu-label"><span>{shortName(model.id) ?? model.name}</span></span>
      {hint && <span class="menu-hint">{hint}</span>}
      {props.selected && <Icon name="check" size={16} class="menu-check" />}
    </button>
  );
}

export function ModelChip(props: { chat: ConversationSummary; agentId: string | null; openSignal?: number }) {
  const { chat, agentId } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => { if (props.openSignal) setOpen(true); }, [props.openSignal]);
  useEffect(() => {
    // the catalog from the start: the chip names its model by the catalog's name and the menu opens with its list
    // (loaded only on open, the name changed and the list filled in after the click); asked again while still empty
    if (!models.peek().length) void loadModels().catch(() => undefined);
    if (!open) setQuery('');
  }, [open]);
  const used = agentId ? lastUsed(chat.id, agentId) : undefined;
  const route = useRoutePreview(agentId, chat.id, [used, models.value]); // asked anew after a turn on another model
  if (!agentId) return <span class="chip model-chip placeholder" aria-hidden="true" />;

  const chosen = chosenModel(chat.settings, agentId);
  // what answers with nothing chosen: the routed model, its last run here until the preview answers
  const routed = route?.modelId ?? (chosen ? undefined : used);
  const effort = chat.settings.efforts?.[agentId] as Effort | undefined;
  const chosenInfo = chosen ? models.value.find((model) => model.id === chosen) : undefined;
  const sub = chosen && effort ? EFFORT_LABEL[effort] : undefined;
  const efforts: Effort[] = (chosenInfo?.efforts.length ? chosenInfo.efforts : (['low', 'medium', 'high', 'max'] as Effort[])).filter((value) => value !== 'none');
  const pick = (id: string) => { setOpen(false); void save(chat, pickPatch(chat.settings, agentId, id)); };
  const label = (
    <span class="chip-label">
      {shortName(chosen ?? routed) ?? (can('routing.preview') ? '' : PER_TASK)}{sub && <span class="sub">{` ${sub}`}</span>}
    </span>
  );
  if (!can('chats.update')) return <span class="chip model-chip static">{label}</span>;
  const q = query.trim().toLowerCase();
  // Specialists (embeddings, decision, media) are no chat models – a stored choice stays visible.
  const list = models.value.filter((model) => (isChatModel(model) || model.id === chosen)
    && (!q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)));

  return (
    <>
      <button ref={ref} type="button" class="chip model-chip" aria-haspopup="menu" aria-expanded={open} title="Model" onClick={() => setOpen(!open)}>
        {label}
        <Icon name="caret-down" size={12} class="chip-caret" />
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="top-end" width={300} class="menu model-menu" role="menu" label="Model">
        <input class="input menu-search" type="text" placeholder="Search models" aria-label="Search models" value={query} autoFocus
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
        <div class="model-list">
          {!q && (
            <button type="button" class="menu-item" role="menuitemradio" aria-checked={!chosen} onClick={() => pick('auto')}>
              <span class="menu-label"><span>{shortName(routed) ?? PER_TASK}</span></span>
              {routed && <span class="menu-hint">{PER_TASK}</span>}
              {!chosen && <Icon name="check" size={16} class="menu-check" />}
            </button>
          )}
          {list.map((model) => <ModelRow key={model.id} model={model} selected={chosen === model.id} onPick={() => pick(model.id)} />)}
          {q && !list.length && <p class="empty-state">No models</p>}
        </div>
        <div class="menu-section effort-row" role="group" aria-label="Effort">
          {efforts.map((value) => (
            <button type="button" key={value} class={`effort${effort === value ? ' on' : ''}`} aria-pressed={effort === value}
              onClick={() => void save(chat, { efforts: effort === value ? withoutEffort(chat, agentId) : { ...(chat.settings.efforts ?? {}), [agentId]: value } })}>
              {EFFORT_LABEL[value]}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function withoutEffort(chat: ConversationSummary, agentId: string): Record<string, string> {
  const efforts = { ...(chat.settings.efforts ?? {}) };
  delete efforts[agentId];
  return efforts;
}
