// RPC contract part (wave 2; B-044: the Claude Code account rows of Settings › Models): what the providers keep
// of renewed native sessions and the person's deletion through the provider's own CLI. Handlers:
// runtime/rpc/handlers/provider-history.ts (privacy/native-history.ts). Merged into Methods by module
// augmentation. Owns: these method shapes. Never: behaviour.

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: Codex threads deleted/waiting/failed after a Forget, and the Claude Code accounts (this app's own homes) whose history can be cleared. */
    'privacy.providerHistories': {
      params: void;
      result: { codex: { deleted: number; waiting: number; failed: number }; claude: Array<{ accountId: string; label: string; sessions: number; running: boolean }> };
    };
    /** Owner, confirm: true: deletes every Claude Code session history of one of this app's accounts (claude purge --all); its sessions start fresh. */
    'privacy.purgeProviderHistory': {
      params: { accountId: string; confirm: true };
      result: { accountId: string; label: string; purged: boolean; renewed: number; message?: string };
    };
  }
}

export {};
