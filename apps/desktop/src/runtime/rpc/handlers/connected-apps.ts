// apps.* (connectors, shared/api/methods-apps.ts): connectors are files the AI edits (<data>/connectors/, skill
// connect-apps). The RPC lists them with their state ('settings' – a phone sees what its team can reach) and
// starts a sign-in again (apps.reconnect, owner). Both delegate to services.apps and answer 'unavailable' while
// it is missing.
// Owns: parameter checks and scope rules. Never: app rules (runtime/apps/*), or a token, password, header or env
// value in an answer, an error or a log.

import { WorkforceError } from '../../../shared/errors.ts';
import '../../../shared/api/methods-apps.ts'; // the method shapes (module augmentation)
import { APP_ID_PATTERN } from '../../../shared/model/apps.ts';
import '../../contracts/apps.ts';
import type { AppsService } from '../../contracts/apps.ts';
import { bad, input, onlyKeys } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const SETTINGS = { capability: 'settings' } as const;

function appsOf(ctx: HandlerContext): AppsService {
  const service = ctx.services.apps;
  if (!service) throw new WorkforceError('unavailable', 'Connected apps are not available yet.', { details: { service: 'apps' } });
  return service;
}

export function register(table: HandlerTable): void {
  table.add('apps.list', (params, ctx) => {
    onlyKeys(input(params), []);
    return appsOf(ctx).list();
  }, SETTINGS);

  table.add('apps.reconnect', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const id = o.id;
    if (typeof id !== 'string' || !APP_ID_PATTERN.test(id)) bad('id', 'an app id');
    return appsOf(ctx).reconnect(id);
  });
}
