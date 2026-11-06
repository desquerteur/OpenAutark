// The services Settings › Apps offers with one click, and what the search finds among them. Addresses as checked on the vendors'
// own pages on 28.10.2026 (DeepWiki: public, no sign-in). Anything else is one entry of mcp.json: "Add" or the AI (skill
// connect-apps, which also searches the MCP registry).
// Owns: this list and its filter. Never: a token, or behaviour.

export interface CatalogEntry {
  name: string;
  blurb: string;
  url: string;
  /** Browser sign-in (the server's own), a key the person makes first, or both ways: Connect starts the browser sign-in; none. */
  auth: 'oauth' | 'token' | 'oauth-or-token' | 'none';
  tokenHint?: { label: string; createUrl: string };
}

export const APP_CATALOG: readonly CatalogEntry[] = [
  { name: 'Notion', blurb: 'Search, read and write pages and databases.', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  { name: 'Linear', blurb: 'Find, create and update issues and projects.', url: 'https://mcp.linear.app/mcp', auth: 'oauth-or-token', tokenHint: { label: 'API key', createUrl: 'https://linear.app/settings/account/security' } },
  { name: 'GitHub', blurb: 'Work with repositories, issues and pull requests.', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', tokenHint: { label: 'Personal access token', createUrl: 'https://github.com/settings/personal-access-tokens/new' } },
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

/** An app of this entry exists already: the connected app's address is the entry's host. */
export function catalogConnected(entry: Pick<CatalogEntry, 'url'>, addresses: readonly string[]): boolean {
  return addresses.includes(new URL(entry.url).host);
}
