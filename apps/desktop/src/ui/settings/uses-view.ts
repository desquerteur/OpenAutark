// What one use row of Settings › Models shows and writes, pure. The row's selects show what the use resolves to right
// now (UseNow, models.uses): the provider select lists the accounts that can serve the use and the connections of the file
// (a name the server does not list can serve anything they speak), "This PC" where a model of this PC can, "Off" where the
// use may be off, and "None" only while nothing serves it – as the answer: until models.uses has answered both cells stay
// empty; the model select lists that provider's models for the use (a plan on Work first its pick for each turn – the
// model it runs now, "<model> · each turn", on the plan in use – This PC its local models by name), and on a connection
// of the file last "Other…", which swaps to a text field in the same box. A cell names a model, never a mode: Work on
// the plan in use, Embeddings and Voice on this PC as models.uses names them ("This PC" only where it names none), the
// ChatGPT plan's images their model, GPT Image. What really runs always stands among the options, even when it is
// not listed. A pick becomes a change of settings.json
// (UseWrite: routing.<use>, for speech and voice also the voice keys; a local model not on this PC yet: a download).
// Row layout: [label + hint] [provider] [model or the text field] [action].
// Owns: these options, the row's words and those writes. Never: reads signals, writes settings or renders.

import { accountCharge } from '../../shared/model/charge.ts';
import type { LocalSpeechOffer, LocalSpeechPull } from '../../shared/model/local-speech-models.ts';
import { FREE_ROUTE_CHOICE, OFFABLE_USES, USE_ABOUT, USE_AUTO, USE_LABELS, USE_LOCAL, USE_OFF, WORK_PLAN_PROVIDERS, modelsFor, voiceDefault, type ModelUse, type UseNow } from '../../shared/model/models-uses.ts';
import { modelOwner, type ProviderEntries } from '../../shared/model/provider-entries.ts';
import { DECISION_PROVIDER, MEDIA_ONLY_PROVIDERS, type Account, type ModelInfo } from '../../shared/model/providers.ts';
import type { RoutingSettings, VoiceSettings } from '../../shared/model/system.ts';
import { progressText, pullPercent, running } from './speech-models-text.ts';

export const THIS_PC = 'this-pc';
/** The provider and model value of "None", and of the model cell where there is nothing to pick. */
export const NOTHING = '';
/** The model option that swaps the cell to a text field. */
export const OTHER = 'other…';

export interface UseOption { value: string; label: string; hint?: string }

export interface UseRowView {
  provider: string;
  providers: UseOption[];
  model: string;
  models: UseOption[];
  /** The model cell has nothing to pick (None, Off, a call in this PC's speech models). */
  modelFixed: boolean;
  hint: string;
  state: UseNow['state'] | 'pending';
  /** The action slot: a download of a local model ('Download', 'Use', "42 %"), or the AI. */
  button?: { kind: 'download' | 'ai'; label: string; disabled: boolean; target?: string };
}

export interface UseWrite {
  routing?: Partial<RoutingSettings>;
  voice?: Partial<VoiceSettings>;
  /** A local model that has to come to this PC first (the download chooses it). */
  download?: string;
}

/** A cell before models.uses has answered: empty, in its usual box. */
const UNANSWERED: UseOption[] = [{ value: NOTHING, label: '' }];
const SET_UP_WITH_AI = 'Set up with AI';
const BEST_EACH_TURN = 'Best for each turn';
/** The ChatGPT plan's images: Codex's image tool, which runs OpenAI's GPT Image (media/codex-image.ts). */
const PLAN_IMAGES: UseOption = { value: FREE_ROUTE_CHOICE.image, label: 'GPT Image', hint: 'On the ChatGPT plan' };

/** What "Set up with AI" types into the Manager's chat. */
export const setUpRequest = (use: ModelUse): string => `Set up ${USE_LABELS[use]}: connect a provider or choose a model for it.`;

const isPlan = (account: Account) => account.enabled && account.auth === 'cli' && accountCharge(account) === 'plan';

/** The enabled accounts a catalog model runs on. */
function accountsOf(model: ModelInfo, accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => account.enabled && account.provider === model.provider && (!model.accounts.length || model.accounts.includes(account.id)));
}

/** A connection of the file can take a name for this use: by what it speaks (a decision connection serves decisions, and only that). */
function takesName(use: ModelUse, account: Account, entries: ProviderEntries | undefined): boolean {
  if (!account.enabled || !entries || !Object.hasOwn(entries, account.id)) return false;
  if (account.provider === DECISION_PROVIDER) return use === 'decision';
  if (MEDIA_ONLY_PROVIDERS.includes(account.provider)) return use !== 'work' && use !== 'decision' && use !== 'embeddings' && use !== 'voice';
  if (account.provider === 'anthropic') return use === 'work' || use === 'decision';
  if (use === 'video' || use === 'music' || use === 'sound') return account.provider === 'google'; // the OpenAI protocol has no endpoint for them (media/providers/openai.ts)
  return use !== 'voice' || account.provider === 'openai' || account.provider === 'compatible' || account.provider === 'google';
}

/** A key that talks in real time even when its server lists no such model (the use's default model, shared/model/models-uses.ts). */
const talksByDefault = (account: Account): boolean => account.enabled && (account.auth === 'api_key' || account.auth === 'env') && voiceDefault(account.provider) !== undefined;

/** The accounts that can serve `use`, in the accounts' order. */
export function servingAccounts(use: ModelUse, models: readonly ModelInfo[], accounts: readonly Account[], entries?: ProviderEntries): Account[] {
  const serving = new Set(modelsFor(use, models).flatMap((model) => accountsOf(model, accounts).map((account) => account.id)));
  return accounts.filter((account) => serving.has(account.id) || takesName(use, account, entries)
    || (use === 'voice' && talksByDefault(account))
    || (use === 'work' && isPlan(account) && WORK_PLAN_PROVIDERS.includes(account.provider))
    || (use === 'image' && isPlan(account) && account.provider === FREE_ROUTE_CHOICE.image));
}

/** The provider select: None while nothing serves, the accounts, This PC, Off; what runs now is always among them. */
export function providerOptions(use: ModelUse, now: UseNow | undefined, models: readonly ModelInfo[], accounts: readonly Account[], entries?: ProviderEntries): UseOption[] {
  const options: UseOption[] = servingAccounts(use, models, accounts, entries).map((account) => ({ value: account.id, label: account.label }));
  if (now?.accountId && !options.some((option) => option.value === now.accountId)) {
    options.push({ value: now.accountId, label: accounts.find((account) => account.id === now.accountId)?.label ?? now.accountId });
  }
  if (now?.thisPc) options.push({ value: THIS_PC, label: 'This PC' });
  if (OFFABLE_USES.has(use)) options.push({ value: USE_OFF, label: 'Off' });
  if (!now || now.kind === 'none') options.unshift({ value: NOTHING, label: 'None' });
  return options;
}

/** The model select of one provider value. */
export function modelOptions(use: ModelUse, provider: string, now: UseNow | undefined, models: readonly ModelInfo[], accounts: readonly Account[], offers: readonly LocalSpeechOffer[], entries?: ProviderEntries): UseOption[] {
  if (provider === NOTHING) return [{ value: NOTHING, label: 'None' }];
  if (provider === USE_OFF) return [{ value: NOTHING, label: 'Off' }];
  const options: UseOption[] = [];
  if (provider === THIS_PC) {
    const named = now?.kind === 'this-pc' && now.name ? now.name : 'This PC'; // a call: the models that hear and speak
    if (use === 'embeddings') options.push({ value: USE_LOCAL, label: named });
    else if (use === 'voice') options.push({ value: NOTHING, label: named });
    else {
      for (const offer of offers.filter((entry) => entry.purpose === use)) {
        options.push({ value: offer.id, label: offer.label, hint: offer.installed ? 'On this PC' : `${offer.downloadMb} MB download` });
      }
    }
  } else {
    const account = accounts.find((entry) => entry.id === provider);
    if (account && isPlan(account)) {
      if (use === 'work' && WORK_PLAN_PROVIDERS.includes(account.provider)) {
        const current = now?.kind === 'plan' && now.modelId === account.provider && now.accountId === account.id ? now.name : undefined;
        options.push(current ? { value: account.provider, label: `${current} · each turn`, hint: BEST_EACH_TURN } : { value: account.provider, label: BEST_EACH_TURN });
      }
      if (use === 'image' && account.provider === FREE_ROUTE_CHOICE.image) options.push(PLAN_IMAGES);
    }
    if (account) {
      for (const model of modelsFor(use, models).filter((entry) => accountsOf(entry, [account]).length > 0)) {
        options.push({ value: model.id, label: model.name || model.model });
      }
      if (use === 'voice' && !options.length && talksByDefault(account)) options.push({ value: `${modelOwner(account, entries)}:${voiceDefault(account.provider)}`, label: voiceDefault(account.provider)! });
    }
  }
  if (now?.modelId && now.accountId === (provider === THIS_PC ? undefined : provider) && !options.some((option) => option.value === now.modelId)) {
    options.unshift({ value: now.modelId, label: now.name ?? now.modelId });
  }
  const account = accounts.find((entry) => entry.id === provider);
  if (account && takesName(use, account, entries)) options.push({ value: OTHER, label: 'Other…', hint: 'A model name the server does not list' });
  return options;
}

/** The value of a model name typed for the account `provider`. */
export function namedValue(provider: string, name: string, accounts: readonly Account[], entries?: ProviderEntries): string {
  const account = accounts.find((entry) => entry.id === provider);
  return `${account ? modelOwner(account, entries) : provider}:${name.trim()}`;
}

const providerOf = (now: UseNow | undefined): string => {
  if (!now || now.kind === 'none') return NOTHING;
  if (now.kind === 'off') return USE_OFF;
  if (now.kind === 'this-pc') return THIS_PC;
  return now.accountId ?? NOTHING;
};

/** The hint: a running download or its failure, a stored choice that cannot serve, the note, else what the use is for. */
function hintOf(use: ModelUse, now: UseNow | undefined, pull: LocalSpeechPull | undefined, offers: readonly LocalSpeechOffer[]): string {
  const target = now?.action?.kind === 'download-model' ? now.action.target : undefined;
  const label = offers.find((offer) => offer.id === (pull?.id ?? target))?.label;
  if (pull && running(pull)) return `${progressText(pull)}${label ? ` · ${label}` : ''}`;
  if (pull?.state === 'failed') return pull.error || `${label ?? 'The model'} could not be downloaded.`;
  if (now?.gone) return `${now.gone} is not available now`;
  return now?.note ?? USE_ABOUT[use];
}

/** One row (`now` undefined: models.uses has not answered). `pull`: the last event of the local model this row is about. */
export function useRowView(use: ModelUse, now: UseNow | undefined, models: readonly ModelInfo[], accounts: readonly Account[], offers: readonly LocalSpeechOffer[], pull: LocalSpeechPull | undefined, canDownload: boolean, entries?: ProviderEntries): UseRowView {
  const provider = providerOf(now);
  const options = modelOptions(use, provider, now, models, accounts, offers, entries);
  const target = now?.action?.kind === 'download-model' ? now.action.target : undefined;
  const pulling = running(pull);
  const button: UseRowView['button'] = !now ? undefined
    : pulling || target ? { kind: 'download', label: pulling ? `${pullPercent(pull!)} %` : now.action?.label ?? 'Download', disabled: pulling || !canDownload, ...(target ? { target } : {}) }
      : now.kind === 'none' || now.action?.kind === 'ai' || now.gone ? { kind: 'ai', label: SET_UP_WITH_AI, disabled: false }
        : undefined;
  return {
    provider, providers: now ? providerOptions(use, now, models, accounts, entries) : UNANSWERED,
    model: now ? now.modelId ?? (options[0]?.value ?? NOTHING) : NOTHING, models: now ? options : UNANSWERED,
    modelFixed: !now || now.kind === 'none' || now.kind === 'off' || (use === 'voice' && now.kind === 'this-pc'),
    hint: hintOf(use, now, pull, offers), state: now?.state ?? 'pending', ...(button ? { button } : {}),
  };
}

/** A local model picked: on this PC it is chosen, else it comes first. Speech to text also forgets a service's "off". */
function localWrite(use: ModelUse, offer: LocalSpeechOffer | undefined): UseWrite {
  const routing: Partial<RoutingSettings> = use === 'stt' ? { stt: USE_AUTO } : { tts: USE_LOCAL };
  if (!offer) return { routing };
  if (!offer.installed) return { routing, download: offer.id };
  return { routing, voice: use === 'stt' ? { localStt: offer.id } : { localTts: offer.id } };
}

/** A model picked in the model select of `provider`. */
export function writeModel(use: ModelUse, provider: string, value: string, models: readonly ModelInfo[], offers: readonly LocalSpeechOffer[]): UseWrite {
  if (provider === THIS_PC) {
    if (use === 'embeddings') return { routing: { embeddings: USE_LOCAL } };
    if (use === 'voice') return { voice: { realtime: 'off' } };
    return localWrite(use, offers.find((offer) => offer.id === value));
  }
  if (use === 'voice') {
    // the Voice use may name its account: "<accountId>:<model>" (calls/realtime/setup.ts)
    const model = models.find((entry) => entry.id === value)?.model ?? value.slice(value.indexOf(':') + 1);
    return { routing: { voice: `${provider}:${model}` }, voice: { realtime: 'auto' } };
  }
  if (use === 'stt') return { routing: { stt: value }, voice: { localStt: '' } }; // this PC's model comes first while it is chosen
  return { routing: { [use]: value } };
}

/** A provider picked: Off, This PC (the local model that fits), or the account's first option. */
export function writeProvider(use: ModelUse, provider: string, models: readonly ModelInfo[], accounts: readonly Account[], offers: readonly LocalSpeechOffer[], settings: Pick<VoiceSettings, 'localStt' | 'localTts'> | undefined): UseWrite | undefined {
  if (provider === NOTHING) return undefined;
  if (provider === USE_OFF) return use === 'stt' ? { routing: { stt: USE_OFF }, voice: { localStt: '' } } : { routing: { [use]: USE_OFF } };
  if (provider === THIS_PC && (use === 'stt' || use === 'tts')) {
    const mine = offers.filter((offer) => offer.purpose === use);
    const chosen = use === 'stt' ? settings?.localStt : settings?.localTts;
    return localWrite(use, mine.find((offer) => offer.id === chosen && offer.installed) ?? mine.find((offer) => offer.installed) ?? mine.find((offer) => offer.recommended) ?? mine[0]);
  }
  const first = modelOptions(use, provider, undefined, models, accounts, offers)[0]; // nothing here: a connection with no listed model takes a name (the row)
  return first || provider === THIS_PC ? writeModel(use, provider, first?.value ?? NOTHING, models, offers) : undefined;
}
