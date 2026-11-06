// Puts the vector system together for the composition root: the memory folder, the embedding model the use "embeddings"
// resolves to right now (one client per model), what a paid model costs (spend.ts), the background start and the settings hook.
// Owns: that wiring. Never: logic of its own.

import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { useValue, USE_AUTO } from '../../shared/model/models-uses.ts';
import { embeddingChoice } from '../models/embeddings.ts';
import { HttpEmbedder, type Embedder } from './embedders.ts';
import { LocalEmbedder } from './local-model.ts';
import { EmbedSpend } from './spend.ts';
import { VectorSystem } from './service.ts';

export function createVectors(s: RuntimeServices): VectorSystem {
  const local = new LocalEmbedder({ dataDir: s.paths.data });
  const spend = new EmbedSpend(() => s);
  let client: { key: string; embedder: Embedder } | undefined;
  const embedder = (): Embedder | undefined => {
    const choice = embeddingChoice(s, local.possible());
    if (!choice) return undefined;
    if (choice.kind === 'local') return local;
    const key = `${choice.accountId}|${choice.baseUrl}|${choice.model}`;
    if (client?.key !== key) {
      client = {
        key,
        embedder: new HttpEmbedder({
          provider: choice.provider, baseUrl: choice.baseUrl, model: choice.model, remote: !choice.local, sendDimensions: !choice.local,
          apiKey: () => s.accounts.apiKey(choice.accountId),
          onUsage: (use) => spend.add(choice, use),
        }),
      };
    }
    return client.embedder;
  };
  const choice = () => useValue(s.settings.get().routing, 'embeddings');
  const system = new VectorSystem({
    db: s.db, memoryRoot: path.join(s.paths.data, 'memory'), embedder, choice, standIn: () => choice() === USE_AUTO && local.gaveUp(), log: s.log,
    redact: (text) => s.secrets.redact(text), now: () => s.clock.now(), release: () => { local.stop(); spend.flush(); },
  });
  if (!process.env.WORKFORCE_TEST_DATA) system.start();
  s.bus.on('settings.updated', () => system.settingsChanged());
  return system;
}
