// Scopes used by the people tests (F-52). Owns: fixtures only.

import type { ClientScope } from '../../../src/shared/api/protocol.ts';

/** One of the owner's own phones with full access (not a person of the organisation). */
export const DEVICE_SCOPE_PHONE: ClientScope = { kind: 'device', deviceId: 'dev_owner_phone', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'], secure: true };
