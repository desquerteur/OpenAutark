// B-075 (owner 04.11.2026: an agent asked back instead of finding "Company 2" – "grundlegend ... dass es in solchen
// Situationen da richtig arbeitet"): the companies on this PC for agents. companies.list names each one – which one is
// this, its folder, the person's role there (owner, or employee of another firm), whether it runs, its linked PCs (asked
// from its own runtime) – and runCompanyTool is the receiving side of tools.call with company (tools/placement.ts →
// registry.ts → this runtime's companies.tool): one tool runs here for an agent of another company on this PC, like a
// call of this company's own agent (a stand-in named with its company, no linked-PC limits); what goes back has the
// values of this company's secrets masked.
// The person is an employee in a company that joined another firm's PC as an employee (devices/sync/home.ts 'employer').
// Owns: that tool, the role rule and that executor. Never: runs a call from another company where the person is an
// employee (another firm's data), runs tools.find / tools.call for one, forwards one on to another PC, or sends values of
// this company's secrets back.

import type { RuntimeServices } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { CompanyEntry, CompanyRole, CompanyToolCall } from '../../../shared/model/companies.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { DEVICE_ARG, json, text } from '../types.ts';
import { validate } from '../validate.ts';
import { META_TOOLS } from '../core-sets.ts';
import { folderOf, resolveDevice, safeSelfId } from '../placement.ts';
import { callCompany, companyFolder, companyRuns, listCompanies } from '../../root/companies.ts';
import { links } from '../../devices/sync/home.ts';
import { linkedPcs } from '../../context/setup-facts.ts';
import { defineTool, internal } from './util.ts';

/** How long companies.list waits for another company's own facts. */
const FACTS_MS = 5_000;

/** The person's role in this company: employee where it joined another firm's PC as an employee; throws when the devices cannot be read. */
export function companyRole(services: RuntimeServices): CompanyRole {
  return links(services.db).some(({ link }) => link.kind === 'employer') ? 'employee' : 'owner';
}

/** The list with the current entry's own facts – role and linked PCs – where they can be read. */
export function withOwnFacts(services: RuntimeServices, entries: CompanyEntry[]): CompanyEntry[] {
  return entries.map((entry) => {
    if (!entry.current) return entry;
    const out: CompanyEntry = { ...entry };
    try { out.role = companyRole(services); } catch { /* not readable: no role named */ }
    try { out.linkedPcs = linkedPcs(services); } catch { /* no devices here */ }
    const start = services.host.app.start; // B-078: the "+" menu's --start=; FirstRun opens the Connect card that way
    if (start) out.start = start;
    return out;
  });
}

const NOTE = 'A tool runs in another of these companies through tools.call with company (its name or folder): {"name": …, "args": {…}, "company": "…"}; the result names the company that acted. Where the role is "employee" the person works for another firm, and calls from other companies are not taken there; a company that does not run takes calls once it is opened.';

const list = defineTool<Record<string, never>>({
  name: 'companies.list',
  description: 'List the companies on this PC – this one and the person\'s others: name, folder, the person\'s role there (owner or employee), whether it runs and its linked PCs. Act in one with tools.call and company.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  category: 'read',
  describe: () => internal('List the companies on this PC'),
  async run(_args, ctx) {
    const app = ctx.services.host.app;
    const entries = withOwnFacts(ctx.services, listCompanies(app));
    if (!entries.length) return text('This app has no company folders here (a test profile or headless), so this company is the only one.');
    const companies = await Promise.all(entries.map(async (entry) => {
      const row = { name: entry.label, folder: folderOf(entry), ...(entry.current ? { current: true } : {}) };
      if (entry.current) return { ...row, running: true, role: entry.role, linkedPcs: entry.linkedPcs };
      const dir = companyFolder(app, entry.id)!;
      try {
        const reply = await callCompany(dir, 'companies.list', undefined, { signal: ctx.signal, timeoutMs: FACTS_MS });
        const own = ((reply as { companies?: CompanyEntry[] } | null)?.companies ?? []).find((item) => item?.current);
        return { ...row, running: true, role: own?.role, linkedPcs: own?.linkedPcs };
      } catch {
        return { ...row, running: companyRuns(dir) };
      }
    }));
    return json({ companies, note: NOTE });
  },
});

export const companyTools: ToolDef[] = [list];

/** The calling company's agent as this company's tools see it (it is not in this org). */
function standIn(id: string, from: string, name?: string): ToolContext['agent'] {
  return {
    id, name: `${name?.slice(0, 60) || 'Agent'} (${from})`, role: '', avatar: { kind: 'initials', value: 'AG' }, instructions: '', mode: 'general',
    skills: [], modelPolicy: {}, status: 'working', createdBy: 'human', createdAt: 0, updatedAt: 0,
  } as unknown as ToolContext['agent'];
}

const refuse = (message: string): WorkforceError => new WorkforceError('bad_request', message);

/** companies.tool: runs one tool here for an agent of another company on this PC (its registry checked mode and arguments there). */
export async function runCompanyTool(services: RuntimeServices, call: CompanyToolCall, signal: AbortSignal): Promise<ToolOutput> {
  if (companyRole(services) === 'employee') {
    throw new WorkforceError('forbidden', 'The person works in this company as an employee of another firm, so its data is that firm\'s: calls from the person\'s other companies are not taken here.');
  }
  const tool = services.tools.get(call.name);
  if (!tool) throw refuse(`This company has no tool "${call.name}".`);
  if (META_TOOLS.includes(tool.name)) throw refuse(`Name the tool to run in this company, not ${tool.name}.`);
  const { [DEVICE_ARG]: device, ...args } = call.args ?? {};
  if (device !== undefined) {
    const pc = tool.remote && typeof device === 'string' ? resolveDevice(services, device) : undefined;
    if (!pc || 'error' in pc || !pc.self) throw refuse('A call in another company runs on this PC, so it takes no other device.');
  }
  const errors = validate(args, tool.inputSchema);
  if (errors.length) throw refuse(`Invalid arguments for ${tool.name}:\n${errors.join('\n')}`);
  const from = call.from?.trim().slice(0, 80) || 'another company';
  // No fromPc: the caller is on this PC, so the tools here work for it as for this company's own agents (fromPc is a linked PC's).
  const ctx: ToolContext = {
    agent: standIn(call.agentId, from, call.agentName), runId: call.runId, mode: call.mode ?? 'general', deviceId: safeSelfId(services), services, signal,
    status: () => undefined,
  };
  services.log.info('company tool call', { from, tool: tool.name, agentId: call.agentId, runId: call.runId });
  const output = await tool.run(args, ctx);
  const redact = (value: string): string => { try { return services.secrets.redact(value); } catch { return value; } };
  // `structured` stays here: the text parts carry the same, masked
  const content = (Array.isArray(output?.content) ? output.content : []).map((part) => (part.type === 'text' ? { ...part, text: redact(part.text) } : part));
  return { content, ...(output?.isError ? { isError: true } : {}), ...(output?.effect ? { effect: output.effect } : {}) };
}
