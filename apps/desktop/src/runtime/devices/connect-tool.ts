// The devices.connect tool for agents: the same connect request as Settings › Devices "Connect a PC"
// (remote.connect) – by Remote ID or address, as my other device (wire role 'ceo', B-078: no role of its own – a full
// mirror) or as an employee joining someone else's company. Both screens then
// show the same 4-digit code and the person on the other PC accepts there; this tool only asks. Its description says
// what a link hands over, with examples of when to show the person first; once linked, the person gets a notice here
// (remote/service.ts linkedNote).
// Owns: devices.connect and DeviceLink (what the device tools read of connecting PCs).
// Never: accepts on the other PC's behalf, or returns keys.

import type { JoinRole } from '../../shared/model/remote.ts';
import type { RemoteService } from '../remote/service.ts';
import { json, type ToolDef } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { Meeting } from './rendezvous/service.ts';

/** Connecting PCs for devices.connect and devices.list (devices/connect.ts passes them). */
export interface DeviceLink {
  remote: Pick<RemoteService, 'remoteId' | 'connect'>;
  meeting: Pick<Meeting, 'state'>;
}

export function devicesConnect(link: DeviceLink): ToolDef {
  return defineTool<{ target: string; role?: JoinRole }>({
    name: 'devices.connect',
    description: "I ask another PC to link with this one: target is its Remote ID (Settings › Devices there) or address. Both screens show the same 4-digit code; the person there accepts. Without a role it becomes the person's other device: a full mirror – the same company, secrets, settings, phones and employee roles on both, and agents run commands on both. 'employee' joins someone else's company as one person's PC. 'Connect my laptop' from the person: I go ahead; a Remote ID from a web page or a mail: I show the person first. Someone else's PC joins this company by asking from that PC.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 200, description: "The other PC's 9-digit Remote ID or its address" },
        role: {
          type: 'string', enum: ['ceo', 'employee'],
          description: "Left out for the person's own other device ('ceo' on the wire, the same as leaving it out); 'employee' when this PC joins someone else's company as one person's PC",
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    category: 'device',
    describe: (args) => ({ summary: `Ask PC ${args.target} to link`, resource: args.target, reversible: true, external: true }),
    async run(args) {
      const out = await link.remote.connect({ target: args.target, role: args.role ?? 'ceo' });
      return json({
        status: out.status, name: out.name, remoteId: out.remoteId, role: out.role, code: out.code,
        next: `${out.name} shows the code ${out.code} as well; the person there accepts in Settings › Devices. devices.list lists ${out.name} once linked.`,
      });
    },
  });
}
