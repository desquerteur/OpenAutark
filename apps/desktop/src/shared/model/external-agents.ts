// External agents as chat participants (C8): the plain-data rules shared by runtime and UI – the
// member id ('ext:api:<key>:<label>', the label being the last segment every renderer shows), how
// agents and tools name an 'ext:' member, which `/ws` addresses an external agent can use (from
// this PC always; from another machine over the tailnet or the
// https address – http/ws.ts and bridges/external-agents.ts enforce it) and the RPC shape of
// chats.connectExternal, merged into Methods by module augmentation because api/methods.ts is at
// its size limit (it can move there unchanged). B-050 K8 (e): a sender behind a connector
// ('ext:api:<key>:<sender hash>:<label>', isConnectorSender) is an outside contact, not an external agent.
// Owns: those shapes and rules. Never: behaviour (runtime/bridges/external-agents.ts connects,
// authenticates and revokes; ui/chat/details/Members.tsx shows them).

/** Member ids of external agents start so; Telegram contacts are 'ext:tg:…'. */
export const EXTERNAL_AGENT_PREFIX = 'ext:api:';

const segments = (memberId: string): number => memberId.split(':').length;

/** True for a member id of an external agent: 'ext:api:<key>:<label>' (exactly four segments – a sender behind a connector is not one). */
export function isExternalAgent(memberId: string | undefined): boolean {
  return typeof memberId === 'string' && memberId.startsWith(EXTERNAL_AGENT_PREFIX) && segments(memberId) === 4;
}

/**
 * B-050 K8 (e): True for a sender a connector posts for ('ext:api:<token key>:<sender hash>:<label>',
 * runtime/bridges/external-rpc.ts) – an outside contact like a bridged one (a WhatsApp or Signal contact), never an agent.
 */
export function isConnectorSender(memberId: string | undefined): boolean {
  return typeof memberId === 'string' && memberId.startsWith(EXTERNAL_AGENT_PREFIX) && segments(memberId) === 5;
}

/** The label of an external agent's member id – its last segment. */
export function externalAgentName(memberId: string): string {
  return memberId.split(':').pop()?.trim() || 'External-agent';
}

/**
 * How agents, tools and the prompt name an 'ext:' member: "<label> (external agent)" for an
 * external agent, "<label> (external contact)" for a bridged contact; undefined for other ids.
 */
export function externalMemberLabel(memberId: string): string | undefined {
  if (!memberId.startsWith('ext:')) return undefined;
  const label = memberId.split(':').pop()?.trim();
  if (isExternalAgent(memberId)) return `${label || 'External agent'} (external agent)`;
  return label ? `${label} (external contact)` : 'External contact';
}

const LOCAL_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i;
const TAILNET_HOST = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

/**
 * The `/ws` addresses an external agent can use, from the PC's reachable URLs (pwa.state): this
 * PC's own address always, the https address and tailnet addresses while `enabled` (always true
 * since B-078 D5, which removed the phone switch; an older PC can still report false), plain LAN
 * addresses never (the token travels in every Hello).
 */
export function externalSocketUrls(state: { enabled: boolean; urls: readonly string[] }): string[] {
  const out = new Set<string>();
  for (const url of state.urls) {
    const parsed = /^(https?):\/\/([^/?#\s]+)/i.exec(url);
    if (!parsed) continue;
    const https = parsed[1].toLowerCase() === 'https';
    const host = parsed[2];
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
    if (!LOCAL_HOST.test(hostname) && !(state.enabled && (https || TAILNET_HOST.test(hostname)))) continue;
    out.add(`${https ? 'wss' : 'ws'}://${host}/ws`);
  }
  return [...out];
}

/** chats.connectExternal: the new member and its token – handed out this once, stored only as a hash. */
export interface ExternalAgentToken {
  memberId: string;
  token: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /**
     * C8 ('manage' on a secure transport): an external agent joins the chat as a member; its token is shown once.
     * B-050 K8 (e): `trusted` – this connector may post important messages (default: untrusted, normal or silent only).
     */
    'chats.connectExternal': { params: { conversationId: string; name: string; trusted?: boolean }; result: ExternalAgentToken };
  }
}
