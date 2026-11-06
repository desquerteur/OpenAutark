// Command-line parsing of the wf terminal client (C7): `wf [--data <dir>] [--json] <command>
// [args] [options]`. Options may come anywhere (`--name value` or `--name=value`); `--` ends them;
// a lone `-` is an argument (read it from stdin).
// Owns: the option list, per-command option checks, number parsing. Never: reads files or the network.

import { CliError } from './errors.ts';

const VALUE_OPTIONS = new Set(['data', 'limit', 'status', 'timeout', 'count', 'dir', 'project', 'api-key', 'service-account']); // B-055: the last three for wf feedback setup
const FLAG_OPTIONS = new Set(['json', 'all', 'important', 'silent', 'wait', 'help', 'version', 'rotate']); // B-055: --rotate for wf feedback setup
/** Options every command accepts. */
const GLOBAL = new Set(['data', 'json', 'help', 'version']);

export interface Parsed {
  command?: string;
  args: string[];
  options: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (arg === '-h') { options.set('help', true); continue; }
    if (!arg.startsWith('--')) {
      if (/^-[A-Za-z]/.test(arg)) throw new CliError('bad_request', `Unknown option ${arg}.`);
      positional.push(arg); // also "-", "-1" and "- item"
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (FLAG_OPTIONS.has(name)) {
      if (eq > 0) throw new CliError('bad_request', `--${name} takes no value.`);
      options.set(name, true);
    } else if (VALUE_OPTIONS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++index];
      if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new CliError('bad_request', `--${name} needs a value.`);
      options.set(name, value);
    } else {
      throw new CliError('bad_request', `Unknown option --${name}.`);
    }
  }
  return { command: positional[0], args: positional.slice(1), options };
}

/** Refuses options the command does not use (a typo must not be ignored silently). */
export function checkOptions(parsed: Parsed, allowed: readonly string[]): void {
  for (const name of parsed.options.keys()) {
    if (!GLOBAL.has(name) && !allowed.includes(name)) throw new CliError('bad_request', `wf ${parsed.command} does not take --${name}.`);
  }
}

export function flag(parsed: Parsed, name: string): boolean {
  return parsed.options.get(name) === true;
}

export function text(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** An integer option within [min, max]; undefined when absent. */
export function integer(parsed: Parsed, name: string, min: number, max: number): number | undefined {
  const value = text(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new CliError('bad_request', `--${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

/** --timeout in seconds (fractions allowed) as milliseconds; undefined when absent. */
export function timeoutMs(parsed: Parsed): number | undefined {
  const value = text(parsed, 'timeout');
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!value.trim() || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new CliError('bad_request', '--timeout must be a number of seconds from 0 to 86400.');
  }
  return Math.round(seconds * 1000);
}
