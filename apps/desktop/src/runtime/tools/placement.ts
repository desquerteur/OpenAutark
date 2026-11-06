// Where a tool call runs: remote tools (computer, browser, phone) get the optional `device`
// argument; without it they run on the agent's home device (its deviceId; none = this PC). `device`
// values resolve to a linked PC, and a forwarded call's journal text names that PC.
// B-075 (owner 04.11.2026: an agent could not reach "Company 2"): any call may carry `company` – another company on this
// PC by its name or folder from companies.list (tools.call declares it beside the target's arguments; no tool schema
// grows) – and then runs in that company's runtime (registry.ts forwards it, its effect journaled as external; it refuses
// there where the person is an employee: builtin/companies.ts).
// Owns: these rules and texts. Never: runs a tool, forwards a call to a revoked, unknown or non-PC device, or names a
// company that is not in this PC's company folders.

import type { RuntimeServices } from '../contracts.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { CompanyEntry } from '../../shared/model/companies.ts';
import type { ActionDescription, ToolContext, ToolDef } from './types.ts';
import { DEVICE_ARG, DEVICE_PROPERTY } from './types.ts';
import { companyFolder, listCompanies } from '../root/companies.ts';

/** A PC a call runs on. `id` is undefined only for this PC while its own id is unknown. */
export interface DeviceTarget { id?: string; name: string; self: boolean }

const THIS_PC = /^this(?: pc)?$/i;

/** Remote tools get the optional `device` argument; returns a copy, the definition stays unchanged. */
export function withDeviceArg(tool: ToolDef): ToolDef {
  if (!tool.remote) return tool;
  const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  if (Object.hasOwn(properties, DEVICE_ARG)) throw new Error(`Remote tool ${tool.name} must not define its own "${DEVICE_ARG}" argument.`);
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, [DEVICE_ARG]: { ...DEVICE_PROPERTY } } } };
}

/**
 * Resolves a `device` value – 'this' (this PC), a device id or an exact device name (case and
 * surrounding spaces ignored) – against devices.list. Unknown, ambiguous, removed and non-PC
 * devices (phones, browsers) are errors that say what to pass instead.
 */
export function resolveDevice(services: RuntimeServices, value: string): DeviceTarget | { error: string } {
  const wanted = value.trim();
  const self = safe(() => services.devices.self());
  if (THIS_PC.test(wanted)) return { id: self?.id, name: self?.name ?? 'this PC', self: true };
  const devices: Device[] = safe(() => services.devices.list()) ?? [];
  const byId = devices.filter((device) => device.id === wanted);
  const matches = byId.length ? byId : devices.filter((device) => device.name.trim().toLowerCase() === wanted.toLowerCase());
  const shown = wanted.length > 60 ? `${wanted.slice(0, 60)}…` : wanted;
  if (!matches.length) {
    const linked = devices.filter((device) => device.kind === 'pc' && device.status !== 'revoked').map((device) => device.name);
    return { error: `No linked PC is called "${shown}".${linked.length ? ` Linked PCs: ${linked.join(', ')}.` : ''} devices.list shows their names and ids; "this" runs on this PC.` };
  }
  const pcs = matches.filter((device) => device.kind === 'pc');
  if (!pcs.length) return { error: `"${shown}" is a ${matches[0].kind}, not a PC: device tools run on PCs (phone.* reaches Android phones over ADB from a PC).` };
  const linked = pcs.filter((device) => device.status !== 'revoked');
  if (!linked.length) return { error: `${pcs[0].name} was removed, so it cannot run tools any more. Pick another PC from devices.list, or connect it again (Settings › Devices).` };
  if (linked.length > 1) return { error: `Several linked PCs are called "${shown}". Pass the device id from devices.list instead.` };
  const device = linked[0];
  return { id: device.id, name: device.name, self: device.self || device.id === self?.id };
}

/**
 * Where a remote tool runs: the `device` argument (stripped from the input the tool sees) or the
 * context's default (the agent's home device). Sets ctx.deviceId; `target` is set only for another PC.
 */
export function place(services: RuntimeServices, tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): { input: Record<string, unknown>; target?: DeviceTarget } | { error: string } {
  if (!tool.remote) return { input: args };
  const { [DEVICE_ARG]: wanted, ...input } = args;
  if (typeof wanted === 'string') {
    const target = resolveDevice(services, wanted);
    if ('error' in target) return target;
    ctx.deviceId = target.id;
    return { input, target: target.self ? undefined : target };
  }
  if (!ctx.deviceId) ctx.deviceId = undefined; // '' never names a PC
  if (ctx.deviceId === undefined || ctx.deviceId === safeSelfId(services)) return { input };
  const known = safe(() => services.devices.list().find((device) => device.id === ctx.deviceId));
  if (known?.status === 'revoked') return { error: `${known.name}, my home device, was removed. Pass device: "this" or another PC from devices.list.` };
  return { input, target: { id: ctx.deviceId, name: known?.name ?? ctx.deviceId, self: false } };
}

/** The journal names the PC a forwarded call runs on ("Click Save on Tower"). */
export function onPc(action: ActionDescription, target: DeviceTarget): ActionDescription {
  const resource = action.resource === undefined || action.resource === target.id ? target.name : action.resource;
  return { ...action, summary: `${action.summary} on ${target.name}`, resource };
}

/** B-075: the argument naming another company on this PC, on any call (registry.ts takes it off before validation). */
export const COMPANY_ARG = 'company';
/** The first company's folder as companies.list names it (its data folder has no company id). */
export const FIRST_FOLDER = 'first';

/** Another company on this PC a call runs in: its data folder, its name, and the name of the company that sends the call. */
export interface CompanyTarget { dir: string; name: string; from: string }

const THIS_COMPANY = /^this(?: company| one)?$/i;

/** A company's folder as agents pass it: its id, or 'first' for the first one. */
export const folderOf = (entry: Pick<CompanyEntry, 'id'>): string => entry.id ?? FIRST_FOLDER;

/**
 * Resolves a `company` value – 'this', a folder from companies.list or a company's exact name (case and surrounding
 * spaces ignored) – against the company folders of this PC: null for this company, else the target. Unknown and
 * ambiguous names are errors that say what to pass.
 */
export function resolveCompany(services: RuntimeServices, value: string): CompanyTarget | null | { error: string } {
  const wanted = value.trim().toLowerCase();
  if (THIS_COMPANY.test(wanted)) return null;
  const app = safe(() => services.host.app);
  const companies = (app && safe(() => listCompanies(app))) || [];
  const byFolder = companies.filter((entry) => folderOf(entry) === wanted);
  const matches = byFolder.length ? byFolder : companies.filter((entry) => entry.label.trim().toLowerCase() === wanted);
  const shown = value.trim().length > 60 ? `${value.trim().slice(0, 60)}…` : value.trim();
  if (!matches.length) {
    if (companies.length < 2) return { error: `There is no other company on this PC, so "${shown}" names none (companies.list).` };
    return { error: `No company on this PC is called "${shown}". Companies here: ${companies.map((entry) => `${entry.label} (folder ${folderOf(entry)}${entry.current ? ', this one' : ''})`).join(', ')}.` };
  }
  if (matches.length > 1) return { error: `Several companies on this PC are called "${shown}": pass the folder instead (${matches.map(folderOf).join(', ')}).` };
  const company = matches[0];
  const dir = app && companyFolder(app, company.id);
  if (company.current || !dir) return null;
  return { dir, name: company.label, from: companies.find((entry) => entry.current)?.label ?? 'another company' };
}

/**
 * Where a call runs among this PC's companies: `named` (tools.call's own `company`, apart from the target's arguments),
 * else a `company` in the arguments (stripped from the input; a tool with an own `company` argument keeps it as its own).
 * `target` is set for another company of this PC; this company, or none named, runs the call here.
 */
export function placeCompany(services: RuntimeServices, tool: ToolDef, args: unknown, named?: unknown): { input: unknown; target?: CompanyTarget } | { error: string } {
  let wanted = named;
  let input = args;
  if (named === undefined) {
    const own = isRecord(tool.inputSchema.properties) && Object.hasOwn(tool.inputSchema.properties, COMPANY_ARG);
    if (!isRecord(args) || !Object.hasOwn(args, COMPANY_ARG) || own) return { input: args };
    const { [COMPANY_ARG]: value, ...rest } = args;
    wanted = value;
    input = rest;
  }
  if (typeof wanted !== 'string' || !wanted.trim() || wanted.length > 200) return { error: `${COMPANY_ARG}: a company's name or folder from companies.list, or "this".` };
  const target = resolveCompany(services, wanted);
  if (target && 'error' in target) return target;
  return target ? { input, target } : { input };
}

/**
 * The journal names the company a forwarded call runs in ("Delete secret … in Side Shop"). Its effect counts as external:
 * it happens in another runtime with that company's data, so this one cannot judge it, and a broken connection leaves it
 * unknown (never retried blindly).
 */
export function inCompany(action: ActionDescription, target: CompanyTarget): ActionDescription {
  return { ...action, summary: `${action.summary} in ${target.name}`, resource: action.resource ?? target.name, external: true };
}

/** This PC's device id, undefined while it is unknown. */
export const safeSelfId = (services: RuntimeServices): string | undefined => safe(() => services.devices.self().id);

export function safe<T>(read: () => T): T | undefined { try { return read(); } catch { return undefined; } }

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
