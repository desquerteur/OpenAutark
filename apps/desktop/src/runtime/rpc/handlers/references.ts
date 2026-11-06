// RPC handler of the references: references.remember – "Remember why…" on the caller's own message (the
// owner's window and phones). The rest is the agents' (references.find / capture tools) and the AI's.
// Owns: param checks. Never: storage rules (references/references.ts).

import { HUMAN_ID } from '../../../shared/ids.ts';
import '../../../shared/api/methods-references.ts'; // the references.* method shapes (module augmentation)
import { rememberWhy } from '../../references/references.ts';
import { id, input, onlyKeys, optBool, optOneOf, optText } from '../params.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('references.remember', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['messageId', 'why', 'whyKind', 'keepExample', 'situation', 'audience']);
    return rememberWhy(ctx.services, {
      messageId: id(o, 'messageId'), why: optText(o, 'why', { max: 4000, multiline: true, allowEmpty: true }),
      whyKind: optOneOf(o, 'whyKind', ['reason', 'goal', 'exception', 'style'] as const), keepExample: optBool(o, 'keepExample'),
      situation: optText(o, 'situation', { max: 300, allowEmpty: true }), audience: optText(o, 'audience', { max: 120, allowEmpty: true }),
    }, HUMAN_ID);
  }, { capability: 'chat' });
}
