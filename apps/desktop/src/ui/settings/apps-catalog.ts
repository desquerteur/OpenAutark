// The services Settings › Connectors offers with one click, and what the search finds among them. Addresses as checked on
// the vendors' own pages on 28.10.2026 (DeepWiki: public, no sign-in). AF-005 (07.11.2026): Google, Slack and Discord
// have no remote MCP server this app can sign in to without an app of the person's own (Google's own servers are a
// developer preview behind a Cloud project; Slack's needs a registered Slack app), so they run the widely used local
// servers through npx / uvx – checked on npm and PyPI that day: workspace-mcp 2.3 (Gmail, Calendar, Drive; its own
// Google sign-in in the browser at the first use, with the person's OAuth client), slack-mcp-server 1.3 (korotovsky; a
// user OAuth token) and @iqai/mcp-discord (a bot token). Their keys go into Secrets and the env holds the handles.
// Anything else is one entry of mcp.json: "Own MCP server", "Paste JSON" or the AI (skill connect-apps, which also
// searches the MCP registry).
// Owns: this list and its filter. Never: a token, or behaviour.

/** A key a local server reads from its environment (it goes into Secrets; the entry's env gets the handle). */
export interface CatalogKey { env: string; label: string }

export interface CatalogEntry {
  name: string;
  blurb: string;
  /** A remote server: its MCP address. */
  url?: string;
  /** A local server (stdio): the program, its arguments and fixed variables; `keys` are asked for on Connect. */
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  keys?: readonly CatalogKey[];
  /** What must be on the PC for a local server ("Node.js", "uv"). */
  needs?: string;
  /** Browser sign-in (the server's own), a key the person makes first, or both ways: Connect starts the browser sign-in; none; keys of a local server. */
  auth: 'oauth' | 'token' | 'oauth-or-token' | 'none' | 'keys';
  tokenHint?: { label: string; createUrl: string };
}

export const APP_CATALOG: readonly CatalogEntry[] = [
  { name: 'GitHub', blurb: 'Work with repositories, issues and pull requests.', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', tokenHint: { label: 'Personal access token', createUrl: 'https://github.com/settings/personal-access-tokens/new' } },
  {
    name: 'Google', blurb: 'Gmail, Google Calendar and Drive: search, read, draft and plan. Signs in to Google in the browser at the first use.',
    command: 'uvx', args: ['workspace-mcp', '--tools', 'gmail', 'calendar', 'drive'], env: { OAUTHLIB_INSECURE_TRANSPORT: '1' }, needs: 'uv',
    keys: [{ env: 'GOOGLE_OAUTH_CLIENT_ID', label: 'OAuth client ID' }, { env: 'GOOGLE_OAUTH_CLIENT_SECRET', label: 'OAuth client secret' }],
    auth: 'keys', tokenHint: { label: 'OAuth client (Desktop app)', createUrl: 'https://console.cloud.google.com/apis/credentials' },
  },
  { name: 'Notion', blurb: 'Search, read and write pages and databases.', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  {
    name: 'Slack', blurb: 'Read and search channels, threads and direct messages.', command: 'npx', args: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'], needs: 'Node.js',
    keys: [{ env: 'SLACK_MCP_XOXP_TOKEN', label: 'User OAuth token (xoxp-…)' }], auth: 'keys', tokenHint: { label: 'User OAuth token', createUrl: 'https://api.slack.com/apps' },
  },
  {
    name: 'Discord', blurb: 'Read and send messages, manage channels and forum posts through a bot.', command: 'npx', args: ['-y', '@iqai/mcp-discord'], needs: 'Node.js',
    keys: [{ env: 'DISCORD_TOKEN', label: 'Bot token' }], auth: 'keys', tokenHint: { label: 'Bot token', createUrl: 'https://discord.com/developers/applications' },
  },
  { name: 'Linear', blurb: 'Find, create and update issues and projects.', url: 'https://mcp.linear.app/mcp', auth: 'oauth-or-token', tokenHint: { label: 'API key', createUrl: 'https://linear.app/settings/account/security' } },
  { name: 'Zapier', blurb: 'Reach Gmail, Outlook, Slack, Sheets and 8,000 more apps.', url: 'https://mcp.zapier.com/api/v1/connect', auth: 'oauth-or-token', tokenHint: { label: 'Connection token', createUrl: 'https://mcp.zapier.com' } },
  { name: 'Jira & Confluence', blurb: 'Search and update Jira issues and Confluence pages.', url: 'https://mcp.atlassian.com/v2/mcp', auth: 'oauth' },
  { name: 'Airtable', blurb: 'Read and change bases, tables and records.', url: 'https://mcp.airtable.com/mcp', auth: 'oauth-or-token', tokenHint: { label: 'Personal access token', createUrl: 'https://airtable.com/create/tokens' } },
  { name: 'Todoist', blurb: 'Add, plan and complete tasks.', url: 'https://ai.todoist.net/mcp', auth: 'oauth' },
  { name: 'monday.com', blurb: 'Work with boards, items and updates.', url: 'https://mcp.monday.com/mcp', auth: 'oauth' },
  { name: 'Intercom', blurb: 'Search conversations, contacts and help articles.', url: 'https://mcp.intercom.com/mcp', auth: 'oauth' },
  { name: 'Sentry', blurb: 'Look into errors, issues and releases.', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
  { name: 'Supabase', blurb: 'Manage projects, tables and queries.', url: 'https://mcp.supabase.com/mcp', auth: 'oauth-or-token', tokenHint: { label: 'Access token', createUrl: 'https://supabase.com/dashboard/account/tokens' } },
  { name: 'Cloudflare', blurb: 'Work with Workers, DNS and account settings.', url: 'https://mcp.cloudflare.com/mcp', auth: 'oauth-or-token', tokenHint: { label: 'API token', createUrl: 'https://dash.cloudflare.com/profile/api-tokens' } },
  { name: 'Stripe', blurb: 'Look up customers, payments and invoices.', url: 'https://mcp.stripe.com', auth: 'oauth-or-token', tokenHint: { label: 'API key', createUrl: 'https://dashboard.stripe.com/apikeys' } },
  { name: 'PayPal', blurb: 'Work with invoices, orders and transactions.', url: 'https://mcp.paypal.com/mcp', auth: 'oauth-or-token', tokenHint: { label: 'Access token', createUrl: 'https://developer.paypal.com/dashboard/applications' } },
  { name: 'Webflow', blurb: 'Edit sites, pages and CMS items.', url: 'https://mcp.webflow.com/mcp', auth: 'oauth' },
  { name: 'Wix', blurb: 'Manage sites, stores and bookings.', url: 'https://mcp.wix.com/mcp', auth: 'oauth' },
  { name: 'DeepWiki', blurb: 'Ask questions about public GitHub repositories.', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' },
];

/** The entries whose name or line holds every word. */
export function searchCatalog(query: string, list: readonly CatalogEntry[] = APP_CATALOG): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((entry) => { const text = `${entry.name} ${entry.blurb}`.toLowerCase(); return words.every((word) => text.includes(word)); });
}

/**
 * An app of this entry exists already: a remote one's address is the entry's host; a local one (AF-005) has the entry's
 * name as its key in mcp.json (or "<name> 2" …), since its address is only the program.
 */
export function catalogConnected(entry: { url?: string; name?: string }, addresses: readonly string[], names: readonly string[] = []): boolean {
  if (entry.url) return addresses.includes(new URL(entry.url).host);
  if (!entry.name) return false;
  const named = entry.name;
  return names.some((name) => name === named || new RegExp(`^${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+$`).test(name));
}

/** AF-005: the mcp.json entry of a local catalog server, its keys (by variable) already handles. */
export function catalogEntry(entry: CatalogEntry, handles: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  if (entry.url) return { url: entry.url };
  const env = { ...(entry.env ?? {}), ...handles };
  return { command: entry.command, args: [...(entry.args ?? [])], ...(Object.keys(env).length ? { env } : {}) };
}
