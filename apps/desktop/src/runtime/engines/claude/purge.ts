// Deleting Claude Code's session histories through its own CLI (wave 2, privacy): Claude Code 2.1.303
// has no command that deletes one session, but `claude purge --all --yes` removes every project's
// transcripts, tasks, file history and project config entries of the config home it runs with
// (CLAUDE_CONFIG_DIR) – verified 23.10. on an isolated scratch home: exit 0 "Purged N item(s) across
// all projects", exit 1 "No Claude Code project state found" when there is nothing.
// Owns: the command line and how its answer is read. Never: reads, edits or deletes files itself,
// touches the auth/credential files (purge leaves them; we never look), or runs for a home the caller
// did not vet (privacy/native-history.ts allows only this app's isolated homes).

import type { Account } from '../../../shared/model/providers.ts';
import type { Executable } from '../../accounts/executables.ts';
import { runCli } from '../../accounts/cli.ts';
import type { Supervisor } from '../../system/supervisor.ts';

export const PURGE_ARGS = ['purge', '--all', '--yes'] as const;
const NOTHING = /no claude code project state found/i;
const PURGED = /purged\s+\d+\s+item/i;
const TIMEOUT_MS = 120_000;

export async function purgeHistories(supervisor: Supervisor, exe: Executable, account: Account, env: NodeJS.ProcessEnv, cwd: string): Promise<{ purged: boolean; message?: string }> {
  const result = await runCli(supervisor, exe, [...PURGE_ARGS], { env, cwd, timeoutMs: TIMEOUT_MS, owner: `claude-purge:${account.id}` });
  const said = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) throw new Error('Claude Code did not finish deleting its histories.');
  if (result.code === 0 && (PURGED.test(said) || !NOTHING.test(said))) return { purged: true };
  if (NOTHING.test(said)) return { purged: false, message: 'Claude Code had no stored sessions for this account.' };
  throw new Error(`Claude Code could not delete its histories (exit ${result.code ?? 'unknown'}).`);
}
