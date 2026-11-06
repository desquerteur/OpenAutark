# Autark meeting server

A small, self-hostable meeting point for Autark PCs in different networks (other homes, mobile
hotspots, CGNAT): they find each other here by Remote ID and then talk directly. Autark connects to
the hosted meeting server `wss://telecoding-relay.onrender.com/autark` by default; a server run with
this folder or the bundled `app/meet.mjs` replaces it once its `wss://` address is set in
`devices.relay` of settings.json (the AI sets it on request). `npm run check` here uses the
TypeScript of `apps/desktop`, so run `npm ci` there first.

What it does:

- **Devices meet and talk directly.** Each PC registers under its device key (it signs a fresh
  challenge), lists the PCs it has pinned and its peer listener port. The server builds each PC's
  public address from the source it sees and that port, and shares it only between two PCs that
  pinned each other. The PCs then dial each other directly (a fixed IP or a forwarded port answers).
- **Tunnel only as the last fallback.** When no direct path answers, a tunnel forwards opaque
  frames: the PCs run their usual pinned-key handshake and AES-256-GCM peer channel through it,
  the handshake frames are sealed to the other PC's signed per-session key, and the opener signs its
  tunnel key. The server cannot read or alter the traffic, stand in for a PC, or add one.
- **Connect by Remote ID.** A PC that accepts connection requests can be found by its 9-digit
  Remote ID (never by name). The request messages are sealed end to end; the person on the target
  PC still compares the 4-digit code and accepts. Rate-limited per key and per client address.
- **Remove is immediate.** When a PC removes another, it unpins it here: presence ends and open
  tunnels between them close.

## Run it

Node.js 22.18 or newer runs the TypeScript sources directly.

```sh
npm ci --omit=dev
RELAY_PORT=8787 RELAY_TRUST_PROXY=1 npm start   # behind a local TLS proxy; listens on 127.0.0.1
```

Put it behind a TLS reverse proxy (Caddy, nginx) and give the PCs the `wss://` address, for example
`wss://meet.example.org`. With a proxy set `RELAY_TRUST_PROXY=1` so addresses and limits use
`X-Forwarded-For` (keep the raw port on loopback). Plain `ws://` is accepted by the app only for
this PC or a private network. `GET /healthz` returns counts only. Tests: `npm test`.

**From the installed app.** The desktop build bundles this server into one file, `app/meet.mjs`
(`node scripts/build.mjs --only meet` in `apps/desktop`; in an installed app under
`resources/app.asar.unpacked/app/meet.mjs`). On a PC with a public address it runs with the app's own
Node or an installed one, with the same environment as above:

```sh
RELAY_PORT=8787 RELAY_TRUST_PROXY=1 ELECTRON_RUN_AS_NODE=1 "<Autark program>" "<path>/meet.mjs"
RELAY_PORT=8787 RELAY_TRUST_PROXY=1 node "<path>/meet.mjs"
```

**As a container.** `docker build -t autark-meet services/remote-relay` (the `Dockerfile` here). It
listens on `$PORT` (default 8787) on every interface with `RELAY_TRUST_PROXY=1`, for hosts whose TLS
proxy is the only way in (Render, Fly, Railway); the start line warns about exactly that pairing. The
host's `wss://` address then goes into `devices.relay` on every PC. Health check: `/healthz`. Behind
Cloudflare (Render) also set `RELAY_IP_HEADER=cf-connecting-ip`: there `X-Forwarded-For` ends with a
Cloudflare address, not the PC's.

**Inside another server.** `createRelay({ noServer: true, ... })` listens nowhere; the host program
passes the WebSocket upgrades of one path to `relay.handleUpgrade(request, socket, head)`. The
TeleCoding relay does this for `/autark` (`wss://telecoding-relay.onrender.com/autark`), with a copy
of `src/relay.ts`, `src/protocol.ts` and `src/limits.ts` in its `apps/relay/src/autark/`.

**On one PC for tests.** `RELAY_PORT=8790 RELAY_HOST=127.0.0.1 node src/main.ts` and
`"relay": "ws://127.0.0.1:8790"` (the e2e `test/e2e/runtime-remote.test.mjs` in `apps/desktop` does this).

## Limits (environment, defaults)

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_MAX_CONNECTIONS` | 1000 | connections in total |
| `RELAY_MAX_PER_IP` | 10 | connections per client address (IPv6: per /64) |
| `RELAY_REGISTRATIONS_PER_MINUTE` | 30 | new registrations per client address |
| `RELAY_HELLO_TIMEOUT_MS` | 10000 | time to register after connecting |
| `RELAY_MAX_TUNNELS` | 32 | open tunnels per device |
| `RELAY_BYTES_PER_SECOND` | 524288 | tunnel bytes per device (burst 8 s); excess pauses the sender |
| `RELAY_CONTROL_PER_SECOND` | 20 | control messages per device (burst 3 s) |
