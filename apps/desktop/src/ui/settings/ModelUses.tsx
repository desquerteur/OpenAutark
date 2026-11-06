// Settings › Models, under the providers: one fixed row per use – state dot, label, hint, provider select, model select
// and the action slot (Download or Use for a local model, "Set up with AI" where nothing or only a stand-in serves it) –
// plus the model choice row (Best / Balanced / Cheaper). B-072: no fallback switch – when plans run out the app takes what
// is left by itself, and routing.allowPaidFallback stays in settings.json for the AI. The selects show the model the use
// runs on right now (models.uses, read again when accounts, models, settings or a local model change); a
// pick writes settings.json (uses-view.ts). "Other…" (or a connection with no listed model for the use) swaps the model
// select for a text field in the same box: Enter or leaving it writes the name, Esc goes back. The AI changes the same keys
// (skill ai-providers). A right click copies the row's key or opens settings.json in the pane's file tab.
// Owns: these rows. Never: resolves a use (the runtime does), or words a row (uses-view.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import { MODEL_USES, USE_LABELS, type ModelUse, type UseNow } from '../../shared/model/models-uses.ts';
import type { RoutingSettings } from '../../shared/model/system.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { accounts, models, settings, updateSettings } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { setUpWithAi } from '../team/set-up-with-ai.ts';
import { act, ActionButton, Group, Row, Segmented, Select, useAsync, type Option } from './controls.tsx';
import { openInTab } from './open-file.ts';
import { localModels, pullModel, readLocalModels, speechChanges, speechPulls, useModel, watchSpeechPulls } from './speech-models.ts';
import { running } from './speech-models-text.ts';
import { namedValue, OTHER, setUpRequest, useRowView, writeModel, writeProvider, type UseWrite } from './uses-view.ts';

const COST_MODES: Array<Option<RoutingSettings['costMode']>> = [{ value: 'best', label: 'Best' }, { value: 'balanced', label: 'Balanced' }, { value: 'economy', label: 'Cheaper' }];
const STATE_WORD: Readonly<Record<string, string>> = { ready: 'Ready', setup: 'Needs one step', off: 'Off', pending: '' };

function save(write: UseWrite | undefined): void {
  if (!write) return;
  const { download, ...patch } = write;
  void act(async () => {
    if (patch.routing || patch.voice) await updateSettings(patch);
    speechChanges.value = speechChanges.peek() + 1;
  }, 'Could not save');
  if (download) void pullModel(download);
}

/** The model cell's text field: same box as the select, the name is written on Enter or on leaving it. */
function ModelName(props: { label: string; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const finished = useRef(false); // the field going away may blur it once more
  useEffect(() => field.current?.focus(), []);
  const finish = (value: string | undefined) => {
    if (finished.current) return;
    finished.current = true;
    props.onDone(value);
  };
  return (
    <input ref={field} class="set-input use-name" aria-label={props.label} placeholder="Model name" spellcheck={false} value={name}
      onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
      onBlur={() => finish(name.trim() || undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(name.trim() || undefined);
        if (event.key === 'Escape') finish(undefined);
      }} />
  );
}

function UseRow(props: { use: ModelUse; now: UseNow | undefined }) {
  const { use, now } = props;
  const entries = settings.value?.providers;
  /** The connection a model name is being typed for. */
  const [naming, setNaming] = useState<string | undefined>();
  const offers = localModels.value?.models ?? [];
  const target = now?.action?.kind === 'download-model' ? now.action.target : undefined;
  const pulls = speechPulls.value;
  const mine = Object.values(pulls).filter((entry) => offers.some((offer) => offer.id === entry.id && offer.purpose === use));
  // a running download first: the model picked in the select need not be the one the action offers
  const pull = mine.find((entry) => running(entry)) ?? (target ? pulls[target] : mine.find((entry) => entry.state === 'failed'));
  const view = useRowView(use, now, models.value, accounts.value, offers, pull, can('voice.pullLocal'), entries);
  const locked = !now || !can('settings.update');
  const pickProvider = (provider: string) => {
    const write = writeProvider(use, provider, models.value, accounts.value, offers, settings.value?.voice);
    setNaming(!write && accounts.value.some((account) => account.id === provider) ? provider : undefined); // a connection with no listed model takes a name
    save(write);
  };
  const named = (name: string | undefined) => {
    const provider = naming;
    setNaming(undefined);
    if (name && provider) save(writeModel(use, provider, namedValue(provider, name, accounts.value, entries), models.value, offers));
  };
  const press = () => {
    if (view.button?.kind === 'ai') { void setUpWithAi(setUpRequest(use)); return; }
    const id = view.button?.target;
    if (!id) return;
    void (offers.some((offer) => offer.id === id && offer.installed) ? useModel(id) : pullModel(id));
  };
  const menu = () => [{ items: [
    { label: `Copy key routing.${use}`, onSelect: () => { void navigator.clipboard?.writeText(`routing.${use}`).then(() => pushToast({ title: `routing.${use} copied` })); } },
    { label: 'Open settings.json', onSelect: () => void openInTab('settings.json') },
  ] }];
  return (
    <Row class="use-row" reserve hint={view.hint} menu={menu} label={(
      <>
        <span class={`dot use-dot ${view.state}`} title={STATE_WORD[view.state] || undefined} aria-hidden="true" />
        <span>{USE_LABELS[use]}</span>
        {STATE_WORD[view.state] && <span class="sr-only">{STATE_WORD[view.state]}</span>}
      </>
    )}>
      <Select label={`${USE_LABELS[use]}: provider`} value={naming ?? view.provider} options={view.providers} disabled={locked} onChange={pickProvider} />
      {naming
        ? <ModelName label={`${USE_LABELS[use]}: model name`} onDone={named} />
        : (
          <Select label={`${USE_LABELS[use]}: model`} value={view.model} options={view.models} disabled={locked || view.modelFixed}
            onChange={(model) => { if (model === OTHER) setNaming(view.provider); else save(writeModel(use, view.provider, model, models.value, offers)); }} />
        )}
      <span class="account-slot">
        {view.button && <ActionButton label={view.button.label} disabled={view.button.disabled} onClick={press} />}
      </span>
    </Row>
  );
}

/** The use rows and the model choice. */
export function ModelUses() {
  const current = settings.value;
  const list = useAsync(() => rpc.call('models.uses'), [accounts.value, models.value, current?.routing, current?.voice, speechChanges.value]);
  useEffect(() => {
    watchSpeechPulls();
    if (localModels.peek() === undefined) void readLocalModels();
  }, []);
  const byUse = new Map((list.data ?? []).map((now) => [now.use, now]));
  const setRouting = (patch: Partial<RoutingSettings>) => void act(() => updateSettings({ routing: patch }), 'Could not save');
  return (
    <Group title="Uses" id="settings-uses" hint={list.error && !list.data ? list.error : undefined}>
      {MODEL_USES.map((use) => <UseRow key={use} use={use} now={byUse.get(use)} />)}
      <Row label="Model choice" hint="What counts when the app picks among several models" reserve>
        <Segmented label="Model choice" value={current?.routing.costMode ?? 'balanced'} options={COST_MODES} onChange={(costMode) => setRouting({ costMode })} />
      </Row>
    </Group>
  );
}
