// day.* (B-041 My day, shared/api/methods-day.ts): the person's own input, planning a day, the morning briefing and
// the work handed off – for the owner's window and phones holding 'todo' (a To-do-only phone runs its day); handing
// an own to-do to the team needs 'tasks'. Everything delegates to services.day and answers 'unavailable' while it is
// missing. Devices act as the owner ('human'). No person variants in this build; external agents have none.
// Owns: parameter checks and scope rules. Never: My day's rules (runtime/day/*).

import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import '../../../shared/api/methods-day.ts'; // the method shapes (module augmentation)
import { DAY_PLAN_MODES, isLocalDate } from '../../../shared/model/calendar.ts';
import '../../contracts/calendar.ts';
import type { DayService } from '../../contracts/calendar.ts';
import { bad, id, input, num, oneOf, onlyKeys, optBool, optNum, optText, text, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const TASKS = { capability: 'tasks' } as const;

function dayOf(ctx: HandlerContext): DayService {
  const service = ctx.services.day;
  if (!service) throw new WorkforceError('unavailable', 'My day is not available yet.', { details: { service: 'day' } });
  return service;
}

/** A local calendar day 'YYYY-MM-DD' that exists. */
function date(o: Obj): string {
  const value = text(o, 'date', { max: 10 });
  if (!isLocalDate(value)) bad('date', 'a day as YYYY-MM-DD');
  return value;
}

export function register(table: HandlerTable): void {
  table.add('day.add', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'private', 'clientId', 'date']);
    const day = o.date === undefined || o.date === null ? undefined : date(o);
    return dayOf(ctx).add({
      text: text(o, 'text', { max: 8000, multiline: true }), private: optBool(o, 'private'), clientId: optText(o, 'clientId', { max: 100 }), ...(day ? { date: day } : {}),
    }, HUMAN_ID);
  }, TODO);

  table.add('day.plan', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['date', 'mode']);
    return dayOf(ctx).plan(HUMAN_ID, date(o), oneOf(o, 'mode', DAY_PLAN_MODES));
  }, TODO);

  table.add('day.briefing', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['date']);
    return dayOf(ctx).briefing(HUMAN_ID, date(o));
  }, TODO);

  table.add('day.sendToTeam', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return dayOf(ctx).sendToTeam(id(o), HUMAN_ID);
  }, TASKS);

  table.add('day.handedOff', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['since']);
    return dayOf(ctx).handedOff(HUMAN_ID, optNum(o, 'since', { min: 0 }));
  }, TODO);
}
