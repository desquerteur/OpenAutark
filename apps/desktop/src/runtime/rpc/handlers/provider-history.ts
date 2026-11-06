// RPC handlers (wave 2; B-044: the Claude Code account rows of Settings › Models): privacy.providerHistories
// and privacy.purgeProviderHistory (confirm: true) – both owner-only on the PC (they name and clear
// this PC's provider account folders through the provider's CLI).
// Owns: param checks. Never: business logic (privacy/native-history.ts via privacy/service.ts).

import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/lifecycle.ts';
import '../../../shared/api/methods-provider-history.ts'; // the method shapes (module augmentation)
import { bad, id, input, onlyKeys } from '../params.ts';
import type { HandlerTable } from '../table.ts';

function privacy(services: RuntimeServices) {
  if (!services.privacy) throw new WorkforceError('unavailable', 'Data & privacy is not available in this runtime.');
  return services.privacy;
}

export function register(table: HandlerTable): void {
  table.add('privacy.providerHistories', (params, ctx) => {
    onlyKeys(input(params ?? {}), []);
    return privacy(ctx.services).providerHistories();
  });
  table.add('privacy.purgeProviderHistory', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['accountId', 'confirm']);
    if (o.confirm !== true) bad('confirm', 'true (deleting the provider history cannot be undone)');
    return privacy(ctx.services).purgeProviderHistory(id(o, 'accountId'));
  });
}
