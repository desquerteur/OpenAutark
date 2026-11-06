// A model's short name as the composer's model chip, the working line and the model tag under a message say
// it: the catalog's name (models.list) without the vendor word ("Claude Opus 5.5" → "Opus 5.5", chat/live-text.ts
// shortModelName), else the id's last segment ("codex:gpt-6" → "gpt-6").
// Owns: the catalog lookup. Never: loads the catalog (the store's loadModels does).

import { models } from './store.ts';
import { shortModelName } from '../chat/live-text.ts';

export function modelShortName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const info = models.value.find((model) => model.id === id || model.model === id);
  return info ? shortModelName(info.name) : id.split(':').pop();
}
