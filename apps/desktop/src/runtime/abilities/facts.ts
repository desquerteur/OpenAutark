// B-058 G14: the facts the abilities overview is computed from (status.ts abilityList), read from the runtime
// without any network or model load: the local speech models (voice.localModels' rows and the chosen ones),
// the function models (models/functions.ts), a model that hears audio
// (decision/engine-runner.ts listenOptions), one that sees images (the catalog's vision flag, free
// connections first), what the host can do (decode audio, take video frames), whether the browser and
// computer tools are registered (B-055 builds them; read only), and how each kind of media is made now
// (media/generate-route.ts routesFor – the same rule the generation tools use). Every read is guarded: a
// part that cannot be read counts as missing, never as an error of the whole overview.
// Owns: these reads. Never: changes anything, loads a model, or reads a key.

import type { RuntimeServices } from '../contracts.ts';
import { AUDIO_TAGGER, localSpeechModel, type LocalSpeechOffer } from '../../shared/model/local-speech-models.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { listenOptions } from '../decision/engine-runner.ts';
import { FUNCTION_OF } from '../media/generate.ts';
import { routesFor } from '../media/generate-route.ts';
import { GENERATION_KINDS, type GenerationKind } from '../media/providers/types.ts';
import { functionStatus } from '../models/functions.ts';
import { chargeOf } from '../models/pricing.ts';
import { isInstalled } from '../voice/local/store.ts';
import type { AbilityFacts, LocalNamed, MakeFact, Named } from './status.ts';

type Services = RuntimeServices;

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const local = (offer: LocalSpeechOffer): LocalNamed => ({ id: offer.id, label: offer.label, downloadMb: offer.downloadMb });

/** "<model name> · <account label>" for a catalog model on one of its accounts. */
function nameOf(s: Services, modelId: string, accountId: string | undefined): Named | undefined {
  const model = quiet(() => s.catalog.get(modelId), undefined);
  if (!model) return undefined;
  const account = accountId ? quiet(() => s.accounts.get(accountId), undefined) : undefined;
  return { model: model.name, via: account?.label ?? model.provider };
}

/** The first healthy account that runs `model`, free connections first. */
function accountFor(s: Services, model: ModelInfo): Account | undefined {
  const accounts = quiet(() => s.accounts.candidates(model.engine, model.model), [] as Account[])
    .filter((account) => account.provider === model.provider && (!model.accounts.length || model.accounts.includes(account.id)));
  return accounts.find((account) => chargeOf(account) !== 'paid') ?? accounts[0];
}

/** A connected model that sees images (general models only), one on a free connection first. */
function visionModel(s: Services): Named | undefined {
  const seeing = quiet(() => s.catalog.list(), [] as ModelInfo[]).filter((model) => model.available && model.caps.vision === true && !model.functions?.length);
  const paired = seeing.map((model) => ({ model, account: accountFor(s, model) })).filter((entry) => entry.account);
  const pick = paired.find((entry) => chargeOf(entry.account!) !== 'paid') ?? paired[0];
  return pick ? { model: pick.model.name, via: pick.account!.label } : undefined;
}

function listener(s: Services): Named | undefined {
  const options = quiet(() => listenOptions(s), undefined);
  const model = options?.models[0];
  if (!model) return undefined;
  const account = accountFor(s, model);
  return account ? { model: model.name, via: account.label } : undefined;
}

function makeFact(s: Services, kind: GenerationKind, offers: readonly LocalSpeechOffer[]): MakeFact {
  if (quiet(() => functionStatus(s, FUNCTION_OF[kind]).off, false)) return { via: 'none', off: true };
  const first = quiet(() => routesFor(s, kind).first, undefined);
  if (first?.via === 'model') {
    const shown = nameOf(s, first.target.modelId, first.target.account.id) ?? { model: first.target.modelId, via: first.target.account.label };
    return { via: 'model', named: shown };
  }
  if (first?.via === 'plan') return { via: 'plan' };
  if (first?.via === 'local') {
    const voices = offers.filter((offer) => offer.purpose === 'tts');
    const installed = voices.find((offer) => offer.installed);
    const fetch = voices.find((offer) => offer.recommended) ?? voices[0];
    return installed ? { via: 'local', installed: true } : { via: 'local', installed: false, ...(fetch ? { id: fetch.id, downloadMb: fetch.downloadMb } : {}) };
  }
  return { via: 'none', off: false };
}

/** Everything abilityList needs, read now. */
export function abilityFacts(s: Services): AbilityFacts {
  const speech = quiet(() => s.stt.localModels(), undefined);
  const offers = speech?.models ?? [];
  const settings = quiet(() => s.settings.get(), undefined);
  const voice = settings?.voice;
  const chosen = localSpeechModel(voice?.localStt, 'stt');
  const sttOffers = offers.filter((offer) => offer.purpose === 'stt');
  const chosenOffer = chosen ? sttOffers.find((offer) => offer.id === chosen.id && offer.installed) : undefined;
  const otherInstalled = chosenOffer ? undefined : sttOffers.find((offer) => offer.installed);
  const recommended = sttOffers.find((offer) => offer.recommended && !offer.installed);
  const stt = quiet(() => functionStatus(s, 'stt'), undefined);
  const media = quiet(() => s.host.media, undefined);
  const make = Object.fromEntries(GENERATION_KINDS.map((kind) => [kind, makeFact(s, kind, offers)])) as Record<GenerationKind, MakeFact>;
  const hears = listener(s);
  const sees = visionModel(s);
  return {
    engine: speech?.engine.ready === true,
    ...(chosenOffer ? { stt: local(chosenOffer) } : {}),
    ...(otherInstalled ? { sttInstalled: local(otherInstalled) } : {}),
    ...(recommended ? { sttRecommended: local(recommended) } : {}),
    ...(stt?.choice && !stt.off ? { sttService: nameOf(s, stt.choice.modelId, stt.choice.accountId) ?? { model: stt.choice.model, via: stt.choice.provider } } : {}),
    hostDecodes: typeof media?.audio === 'function',
    hostFrames: typeof media?.keyframes === 'function',
    ...(hears ? { listener: hears } : {}),
    tagger: quiet(() => isInstalled(s.paths.data, AUDIO_TAGGER), false),
    ...(sees ? { vision: sees } : {}),
    web: { tools: quiet(() => Boolean(s.tools.get('browser.open')), false) },
    pc: { tools: quiet(() => Boolean(s.tools.get('computer.screenshot')), false) && process.platform === 'win32' },
    make,
  };
}
