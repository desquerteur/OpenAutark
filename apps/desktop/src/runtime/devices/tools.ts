// Device tools for agents (computer.*, browser.*, phone.*, devices.list, devices.send_file, and devices.connect where
// connecting PCs is wired) and the peer handlers that let a linked PC run them here: 'tools.call' (remote tool execution – the tool registry forwards a
// call whose `device` or the agent's home device names another PC), 'files.put' (a sent file: send-file.ts)
// and 'computer.preview' (the live screen image). A call from a linked PC runs like a call of this PC's own agent (one log line);
// computer.* tools show in the activity pill and end at the person's Stop (computer/activity.ts).
// Owns: the device tool list and the executor side of a remote call. Never: executes a tool that is
// not marked remote, forwards a received call to a third PC, or sends values of this PC's secrets back.

import type { RuntimeServices } from '../contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { DEVICE_ARG } from '../tools/types.ts';
import { validate } from '../tools/validate.ts';
import { normalizeOutput } from '../tools/registry.ts';
import type { DeviceCaps } from '../../shared/model/devices.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { PeerHandler } from './rpc-peer.ts';
import type { ComputerService } from '../computer/service.ts';
import type { BrowserService } from '../browser/service.ts';
import type { PhoneDriver, PhoneWireless } from '../phone/driver.ts';
import { computerTools } from '../computer/tools.ts';
import { browserTools } from '../browser/tools.ts';
import { phoneTools } from '../phone/tools.ts';
import { detectChannel } from '../browser/channel.ts';
import { bindComputerActivity, type ComputerActivity } from '../computer/activity.ts';
import { devicesConnect, type DeviceLink } from './connect-tool.ts';
import { devicesList } from './list-tool.ts';
import { receivePiece, sendFile } from './send-file.ts';

export interface DeviceToolDeps {
  computer: ComputerService;
  browser: BrowserService;
  /** ADB and the Android app's phone use behind one driver (phone/drivers.ts mergedPhones). */
  phone: PhoneDriver & PhoneWireless;
  /** Connecting PCs (remote/service.ts, the meeting server): devices.connect, and devices.list's Remote ID and server state. */
  link?: DeviceLink;
}

export function deviceTools(deps: DeviceToolDeps): ToolDef[] {
  const computer = computerTools(deps.computer).map((tool) => watched(tool, deps.computer.activity));
  return [...computer, ...browserTools(deps.browser), ...phoneTools(deps.phone), devicesList(deps.link), sendFile, ...(deps.link ? [devicesConnect(deps.link)] : [])];
}

/** Which linked PC sent a call (set for the ctx a remote call runs with). */
const remoteCaller = new WeakMap<ToolContext, string>();

/** A computer.* tool that shows up in the activity pill and ends at the person's Stop. */
export function watched(tool: ToolDef, activity: ComputerActivity): ToolDef {
  return {
    ...tool,
    run: (args, ctx) => {
      let summary = tool.name;
      try { summary = ctx.services.secrets.redact(tool.describe?.(args, ctx).summary || tool.name); } catch { /* the name says enough */ }
      return activity.run(
        { agent: ctx.agent.name, agentId: ctx.agent.id, fromDevice: remoteCaller.get(ctx), summary, signal: ctx.signal },
        (signal) => tool.run(args, { ...ctx, signal }),
      );
    },
  };
}

/** What this PC can do for agents (updateSelf); a phone list of an older run is cleared (phone.devices asks adb itself). */
export async function localCaps(deps: DeviceToolDeps): Promise<DeviceCaps> {
  let browser = false;
  try { detectChannel(); browser = true; } catch { browser = false; }
  return { computerUse: deps.computer.canControl(), browser, os: deps.computer.platform, adbPhones: undefined };
}

interface RemoteCall { name: string; args: Record<string, unknown>; agentId: string; agentName?: string; runId: string; conversationId?: string; taskId?: string; mode: string }

function parseCall(params: unknown): RemoteCall {
  const p = (params ?? {}) as Record<string, unknown>;
  const str = (key: string, required: boolean): string | undefined => {
    const value = p[key];
    if (value === undefined || value === null) { if (required) throw new WorkforceError('bad_request', `${key} is required.`); return undefined; }
    if (typeof value !== 'string' || value.length > 200) throw new WorkforceError('bad_request', `${key} must be a short string.`);
    return value;
  };
  const raw = p.args === undefined ? {} : p.args;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkforceError('bad_request', 'args must be an object.');
  // The caller's registry already picked this PC: a forwarded call never travels on to another one.
  const args = { ...(raw as Record<string, unknown>) };
  delete args[DEVICE_ARG];
  return {
    name: str('name', true)!, args, agentId: str('agentId', true)!, agentName: str('agentName', false)?.slice(0, 60), runId: str('runId', true)!,
    conversationId: str('conversationId', false), taskId: str('taskId', false), mode: str('mode', false) ?? 'computer',
  };
}

/** Runs a linked PC's call here ('tools.call') like a call of this PC's own agent. */
export async function runRemoteTool(services: RuntimeServices, params: unknown, fromDeviceId: string, signal: AbortSignal): Promise<ToolOutput> {
  const call = parseCall(params);
  const tool = services.tools.get(call.name);
  if (!tool?.remote) throw new WorkforceError('bad_request', `${call.name} does not run on another PC.`);
  const errors = validate(call.args, tool.inputSchema);
  if (errors.length) throw new WorkforceError('bad_request', `Invalid arguments for ${call.name}:\n${errors.join('\n')}`);
  let deviceId: string | undefined;
  try { deviceId = services.devices.self().id; } catch { deviceId = undefined; }
  let from = 'a linked PC';
  try { from = services.devices.list().find((device) => device.id === fromDeviceId)?.name ?? from; } catch { /* unnamed */ }
  const agent = services.org.get(call.agentId) ?? standIn(call.agentId, from, call.agentName);
  const ctx: ToolContext = {
    agent, runId: call.runId, conversationId: call.conversationId, taskId: call.taskId, mode: call.mode, deviceId, services, signal,
    fromPc: from,
    status: () => undefined,
  };
  remoteCaller.set(ctx, from);
  services.log.info('remote tool call', { from: fromDeviceId, tool: call.name, agentId: call.agentId, runId: call.runId });
  return redactOutput(services, normalizeOutput(await tool.run(call.args, ctx)));
}

/** The calling PC's agent as this PC's tools see it (it is not in this PC's org). */
function standIn(id: string, from: string, name?: string): ToolContext['agent'] {
  return {
    id, name: name ? `${name} (${from})` : `Agent from ${from}`, role: '', avatar: { kind: 'initials', value: 'AG' }, instructions: '', mode: 'computer',
    skills: [], modelPolicy: {}, status: 'working', createdBy: 'human', createdAt: 0, updatedAt: 0,
  } as unknown as ToolContext['agent'];
}

/** Values of this PC's secrets (typed into a page and visible in a snapshot) never go back in the output. */
function redactOutput(services: RuntimeServices, output: ToolOutput): ToolOutput {
  const redact = (value: string): string => { try { return services.secrets.redact(value); } catch { return value; } };
  const deep = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redact(value);
    if (depth > 6 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => deep(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, depth + 1)]));
  };
  return {
    ...output,
    content: output.content.map((part) => (part.type === 'text' ? { ...part, text: redact(part.text) } : part)),
    ...(output.structured === undefined ? {} : { structured: deep(output.structured, 0) }),
  };
}

/** Registers the device peer handlers on the mesh once at startup. */
export function registerDeviceHandlers(mesh: { register(method: string, handler: PeerHandler): void }, deps: { services: () => RuntimeServices; computer: ComputerService }): void {
  try { bindComputerActivity(deps.services(), deps.computer.activity); } catch { /* bound when ComputerService saw the services */ }
  mesh.register('tools.call', (params, fromDeviceId, signal) => runRemoteTool(deps.services(), params, fromDeviceId, signal));
  mesh.register('files.put', (params, fromDeviceId) => receivePiece(deps.services(), params, fromDeviceId));
  mesh.register('computer.preview', async (params) => {
    const p = (params ?? {}) as { display?: unknown };
    const display = typeof p.display === 'number' && Number.isInteger(p.display) && p.display >= 0 && p.display <= 16 ? p.display : undefined;
    return deps.computer.preview({ display }); // never forwards again (no deviceId)
  });
}
