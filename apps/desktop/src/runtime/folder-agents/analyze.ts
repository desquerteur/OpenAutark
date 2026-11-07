// AF-014: what a folder says about the agent that should work in it – a name and a role from its manifest
// (package.json, pyproject.toml, Cargo.toml, go.mod) or its README's heading and first paragraph, else the folder's
// name; the instruction files it brings in every vendor convention (skills/project-files.ts: AGENTS.md, CLAUDE.md …),
// its skills (skills/discover.ts: .claude/skills, .codex/skills, .agents …) and other agent config (.codex/config.toml …,
// named only). Bounded reads, nothing executed, links not followed; the texts are the project's, shown as data.
// Owns: these suggestions. Never: writes into the folder or creates anything (create.ts does).

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FolderFinding } from '../../shared/model/folder-agent.ts';
import { stripInvisible } from '../../shared/text/external.ts';
import { readText, discoverSkills } from '../skills/discover.ts';
import { projectFiles } from '../skills/project-files.ts';
import { HOME_DISCOVERY } from '../agent-core/home.ts';

const MANIFEST_BYTES = 256 * 1024;
const ROLE_MAX = 80;
const ABOUT_MAX = 600;
const NAME_MAX = 60;
const CONFIGS = ['.codex/config.toml', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.cursor/mcp.json', '.gemini/settings.json'];
const READMES = ['README.md', 'README.MD', 'Readme.md', 'readme.md', 'README.rst', 'README.txt', 'README'];

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function read(folder: string, name: string): string | undefined {
  const found = readText(path.join(folder, name), MANIFEST_BYTES);
  return typeof found === 'string' ? undefined : stripInvisible(found.text).text.replace(/\r\n?/g, '\n');
}

/** "my-cool_app" / "@scope/my-app" → "My Cool App". */
export function displayName(raw: string): string {
  const base = raw.trim().replace(/^@[^/]+\//, '').replace(/\.git$/, '');
  const words = base.split(/[\s_\-./]+/).filter(Boolean);
  const titled = words.map((word) => (/[A-Z]/.test(word.slice(1)) ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(' ');
  return cut(titled || raw.trim(), NAME_MAX);
}

function tomlValue(text: string, section: string, key: string): string | undefined {
  const start = text.search(new RegExp(`^\\[${section.replace(/[.[\]]/g, '\\$&')}\\]\\s*$`, 'm'));
  if (start < 0) return undefined;
  const body = text.slice(start).split(/\n\[/)[0] ?? '';
  const match = new RegExp(`^${key}\\s*=\\s*"([^"\\n]*)"`, 'm').exec(body);
  return match?.[1]?.trim() || undefined;
}

/** The README's first heading and first paragraph that is prose (no badge, image, code or HTML line). */
export function readmeParts(text: string): { title?: string; about?: string } {
  const lines = text.split('\n');
  const title = lines.map((line) => /^#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]).find(Boolean) ?? lines.find((line, i) => /^(=+|-+)\s*$/.test(lines[i + 1] ?? '') && line.trim())?.trim();
  const paragraphs = text.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).map((block) => block.trim());
  const prose = paragraphs.find((block) => block && !/^(#|<|!\[|\[!\[|\||-{3,}|={3,}|>\s*\[!)/.test(block) && !/^[^\n]+\n(=+|-+)\s*$/.test(block) && /[a-zA-Z]{3,}/.test(block));
  const about = prose ? oneLine(prose.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')) : undefined;
  return { ...(title ? { title: oneLine(title.replace(/[*_`]/g, '')) } : {}), ...(about ? { about } : {}) };
}

interface Manifest { name?: string; description?: string; stack?: string; source: string }

function manifest(folder: string): Manifest | undefined {
  const pkg = read(folder, 'package.json');
  if (pkg) {
    try {
      const data = JSON.parse(pkg) as { name?: unknown; productName?: unknown; description?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      const deps = new Set([...Object.keys(data.dependencies ?? {}), ...Object.keys(data.devDependencies ?? {})]);
      const stack = ['electron', 'next', 'react', 'vue', 'svelte', 'preact', 'express', 'typescript'].filter((name) => deps.has(name)).map((name) => (name === 'typescript' ? 'TypeScript' : displayName(name)));
      const name = typeof data.productName === 'string' ? data.productName : typeof data.name === 'string' ? data.name : undefined;
      return { ...(name ? { name } : {}), ...(typeof data.description === 'string' && data.description.trim() ? { description: data.description } : {}), stack: stack.join(', ') || 'Node.js', source: 'package.json' };
    } catch { /* not JSON: the next source */ }
  }
  const py = read(folder, 'pyproject.toml');
  if (py) {
    const name = tomlValue(py, 'project', 'name') ?? tomlValue(py, 'tool.poetry', 'name');
    const description = tomlValue(py, 'project', 'description') ?? tomlValue(py, 'tool.poetry', 'description');
    if (name || description) return { ...(name ? { name } : {}), ...(description ? { description } : {}), stack: 'Python', source: 'pyproject.toml' };
  }
  const cargo = read(folder, 'Cargo.toml');
  if (cargo) {
    const name = tomlValue(cargo, 'package', 'name');
    const description = tomlValue(cargo, 'package', 'description');
    if (name) return { name, ...(description ? { description } : {}), stack: 'Rust', source: 'Cargo.toml' };
  }
  const gomod = read(folder, 'go.mod');
  const module = gomod ? /^module\s+(\S+)/m.exec(gomod)?.[1] : undefined;
  if (module) return { name: module.split('/').pop() ?? module, stack: 'Go', source: 'go.mod' };
  return undefined;
}

function existing(folder: string, routes: readonly string[]): string[] {
  return routes.filter((route) => { try { return statSync(path.join(folder, ...route.split('/'))).isFile(); } catch { return false; } });
}

/** The `.codex/prompts/*.md` custom prompts (Codex's own slash prompts) – named only. */
function codexPrompts(folder: string): string[] {
  try { return readdirSync(path.join(folder, '.codex', 'prompts'), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => `.codex/prompts/${entry.name}`).sort().slice(0, 20); } catch { return []; }
}

/** Everything create.ts and the dialog need about `folder` (an absolute folder the caller checked). */
export function analyzeFolder(folder: string, agents: Array<{ id: string; name: string }> = []): FolderFinding {
  const label = path.basename(folder) || folder;
  const found = manifest(folder);
  const readmeText = READMES.map((name) => read(folder, name)).find((text) => text !== undefined);
  const readme = readmeText ? readmeParts(readmeText) : {};
  const rawName = found?.name ?? readme.title ?? label;
  const source = found?.name ? found.source : readme.title ? 'README' : 'folder name';
  const name = displayName(rawName);
  const about = cut(oneLine(found?.description ?? readme.about ?? ''), ABOUT_MAX);
  const lead = found?.description ? oneLine(found.description) : readme.about ? oneLine(readme.about.split(/(?<=[.!?])\s/)[0] ?? '') : '';
  const role = cut(lead && lead.length <= ROLE_MAX - 12 ? `Works on ${name}: ${lead.replace(/[.!?]$/, '')}` : `Works on ${name}${found?.stack ? ` (${found.stack})` : ''}`, ROLE_MAX);
  const instructions = projectFiles(folder).map((file) => file.route);
  const discovered = discoverSkills(folder, { authority: 'external', ...HOME_DISCOVERY });
  return {
    folder, label, name, role, source, about, instructions,
    skills: discovered.skills.map((skill) => skill.name).sort(),
    configs: [...existing(folder, CONFIGS), ...codexPrompts(folder)],
    agents,
  };
}
