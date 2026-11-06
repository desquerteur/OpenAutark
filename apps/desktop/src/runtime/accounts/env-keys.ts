// Provider keys from this PC's environment (PR5): an account with auth 'env' names the variable
// that holds its key (Account.envVar, from the one table shared/model/providers.ts
// ENV_KEY_PROVIDERS); the value is read from the runtime's own environment each time a key is
// needed. Such an account always talks to its provider's default endpoint – a row that names
// another variable, another provider's variable or a server URL (a crafted restore) gets no key,
// so a key from the environment never reaches another host.
// Owns: which variable keys which account and the in-process read.
// Never: stores, logs or returns a value to anything but the in-process caller (AccountService.apiKey).

import { envKeyProvider, type Account, type ProviderId } from '../../shared/model/providers.ts';
import { LOCAL_PROVIDERS } from '../engines/http/common.ts';

const MAX_KEY = 4096;

/** The key an 'env' account's variable holds right now; undefined when unset, empty or not this account's to use. */
export function envKey(account: Pick<Account, 'provider' | 'auth' | 'envVar' | 'baseUrl'>, env: NodeJS.ProcessEnv): string | undefined {
  if (account.auth !== 'env' || !account.envVar || account.baseUrl !== undefined) return undefined;
  if (envKeyProvider(account.envVar) !== account.provider || LOCAL_PROVIDERS.has(account.provider)) return undefined;
  const value = env[account.envVar]?.trim();
  return value && value.length <= MAX_KEY ? value : undefined;
}

/** Why `envVar` cannot key a new `provider` account; undefined when it can (the variable is set). */
export function envKeyProblem(provider: ProviderId, envVar: string, env: NodeJS.ProcessEnv): string | undefined {
  if (envKeyProvider(envVar) !== provider) return 'This environment variable holds no key for this provider.';
  if (LOCAL_PROVIDERS.has(provider)) return 'A local server needs no key.';
  if (!envKey({ provider, auth: 'env', envVar }, env)) return `${envVar} is not set for Autark. Set it, restart Autark and try again.`;
  return undefined;
}
