// B-058 G14: abilities.status – the abilities overview for the AI
// (shared/model/abilities.ts; computed by runtime/abilities/status.ts from runtime/abilities/facts.ts – no network,
// no model load). Tier 'settings' (read-only; a device that may change settings may see what they turn on).
// B-058 (T7): voice.removeLocal – deletes a downloaded local speech model (runtime/abilities/remove-model.ts);
// tier 'settings' like the choice it clears (voice.localStt / localTts): a removal is undone by downloading
// again, and only voice.pullLocal – which fetches from the internet – stays with the owner.
// Owns: these registrations and their scopes. Never: the ability rules (runtime/abilities/**).

import '../../../shared/model/abilities.ts'; // the method shapes (module augmentation)
import type { Ability } from '../../../shared/model/abilities.ts';
import { localSpeechIds } from '../../../shared/model/local-speech-models.ts';
import { abilityFacts } from '../../abilities/facts.ts';
import { abilityList } from '../../abilities/status.ts';
import { removeLocalModel } from '../../abilities/remove-model.ts';
import { bad, input, onlyKeys, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('abilities.status', (params, ctx): Ability[] => {
    onlyKeys(input(params), []);
    return abilityList(abilityFacts(ctx.services));
  }, { capability: 'settings' });
  table.add('voice.removeLocal', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const id = text(o, 'id', { max: 80 });
    if (!localSpeechIds('stt').includes(id) && !localSpeechIds('tts').includes(id)) bad('id', 'a local speech model id from voice.localModels');
    return removeLocalModel(ctx.services, id);
  }, { capability: 'settings' });
}
