// AF-013: Claude Code's own permission system for an agent turn with an access policy (EngineTurnInput.access).
// Without a policy (full access, no rules) the turn keeps `--permission-mode bypassPermissions` as before. With one:
//   read     default mode; Edit/Write/MultiEdit/NotebookEdit disallowed; every other prompt (Bash, PowerShell …) asks the hub
//   ask      default mode; every prompt (edits, commands, web) asks the hub, which asks the person when the rules say so
//   project  acceptEdits (Claude Code itself lets edits inside the working folder and `--add-dir` folders through);
//            everything else asks the hub (commands, edits outside)
//   full     with rules: default mode, every prompt asks the hub, which allows all but what the rules forbid
// The hub's permission prompt tool (`--permission-prompt-tool`, access/prompt-tool.ts) judges each prompt with the same
// rules as every other engine; the hub's own tools are allowed here (`--allowedTools mcp__workforce`) because the tool
// registry judges each of them. A rule forbidding the network takes WebSearch and WebFetch away.
// Checked model-free with claude 2.1.311 (07.11.2026, an empty stream-json input): `--permission-prompt-tool`,
// `--permission-mode default|acceptEdits`, `--allowedTools`, `--disallowedTools` and `--add-dir` are taken.
// Not enforced by Claude Code: reads (Read, Glob, Grep never prompt – a denied folder is kept only from the app's own
// tools and from commands), and what a command allowed by a rule does once it runs.
// Owns: these arguments. Never: judges a step (the hub does).

import type { TurnAccessPolicy } from '../types.ts';
import { HUB_SERVER } from './stream.ts';

/** The hub's permission prompt tool as Claude Code names it (`access.prompt` → wire `access__prompt`). */
export const PERMISSION_TOOL = `mcp__${HUB_SERVER}__access__prompt`;

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** The permission arguments of an agent turn (with the hub); `policy` absent: bypassPermissions as before AF-013. */
export function permissionArgs(policy: TurnAccessPolicy | undefined): string[] {
  if (!policy) return ['--permission-mode', 'bypassPermissions'];
  const mode = policy.mode === 'project' ? 'acceptEdits' : 'default';
  const args = ['--permission-mode', mode, '--permission-prompt-tool', PERMISSION_TOOL, '--allowedTools', `mcp__${HUB_SERVER}`];
  const disallowed = [...(policy.mode === 'read' ? EDIT_TOOLS : []), ...(policy.networkDenied ? WEB_TOOLS : [])];
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  if (policy.mode === 'project' && policy.writable.length) args.push('--add-dir', ...policy.writable);
  return args;
}
