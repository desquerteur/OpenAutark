// Where embedded files are, by one stored form: below <data>/memory a path "memory/…" (the data folder may move), else
// the absolute path. `key` is that form with forward slashes (lower case on Windows): what a place filters by.
// The exclusions of a folder walk live here too: dependency and cache folders, app data, browser profiles, hidden
// entries and everything that looks like a secret are never embedded from a folder (a file named on purpose is). A folder
// that is secrets, a browser profile, app data itself or a whole drive stays out even when it is the one named. The memory
// tree is no folder of the PC: a topic folder "build", a note about tokens or a _folder.md are memory (only what is hidden or
// binary stays out there; walkFolder's `memory`). "catalog/…" is the place of virtual entries (vectors/virtual.ts): a key, no file.
// Owns: path forms, the exclusions and the walk. Never: reads file contents or embeds.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_PLACE = 'memory';
/** The virtual entries' place (vectors/virtual.ts CATALOG_PLACE): keys, no files; `absolute` is ''. */
const CATALOG_PLACE = 'catalog';

export interface Place {
  /** The filter form (forward slashes, folded case on Windows, no trailing slash). */
  key: string;
  /** "memory/…" or the absolute path. */
  path: string;
  /** Absolute path on this PC. */
  absolute: string;
}

const inside = (root: string, target: string): string | undefined => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? relative : undefined;
};

export class Places {
  readonly memoryRoot: string;
  private readonly fold: boolean;

  constructor(memoryRoot: string, platform: NodeJS.Platform = process.platform) {
    this.memoryRoot = path.resolve(memoryRoot);
    this.fold = platform === 'win32';
  }

  /** A place in the memory tree, the one thing that embeds itself. */
  isMemory(place: Place): boolean {
    return place.path === MEMORY_PLACE || place.path.startsWith(`${MEMORY_PLACE}/`);
  }

  /** A given place: "memory", "memory/…" or an absolute path; undefined for anything else. */
  resolve(given: string): Place | undefined {
    const trimmed = given.trim();
    if (!trimmed) return undefined;
    const stripped = trimmed.replace(/[\\/]+$/, '');
    const text = stripped && !/^[a-zA-Z]:$/.test(stripped) ? stripped : trimmed; // a drive keeps its slash
    if (text === CATALOG_PLACE || text.startsWith(`${CATALOG_PLACE}/`)) return { key: this.keyOf(text), path: text, absolute: '' }; // virtual entries (vectors/virtual.ts): no file
    const absolute = text === MEMORY_PLACE || /^memory[\\/]/.test(text) ? path.join(this.memoryRoot, text.slice(MEMORY_PLACE.length)) : path.isAbsolute(text) ? path.resolve(text) : undefined;
    if (!absolute) return undefined;
    const below = inside(this.memoryRoot, absolute);
    const stored = below === undefined ? absolute : [MEMORY_PLACE, ...below.split(path.sep).filter(Boolean)].join('/');
    return { key: this.keyOf(stored), path: stored, absolute };
  }

  /** The absolute path of a stored path. */
  absoluteOf(stored: string): string {
    return stored === MEMORY_PLACE || stored.startsWith(`${MEMORY_PLACE}/`) ? path.join(this.memoryRoot, stored.slice(MEMORY_PLACE.length)) : stored;
  }

  keyOf(stored: string): string {
    const slashes = stored.replaceAll('\\', '/').replace(/\/+$/, '');
    return this.fold ? slashes.toLowerCase() : slashes;
  }
}

/** Folders a walk never enters (lower case). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'env', 'site-packages', 'bin', 'obj',
  'cache', 'caches', 'tmp', 'temp', 'logs', 'appdata', 'application data', 'local settings', 'library', 'snap',
  '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata',
]);
/** A folder holding one of these is a browser profile (cookies, saved logins) or Chromium's folder of profiles (its encrypted key). */
const PROFILE_MARKS: ReadonlySet<string> = new Set(['login data', 'cookies', 'cookies.sqlite', 'logins.json', 'key4.db', 'web data', 'local state']);
const SECRET_DIRS: ReadonlySet<string> = new Set(['.ssh', '.gnupg', '.aws']);
const APP_DATA: ReadonlySet<string> = new Set(['appdata', 'application data']);
/** Key files by name or ending; an export or list by its word and a data ending (login.ts is code, logins.csv is not). */
const SECRET_FILE = /^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|pfx|p12|ppk|kdbx|kdb|keychain|1pux|1pif|gpg|asc|jks|keystore|env)$|(^|[ ._-])(passwords?|passw(ö|oe?)rter|passwort|credentials?|secrets?|logins?|tokens?|api[ _-]?keys?)([ ._-][^.]*)?\.(json|csv|tsv|txt|ya?ml|toml|xml|ini|conf|cfg)$|(^|[ ._-])(bitwarden|lastpass|1password|keepass(xc)?|dashlane|nordpass|enpass)[ ._-]?[^.]*\.(json|csv|tsv|txt|xml)$/i;
const BINARY_FILE = /\.(exe|dll|so|dylib|bin|dat|db|sqlite\d?|mdb|iso|img|vhdx?|zip|7z|rar|gz|bz2|xz|tar|tgz|jar|war|apk|msi|cab|class|o|a|lib|pyc|wasm|onnx|gguf|safetensors|pt|ckpt|png|jpe?g|gif|webp|bmp|ico|tiff?|heic|svgz|psd|ai|mp[34]|m4[av]|wav|flac|ogg|opus|aac|avi|mkv|mov|webm|wmv|ttf|otf|woff2?|eot|docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|key)$/i;

/** Machine-written text: lockfiles, minified code, source maps, logs. Embedding them only buries what a person wrote. */
const GENERATED_FILE = /\.(log|lock|map)$|\.min\.(js|css)$|^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/i;

/** Why a folder or file below a walked folder stays out, or undefined. */
export function excluded(name: string, directory: boolean): string | undefined {
  const lower = name.toLowerCase();
  if (directory) {
    if (SECRET_DIRS.has(lower)) return 'secrets';
    if (lower === '.git') return 'version control';
    if (lower.startsWith('.')) return 'hidden folder';
    return SKIP_DIRS.has(lower) ? 'dependencies, caches or app data' : undefined;
  }
  if (lower.startsWith('.env')) return 'secrets';
  if (lower.startsWith('.')) return 'hidden file';
  if (SECRET_FILE.test(name)) return 'looks like secrets';
  if (GENERATED_FILE.test(name)) return 'generated';
  return BINARY_FILE.test(name) ? 'binary' : undefined;
}

/** Why a file below the memory tree stays out of a walk of it, or undefined. */
const excludedInMemory = (name: string): string | undefined => (name.startsWith('.') ? 'hidden file' : BINARY_FILE.test(name) ? 'binary' : undefined);

/** Why a folder named on purpose stays out as a whole, or undefined. A program's own folder below app data may be named. */
export function refusedFolder(absolute: string): string | undefined {
  if (absolute === path.parse(absolute).root) return 'a whole drive – name the folders that matter';
  const parts = absolute.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => SECRET_DIRS.has(part))) return 'secrets';
  return APP_DATA.has(parts[parts.length - 1]) || APP_DATA.has(parts[parts.length - 2]) ? 'app data' : undefined;
}

/** The path is really gone: not found while its drive or share answers (a drive that is away proves nothing). */
export async function isGone(file: string): Promise<boolean> {
  try {
    await stat(file);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
    return stat(path.parse(file).root).then(() => true, () => false);
  }
}

export interface WalkResult {
  files: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** Files left out per reason (only folders and the first few files are named one by one). */
  counts: Map<string, number>;
  /** The walk stopped at its limits, so a missing file proves nothing. */
  cut: boolean;
}

const MAX_NAMED = 40;

/** The files below `root` that may be embedded, depth first; links are not followed. */
export async function walkFolder(root: string, limits: { deadline: number; maxFiles: number; now: () => number; memory?: boolean }): Promise<WalkResult> {
  const out: WalkResult = { files: [], skipped: [], counts: new Map(), cut: false };
  const skip = (where: string, reason: string, name = true) => {
    out.counts.set(reason, (out.counts.get(reason) ?? 0) + 1);
    if (name && out.skipped.length < MAX_NAMED) out.skipped.push({ path: where, reason });
  };
  const stack = [root];
  while (stack.length) {
    if (limits.now() > limits.deadline || out.files.length >= limits.maxFiles) { out.cut = true; break; }
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) { skip(dir, 'not readable'); continue; }
    if (!limits.memory && entries.some((entry) => entry.isFile() && PROFILE_MARKS.has(entry.name.toLowerCase()))) { skip(dir, 'browser profile'); continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const reason = limits.memory ? (entry.name.startsWith('.') ? 'hidden folder' : undefined) : excluded(entry.name, true);
        if (reason) skip(full, reason); else stack.push(full);
      } else if (entry.isFile()) {
        const reason = limits.memory ? excludedInMemory(entry.name) : excluded(entry.name, false);
        if (reason) skip(full, reason, reason !== 'binary'); else out.files.push(full);
      }
    }
  }
  return out;
}
