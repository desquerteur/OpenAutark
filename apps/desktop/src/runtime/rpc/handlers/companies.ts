// B-072: companies.list and companies.open, the companies on this PC (shared/model/companies.ts) for the profile menu and
// for agents (wf call companies.list). The list comes from the data folders (runtime/root/companies.ts); opening one is
// main's (host op company.open, main/companies.ts). B-075: the list names the current company's role and linked PCs, and
// companies.tool runs one agent tool here for an agent of another company on this PC (tools/builtin/companies.ts). Owner
// scope: all three are about this PC (another company's runtime calls with this one's owner token, over loopback).
// Owns: these registrations and their params. Never: the folder rule, starting a company or running a tool itself.

import '../../../shared/model/companies.ts'; // the method shapes (module augmentation)
import { WorkforceError } from '../../../shared/errors.ts';
import { isCompanyId, isCompanyStart } from '../../../shared/model/companies.ts';
import { listCompanies } from '../../root/companies.ts';
import { runCompanyTool, withOwnFacts } from '../../tools/builtin/companies.ts';
import { bad, input, onlyKeys, optBool, optObj, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('companies.list', (params, ctx) => {
    onlyKeys(input(params), []);
    return { companies: withOwnFacts(ctx.services, listCompanies(ctx.services.host.app)) };
  });
  table.add('companies.open', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'create', 'start']);
    const raw = o.id;
    const id = raw === undefined || raw === null ? null : isCompanyId(raw) ? raw : bad('id', 'a company id from companies.list, or null for the first company');
    const create = optBool(o, 'create') === true;
    const start = o.start === undefined ? undefined : isCompanyStart(o.start) ? o.start : bad('start', "'new', 'mine' or 'employee'");
    const { host } = ctx.services;
    if (!host.openCompany || !host.app.companies) throw new WorkforceError('unavailable', 'Other companies open only in the desktop app.');
    return host.openCompany(create ? { id, create, ...(start ? { start } : {}) } : { id });
  });
  table.add('companies.tool', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'args', 'agentId', 'agentName', 'runId', 'mode', 'from']);
    const call = {
      name: text(o, 'name', { max: 120 }), args: optObj(o, 'args') ?? {}, agentId: text(o, 'agentId', { max: 200 }), agentName: optText(o, 'agentName', { max: 200 }),
      runId: text(o, 'runId', { max: 200 }), mode: optText(o, 'mode', { max: 200 }), from: optText(o, 'from', { max: 200 }),
    };
    return runCompanyTool(ctx.services, call, ctx.signal);
  });
}
