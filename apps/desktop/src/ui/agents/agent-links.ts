// AF-017: agent names in message text become links. "Making" (written as the agent is named, as a whole word) and
// "@Making" / "@making" (any case) turn into a Markdown link to the agent's page (#/team/<id>), which the message's
// Markdown (blocks/markdown.tsx) navigates in the app. Inline code, existing links and images, autolinks, bare URLs
// and indented code lines stay as they are; e-mail addresses and parts of longer words never match. The longest name
// wins when names overlap ("Ana" vs "Anabel").
// Owns: the matching and the rewrite. Never: reads stores or renders (MessageBody.tsx passes the agents in).

export interface LinkableAgent { id: string; name: string }

const MIN_NAME = 2;

/** Pieces that are never rewritten: code spans, links/images, reference links, autolinks, bare URLs. */
const PROTECTED = /(`+)[\s\S]*?\1|!?\[[^\]\n]*\]\([^)\n]*\)|\[[^\]\n]*\]\[[^\]\n]*\]|<[^>\s]+>|https?:\/\/[^\s<>()]+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeLinkText(text: string): string {
  return text.replace(/([[\]\\])/g, '\\$1');
}

export type AgentLinker = (markdown: string) => string;

interface NameMatcher { byLower: Map<string, LinkableAgent>; pattern: RegExp }

function matcher(agents: readonly LinkableAgent[]): NameMatcher | undefined {
  const byLower = new Map<string, LinkableAgent>();
  for (const agent of agents) {
    const name = agent.name.trim();
    if (name.length < MIN_NAME || byLower.has(name.toLowerCase())) continue;
    byLower.set(name.toLowerCase(), { id: agent.id, name });
  }
  if (!byLower.size) return undefined;
  const names = [...byLower.values()].map((agent) => agent.name).sort((a, b) => b.length - a.length).map(escapeRegExp);
  // before: start or a character that is no letter, digit, "_", "-" or "@" (so "mail@Making" and "Re-Making" stay text)
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@\\-])(@?)(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return { byLower, pattern };
}

/** The agent a match names, or undefined (a plain name only as written: "making" is a word, "Making" the agent). */
function named(m: NameMatcher, at: string, found: string): LinkableAgent | undefined {
  const agent = m.byLower.get(found.toLowerCase());
  if (!agent || (!at && found !== agent.name)) return undefined;
  return agent;
}

export type NamePiece = { text: string; agentId?: string };

/** Plain text (a chat row's title, a tree row's name) cut into pieces, the agent names marked with their ids. */
export function splitAgentNames(text: string, agents: readonly LinkableAgent[]): NamePiece[] {
  const m = matcher(agents);
  if (!m || !text) return [{ text }];
  const pieces: NamePiece[] = [];
  let last = 0;
  for (const match of text.matchAll(m.pattern)) {
    const [, before, at, found] = match;
    const agent = named(m, at, found);
    if (!agent) continue;
    const start = match.index! + before.length;
    if (start > last) pieces.push({ text: text.slice(last, start) });
    pieces.push({ text: `${at}${found}`, agentId: agent.id });
    last = start + at.length + found.length;
  }
  if (last < text.length || !pieces.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

/** A rewrite function for these agents; with no linkable names it returns the text unchanged. */
export function makeAgentLinker(agents: readonly LinkableAgent[], href: (id: string) => string = (id) => `#/team/${encodeURIComponent(id)}`): AgentLinker {
  const m = matcher(agents);
  if (!m) return (markdown) => markdown;
  const { pattern } = m;

  const rewrite = (text: string): string => text.replace(pattern, (whole, before: string, at: string, found: string) => {
    const agent = named(m, at, found);
    if (!agent) return whole;
    return `${before}[${escapeLinkText(`${at}${found}`)}](${href(agent.id)})`;
  });

  const rewriteLine = (line: string): string => {
    if (/^( {4}|\t)/.test(line)) return line; // indented code
    let out = '';
    let last = 0;
    for (const match of line.matchAll(PROTECTED)) {
      out += rewrite(line.slice(last, match.index)) + match[0];
      last = match.index! + match[0].length;
    }
    return out + rewrite(line.slice(last));
  };

  return (markdown) => {
    if (!markdown) return markdown;
    // Code spans may span lines: protect them over the whole text first, then go line by line in between.
    let out = '';
    let last = 0;
    for (const match of markdown.matchAll(/(`+)[\s\S]*?\1/g)) {
      out += markdown.slice(last, match.index).split('\n').map(rewriteLine).join('\n') + match[0];
      last = match.index! + match[0].length;
    }
    return out + markdown.slice(last).split('\n').map(rewriteLine).join('\n');
  };
}
