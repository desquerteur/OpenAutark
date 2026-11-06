// A split's own git worktree (B-057, runtime/git/split-worktree.ts): its state and the shared limits. Task worktrees
// are gone – agents use git in the shell.
// Owns: these shapes. Never: behaviour (runtime/git/*), or an absolute path.

/**
 * active = the folder exists; closed = folder removed, branch kept; merged = merged into the base
 * (branch deleted); discarded = branch deleted.
 */
export type WorktreeState = 'active' | 'closed' | 'merged' | 'discarded';

export const WORKTREE_LIMITS = {
  perRepo: 8,
  total: 20,
  viewNames: 50,
  storedNames: 200,
  agentPatchBytes: 64 * 1024,
  uiPatchBytes: 256 * 1024,
  commitMessage: 2000,
  branchSlug: 24,
} as const;
