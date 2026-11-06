// Migration 29 (PR5, planned as 010): a provider key from this PC's environment. `env_var` names
// the variable of an account with auth 'env' (shared/model/providers.ts ENV_KEY_PROVIDERS); the
// account service reads its value in-process when a key is needed – the value is never stored.
// NULL for every other account.

export const sql = /* sql */ `
ALTER TABLE accounts ADD COLUMN env_var TEXT;
`;
