// Workforce meeting server – command line entry: `node src/main.ts` (Node 22.18+ or 24, which run
// TypeScript directly). Settings come from the environment (README.md): RELAY_PORT (default 8787),
// RELAY_HOST (default 0.0.0.0; 127.0.0.1 with RELAY_TRUST_PROXY=1, so only the local TLS reverse
// proxy reaches the raw port and nobody else can claim an X-Forwarded-For address), RELAY_IP_HEADER
// (with it: the header that carries the client address, cf-connecting-ip behind Cloudflare/Render)
// and the RELAY_* limits of limits.ts. Logs one line per start/stop and nothing about devices.
// Owns: reading the environment, starting and stopping the server on signals. Never: logic.

import { createRelay } from './relay.ts';
import { limitsFromEnv } from './limits.ts';

const env = process.env;
const port = Number(env.RELAY_PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('RELAY_PORT must be a port number.');
  process.exit(2);
}
const trustProxy = env.RELAY_TRUST_PROXY === '1';
const host = env.RELAY_HOST || (trustProxy ? '127.0.0.1' : '0.0.0.0');
if (trustProxy && !/^(127\.|::1$|localhost$)/.test(host)) {
  console.warn(JSON.stringify({ at: new Date().toISOString(), message: 'RELAY_TRUST_PROXY=1 with a non-loopback RELAY_HOST: clients that reach the port directly can fake their address and bypass the per-address limits' }));
}

const relay = await createRelay({
  port,
  host,
  trustProxy,
  ipHeader: env.RELAY_IP_HEADER || undefined,
  limits: limitsFromEnv(env),
  log: (message, data) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...data })),
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await relay.close();
  console.log(JSON.stringify({ at: new Date().toISOString(), message: 'meeting server stopped' }));
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
