// secrets.run (B-044 decision 11): the way a CLI engine (Claude Code, Codex, ACP agents – they run commands here with
// their own tools; shell.exec reaches them only through tools.find / tools.call, for a linked PC) uses a stored secret in a command: through the MCP hub's tool path
// (mcp/hub.ts → ToolRegistry.call: validation, journal) it runs one command on this
// PC (cwd: a workspace path or an absolute folder; default the workspace, or a split part's own folder) with an env whose values hold secret://<id> handles, resolved at
// spawn (command.ts, secrets/handles.ts: every stored secret of 4+ characters, a 2FA key as its current code – owner 29.10.2026: zero
// restrictions, card data included). The output has each value it received masked by its handle, then passes the leak redactor.
// Offered only through the hub (audience 'mcp'), in every mode. There is no command that prints a value.
// Owns: this tool. Never: runs without a handle (the engine's own shell does that), or returns a value.

import { handlesIn } from '../../secrets/handles.ts';
import type { ToolDef } from '../types.ts';
import { failure } from '../types.ts';
import { commandAction, ENV_SCHEMA, runCommand } from './command.ts';
import { commandCwd, defaultShell, shellResource, type ShellSpawn } from './files.ts';
import { clip, defineTool } from './util.ts';

interface RunArgs { command: string; env: Record<string, string>; cwd?: string; timeoutSeconds?: number }

export function secretRunTool(deps: { shell?: ShellSpawn } = {}): ToolDef {
  const shell = deps.shell ?? defaultShell;
  return defineTool<RunArgs>({
    name: 'secrets.run',
    description: 'Run one shell command on this PC with stored secrets in its environment, by handle: env {"GITHUB_TOKEN": "secret://<id>"} (secrets.list). The value replaces the handle only when the command starts and never reaches me; output that would show it is masked. cwd: a workspace path or any folder (default the workspace; a split part: its own folder). Every stored secret works here (a 2FA key gives its current code).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 8000 }, env: { ...ENV_SCHEMA }, cwd: { type: 'string', description: 'a workspace path or an absolute folder' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Seconds until the first timeout review, which can extend it or abort; decisions accompany the result.' },
      },
      required: ['command', 'env'], additionalProperties: false,
    },
    category: 'write_system', audience: 'mcp',
    describe: (args, ctx) => commandAction(ctx, { summary: `Run: ${clip(args.command, 200)}`, resource: shellResource(args.command, args.cwd), reversible: false, external: false }, args.env),
    async run(args, ctx) {
      if (!handlesIn(Object.values(args.env)).length) return failure('secrets.run is for commands that need a stored secret: put its handle in env (e.g. {"API_KEY": "secret://<id>"}). Other commands run in my own shell.');
      const cwd = commandCwd(ctx, args.cwd);
      return runCommand(shell, ctx, { command: args.command, cwd, timeoutSeconds: args.timeoutSeconds, env: args.env });
    },
  });
}
