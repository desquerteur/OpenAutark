// B-052 track A test fixture: a stdio MCP server run with `process.execPath fake-stdio-server.mjs <mode>`.
// Modes: normal (initialize → 2025-06-18), old (answers 2024-11-05), modern (initialize → -32601, server/discover
// works, _meta required), garbage (prints non-JSON and never answers), dies (writes a token-bearing error to stderr
// and exits before answering). Behaviour: a log line on stdout before the initialize answer, which is split across
// writes and ends in CRLF; tools/list first sends a server request (roots/list) and tools/list_changed; tools echo /
// env (which variables it sees) / slow (never answers) / crash (exits mid-call) / state (the client's replies and
// cancellations so far). Exits on stdin EOF.
// Owns: that fake. Never: touches the network or files.

const mode = process.argv[2] ?? 'normal';
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const state = { replies: [], cancelled: [], initialized: false };
let buffer = '';

if (mode === 'dies') {
  process.stderr.write('    at Object.<anonymous> (index.js:1:1)\n'.repeat(100)); // pushes the first line out of the 2 KB tail
  process.stderr.write('Error: invalid API key sk-test-ABCDEFGHIJ1234567890 (MY_SECRET_VALUE_42 rejected)\n');
  setTimeout(() => process.exit(3), 20);
}
if (mode === 'garbage') process.stdout.write('Welcome to the server! Listening...\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(message) {
  if (mode === 'garbage') { process.stdout.write('still not json\n'); return; }
  if (mode === 'dies') return; // it is about to exit
  const { id, method, params = {} } = message;
  if (method === undefined) { state.replies.push(message); return; } // the client's reply to our request
  if (id === undefined) {
    if (method === 'notifications/initialized') state.initialized = true;
    if (method === 'notifications/cancelled') state.cancelled.push(params);
    return;
  }
  if (mode === 'modern' && method !== 'initialize' && params._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'no _meta' } });
    return;
  }
  switch (method) {
    case 'initialize': {
      if (mode === 'modern') { write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
      process.stdout.write('[log] starting up (not json)\n');
      const text = JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: mode === 'old' ? '2024-11-05' : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fake', version: '0.1' } } });
      process.stdout.write(text.slice(0, 10));
      setTimeout(() => process.stdout.write(`${text.slice(10)}\r\n`), 5);
      return;
    }
    case 'server/discover':
      write({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'stdio-modern', version: '9' } } });
      return;
    case 'tools/list':
      write({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list', params: {} });
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      write({ jsonrpc: '2.0', id, result: { tools: ['echo', 'env', 'slow', 'crash', 'state'].map((name) => ({ name, inputSchema: { type: 'object' } })) } });
      return;
    case 'tools/call': {
      const name = params.name;
      const text = (value) => write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: value }] } });
      if (name === 'echo') text(`echo ${JSON.stringify(params.arguments)} ünïcødé`);
      else if (name === 'env') text(JSON.stringify({ path: Boolean(process.env.PATH ?? process.env.Path), own: process.env.APP_OWN ?? null, leaked: process.env.WORKFORCE_LEAK_CHECK ?? null }));
      else if (name === 'state') text(JSON.stringify(state));
      else if (name === 'crash') { process.stderr.write('fatal: lost database connection\n'); setTimeout(() => process.exit(1), 5); }
      // 'slow' never answers
      return;
    }
    default:
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}
