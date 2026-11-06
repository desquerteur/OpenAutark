// Publishing one of my skills or notes to the public library (B-078 D13, owner 06.11.2026: "wenn die KI sich sicher ist …
// wenn in irgendeinem Textdokument nichts wirklich Internes drinsteht, kann das gerne geteilt werden"): the setting
// library.publish (default on) lets it happen; the text goes out only when the secrets redaction changes nothing in it, no
// path, e-mail address or host of this PC is in it, and the decision model finds no person, company, customer, path or
// account name. Then a branch and a pull request to teydra/OpenAutark under library/<kind>/<name>/SKILL.md, made with the
// person's own GitHub sign-in through gh (a fork when their account cannot push there). An Action in OpenAutark merges
// library-only pull requests after its own secret scan.
// Owns: the checks, their order and the GitHub calls. Never: stores a token, pushes anything outside library/, or publishes past a failed check.

import type { PublishInput, PublishResult } from '../../shared/model/library.ts';
import { LIBRARY_FOLDER, LIBRARY_REPO } from '../../shared/model/library.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { skillSlug } from '../skills/import-text.ts';
import { runCommand, type Run } from './exec.ts';

const GH_MS = 60_000;
const CHECK_MS = 90_000;
const MAX_TEXT = 60_000;

export interface PublishDeps {
  /** settings.json library.publish (default true). */
  enabled: () => boolean;
  redact: (text: string) => string;
  /** The decision model; undefined = none connected. */
  check?: StructuredRunner;
  run?: Run;
  gh?: string;
  now: () => number;
  /** A pause between the tries on a fresh fork (tests pass a quick one). */
  wait?: (ms: number) => Promise<void>;
}

/** GitHub makes a fork in the background: its refs answer a few seconds after POST /forks. */
const FORK_TRIES = 5;
const FORK_WAIT_MS = 3_000;
const SHA = /^[0-9a-f]{40}$/;

/**
 * What gives a text away as this PC's or a person's own, without a model: a drive, home (also after a backtick, quote
 * or bracket), ~/ or UNC path, an e-mail address, a private address.
 */
const LOCAL = /\b[A-Za-z]:[\\/][^\s]*|(?:^|[\s`'"(\[])\/(?:Users|home)\/[^\s/]+|(?:^|[\s`'"(\[])~\/[^\s]+|\\\\[^\s\\]+\\|\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b|\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\blocalhost:\d+/;

const CHECK_SYSTEM = [
  'I check a text before it goes into a public library that anyone on the internet reads.',
  'I look for what is internal: names of people, companies, customers or projects that are not public, account names or IDs, file paths of a PC, internal hosts and URLs, prices, figures or plans of a business.',
  'Public tools, programming languages, libraries, well-known products and public websites are fine.',
  'I answer as JSON: internal (true when anything internal is in it) and found (each internal detail, a few words each).',
].join('\n');
const CHECK_SCHEMA = { type: 'object', additionalProperties: false, required: ['internal', 'found'], properties: { internal: { type: 'boolean' }, found: { type: 'array', items: { type: 'string' } } } };

/** The text with derived-from in its front matter (a text without front matter gets one with name and kind). */
export function publishedText(input: PublishInput, name: string): string {
  const text = input.text.replace(/\r\n?/g, '\n').trim();
  const derived = input.derivedFrom?.filter((item) => item.trim()).map((item) => item.trim()) ?? [];
  const extra = [`kind: ${input.kind}`, ...(derived.length ? [`derived-from: ${JSON.stringify(derived)}`] : [])].filter((line) => !new RegExp(`^${line.split(':')[0]}:`, 'm').test(text));
  if (text.startsWith('---\n')) return `---\n${extra.join('\n')}${extra.length ? '\n' : ''}${text.slice(4)}\n`;
  return `---\nname: ${name}\n${extra.join('\n')}\n---\n\n${text}\n`;
}

const first = (text: string): string => text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? '';

/** Runs every check and, when all pass, opens the pull request. Never throws. */
export async function publishEntry(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  let enabled = true;
  try { enabled = deps.enabled(); } catch { enabled = true; }
  if (!enabled) return { ok: false, reason: 'off', text: 'Publishing to the public library is off on this PC (settings.json library.publish), so what I wrote stays here.' };
  const name = skillSlug(input.name);
  if (!name) return { ok: false, reason: 'failed', text: 'The entry needs a name of lowercase words joined by hyphens.' };
  const text = publishedText(input, name);
  if (text.length > MAX_TEXT) return { ok: false, reason: 'failed', text: `The text is longer than ${MAX_TEXT} characters; I publish a shorter one.` };
  if (deps.redact(text) !== text) return { ok: false, reason: 'secret', text: 'Not published: the text holds a stored secret value. I write it out before anything goes public.' };
  // The entry's name becomes its public folder, branch and title: it is checked together with the text.
  const checked = `${name}\n${text}`;
  const local = LOCAL.exec(checked);
  if (local) return { ok: false, reason: 'internal', text: `Not published: "${local[0].trim().slice(0, 80)}" belongs to this PC or a person. I write such details out, then publish again.` };
  if (!deps.check) return { ok: false, reason: 'no-check', text: 'Not published: no model is connected to check the text for internal names, so it stays here for now.' };
  try {
    const reply = await deps.check({ purpose: 'library-check', system: CHECK_SYSTEM, prompt: checked, schema: CHECK_SCHEMA, signal: AbortSignal.timeout(CHECK_MS), deadlineMs: CHECK_MS });
    const verdict = (reply.structured ?? JSON.parse(/\{[\s\S]*\}/.exec(reply.text)?.[0] ?? '{}')) as { internal?: unknown; found?: unknown };
    if (typeof verdict.internal !== 'boolean') return { ok: false, reason: 'no-check', text: 'Not published: the check gave no clear answer, so the text stays here for now.' };
    const found = Array.isArray(verdict.found) ? verdict.found.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
    if (verdict.internal) return { ok: false, reason: 'internal', text: `Not published: the check found internal details (${found.join('; ') || 'not named'}). I write them out, then publish again – or keep it here.` };
  } catch (error) {
    return { ok: false, reason: 'no-check', text: `Not published: the check did not answer (${(error as Error).message}).` };
  }
  return openPullRequest(input.kind, name, text, deps);
}

async function openPullRequest(kind: PublishInput['kind'], name: string, text: string, deps: PublishDeps): Promise<PublishResult> {
  const run = deps.run ?? runCommand;
  const gh = deps.gh ?? 'gh';
  const call = (args: string[], input?: unknown) => run(gh, args, { timeoutMs: GH_MS, ...(input !== undefined ? { input: JSON.stringify(input) } : {}) });
  const status = await call(['auth', 'status']);
  if (status.missing) return { ok: false, reason: 'no-gh', text: 'gh (the GitHub CLI) is not on this PC, so I cannot open the pull request. With gh installed and signed in (gh auth login), I publish with the person\'s own GitHub account.' };
  if (status.code !== 0) return { ok: false, reason: 'signed-out', text: 'gh is not signed in to GitHub on this PC. After "gh auth login" I publish with the person\'s own account.' };
  const fail = (step: string, result: { stderr: string; stdout: string }): PublishResult => ({ ok: false, reason: 'failed', text: `Not published: ${step} failed (${first(result.stderr) || first(result.stdout)}).` });
  const login = await call(['api', 'user', '--jq', '.login']);
  if (login.code !== 0) return fail('reading the GitHub login', login);
  const repo = await call(['api', `repos/${LIBRARY_REPO}`, '--jq', '[.default_branch, (.permissions.push // false)] | @tsv']);
  if (repo.code !== 0) return fail(`reading ${LIBRARY_REPO}`, repo);
  const [base, push] = repo.stdout.trim().split('\t');
  const repoName = LIBRARY_REPO.split('/')[1];
  let owner = LIBRARY_REPO.split('/')[0];
  const forked = push !== 'true';
  if (forked) {
    const fork = await call(['api', '-X', 'POST', `repos/${LIBRARY_REPO}/forks`, '--jq', '.owner.login']);
    if (fork.code !== 0) return fail('forking the library', fork);
    owner = fork.stdout.trim() || login.stdout.trim();
  }
  const sha = await call(['api', `repos/${LIBRARY_REPO}/git/ref/heads/${base || 'main'}`, '--jq', '.object.sha']);
  if (sha.code !== 0) return fail('reading the library\'s newest state', sha);
  const stamp = new Date(deps.now()).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const branch = `library/${kind}/${name}-${stamp}`;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ref = await call(['api', '-X', 'POST', `repos/${owner}/${repoName}/git/refs`, '--input', '-'], { ref: `refs/heads/${branch}`, sha: sha.stdout.trim() });
  for (let tries = 1; forked && ref.code !== 0 && tries < FORK_TRIES; tries++) { // a fresh fork is not ready yet: a few tries, about 12 s in all
    await wait(FORK_WAIT_MS);
    ref = await call(['api', '-X', 'POST', `repos/${owner}/${repoName}/git/refs`, '--input', '-'], { ref: `refs/heads/${branch}`, sha: sha.stdout.trim() });
  }
  if (ref.code !== 0) return fail('creating the branch', ref);
  const file = `${LIBRARY_FOLDER}/${kind}/${name}/SKILL.md`;
  // An entry that is already in the library (a second publish, a better version): the PUT names the file's current sha.
  const existing = await call(['api', `repos/${owner}/${repoName}/contents/${file}?ref=${encodeURIComponent(branch)}`, '--jq', '.sha // empty']);
  const known = existing.code === 0 && SHA.test(existing.stdout.trim()) ? existing.stdout.trim() : undefined;
  const put = await call(['api', '-X', 'PUT', `repos/${owner}/${repoName}/contents/${file}`, '--input', '-'], { message: `library: ${kind} ${name}`, content: Buffer.from(text, 'utf8').toString('base64'), branch, ...(known ? { sha: known } : {}) });
  if (put.code !== 0) return fail('writing the file', put);
  const pr = await call(['api', '-X', 'POST', `repos/${LIBRARY_REPO}/pulls`, '--input', '-', '--jq', '.html_url'], {
    title: `library: ${kind} ${name}`, head: owner === LIBRARY_REPO.split('/')[0] ? branch : `${owner}:${branch}`, base: base || 'main',
    body: `A ${kind} for the public library, published from Autark. It changes only ${file}.`,
  });
  if (pr.code !== 0) return fail('opening the pull request', pr);
  return { ok: true, url: pr.stdout.trim(), branch, path: file };
}
