// RPC handlers of the team side of feedback (B-055 Q2/Q3): the inbox on the PC holding the team's key and
// `wf feedback setup`. Every method is owner-only: the desktop window and the local wf CLI with the launch token,
// never a phone, a linked PC or an agent (the inbox holds other people's reports, setup writes keys).
// Owns: param checks. Never: the inbox or setup behaviour (runtime/feedback/inbox.ts, setup.ts).

import { WorkforceError } from '../../../shared/errors.ts';
import { DOCUMENT_ID } from '../../feedback/drop.ts';
import type { FeedbackApi } from '../extras.ts';
import { bad, input, onlyKeys, optBool, text, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

function inbox(ctx: HandlerContext): NonNullable<FeedbackApi['inbox']> {
  const api = ctx.extras.feedback.inbox;
  if (!api) throw new WorkforceError('unavailable', 'The feedback inbox is not available.');
  return api;
}

function reportId(o: Obj): string {
  const id = text(o, 'id', { max: 64 });
  if (!DOCUMENT_ID.test(id)) bad('id', 'a report id');
  return id;
}

export function register(table: HandlerTable): void {
  table.add('feedback.inboxList', (params, ctx) => {
    onlyKeys(input(params), []);
    return inbox(ctx).list();
  });
  table.add('feedback.inboxFetch', (params, ctx) => {
    onlyKeys(input(params), []);
    return inbox(ctx).fetch();
  });
  table.add('feedback.inboxRemove', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return inbox(ctx).remove(reportId(o));
  });
  table.add('feedback.inboxScreenshot', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return inbox(ctx).screenshot(reportId(o));
  });
  table.add('feedback.setup', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['project', 'apiKey', 'serviceAccountPath', 'rotate']);
    const setup = ctx.extras.feedback.setup;
    if (!setup) throw new WorkforceError('unavailable', 'Feedback setup is not available.');
    return setup.call(ctx.extras.feedback, {
      project: text(o, 'project', { max: 30 }),
      apiKey: text(o, 'apiKey', { max: 100 }),
      serviceAccountPath: text(o, 'serviceAccountPath', { max: 1024 }),
      rotate: optBool(o, 'rotate'),
    });
  });
}
