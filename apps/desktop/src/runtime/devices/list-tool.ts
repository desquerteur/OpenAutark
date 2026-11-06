// The devices.list tool for agents: this PC and the linked PCs their computer, browser and phone
// tools can run on – name, id, online state, capabilities (adbPhones as that PC announced them)
// and, for an employee's PC, the person it belongs to – plus the agent's home device and, where
// connecting is wired, this PC's Remote ID and the meeting server's state.
// Owns: devices.list. Never: dials an offline PC or stores anything.

import { json, type ToolDef } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { DeviceLink } from './connect-tool.ts';

/** The meeting server in one word ('error' retries, so it is still connecting) and why while it is not up. */
function meetingOf(link: DeviceLink): { meetingServer: 'connected' | 'connecting' | 'off'; meetingServerError?: string } {
  const state = link.meeting.state();
  if (state.status === 'connected' || state.status === 'off') return { meetingServer: state.status };
  return { meetingServer: 'connecting', ...(state.error ? { meetingServerError: state.error } : {}) };
}

const DESCRIPTION = "This PC and the linked PCs: name, id, online state and capabilities (computer use, browser, adbPhones). computer.*, browser.* and phone.* take `device` (a PC's name or id from here, or 'this') to run on that PC; without it they run on my home device.";
/** Said only where devices.connect is registered. */
const LINK_HINT = " Also this PC's Remote ID and the meeting server (meetingServer). When the person wants another PC linked: devices.connect with that PC's Remote ID.";

export function devicesList(link?: DeviceLink): ToolDef {
  return defineTool<Record<string, never>>({
    name: 'devices.list',
    description: link ? DESCRIPTION + LINK_HINT : DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    category: 'read',
    describe: () => ({ summary: 'List linked PCs', reversible: true, external: false }),
    async run(_args, ctx) {
      const service = ctx.services.devices;
      const self = service.self();
      // Phones and browsers with the app are the person's screens, not places where tools run.
      const pcs = service.list().filter((device) => device.kind === 'pc' && device.status !== 'revoked');
      const home = ctx.agent.deviceId && ctx.agent.deviceId !== self.id ? pcs.find((device) => device.id === ctx.agent.deviceId) : undefined;
      return json({
        youAreOn: self.name,
        ...(link ? { remoteId: link.remote.remoteId(), ...meetingOf(link) } : {}),
        ...(home ? { homeDevice: home.name, note: `Without device, my device tools run on ${home.name}.` } : {}),
        devices: pcs.map((device) => {
          const thisPc = device.self || device.id === self.id;
          const online = thisPc || service.online(device.id);
          return {
            id: device.id, name: device.name, ...(thisPc ? { thisPc: true } : {}), online, ...(online ? {} : { status: device.status }), caps: device.caps,
            ...(device.personId ? { employeeOf: device.personId } : {}),
            ...(!thisPc && device.lastSeenAt ? { lastSeen: new Date(device.lastSeenAt).toISOString() } : {}),
          };
        }),
      });
    },
  });
}
