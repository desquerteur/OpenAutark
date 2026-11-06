// B-053 track D test fixture: an in-process SMTP submission server on 127.0.0.1:0 (node:net, plain TCP – STARTTLS
// is a no-op upgrade through the tests' TLS seam). EHLO with multi-line capabilities, AUTH PLAIN / LOGIN, MAIL,
// RCPT (an address with "reject" gets 550), DATA up to the lone ".", RSET, QUIT. Keeps the dialogue (AUTH hidden),
// the raw DATA bytes as sent (still dot-stuffed) and the message after un-stuffing.
// Owns: that fake. Never: listens on anything but 127.0.0.1.

import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FakeSmtpOptions { user?: string; password?: string; auth?: string[]; starttls?: boolean; dataReply?: string }
export interface FakeMail { from: string; to: string[]; wire: string; message: string }

export class FakeSmtp {
  readonly dialogue: string[] = [];
  readonly mails: FakeMail[] = [];
  readonly opts: FakeSmtpOptions;
  port = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  constructor(opts: FakeSmtpOptions = {}) {
    this.opts = opts;
    this.server = createServer((socket) => this.serve(socket));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 fake.smtp ESMTP ready');
    let buf = '';
    let data: string | undefined;
    let login: 'user' | 'pass' | undefined;
    let user = '';
    let from = '';
    let to: string[] = [];
    const authOk = (u: string, p: string) => u === (this.opts.user ?? 'me@example.com') && p === (this.opts.password ?? 'app-pass');
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        if (data !== undefined) {
          const end = buf.indexOf('\r\n.\r\n');
          const lead = data === '' && buf.startsWith('.\r\n');
          if (end < 0 && !lead) return;
          const wire = lead ? '' : buf.slice(0, end + 2);
          buf = buf.slice(lead ? 3 : end + 5);
          data = undefined;
          const message = Buffer.from(wire.replace(/^\.\./, '.').replace(/\r\n\.\./g, '\r\n.'), 'latin1').toString('utf8');
          this.mails.push({ from, to, wire, message });
          say(this.opts.dataReply ?? '250 2.0.0 queued');
          continue;
        }
        const at = buf.indexOf('\r\n');
        if (at < 0) return;
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (login === 'user') { user = Buffer.from(line, 'base64').toString('utf8'); login = 'pass'; this.dialogue.push('<user>'); say('334 UGFzc3dvcmQ6'); continue; }
        if (login === 'pass') { login = undefined; this.dialogue.push('<password>'); say(authOk(user, Buffer.from(line, 'base64').toString('utf8')) ? '235 2.7.0 ok' : '535 5.7.8 bad credentials'); continue; }
        const verb = line.split(' ')[0].toUpperCase();
        this.dialogue.push(verb === 'AUTH' ? `AUTH ${line.split(' ')[1]} <hidden>` : line);
        if (verb === 'EHLO') {
          const caps = [...(this.opts.starttls ? ['STARTTLS'] : []), `AUTH ${(this.opts.auth ?? ['PLAIN', 'LOGIN']).join(' ')}`, '8BITMIME'];
          socket.write(['250-fake.smtp hello', ...caps.map((c, i) => `250${i === caps.length - 1 ? ' ' : '-'}${c}`)].join('\r\n') + '\r\n');
        } else if (verb === 'STARTTLS') say('220 2.0.0 go ahead');
        else if (verb === 'AUTH' && /^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          say(authOk(u, p) ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
        } else if (verb === 'AUTH' && /^AUTH LOGIN$/i.test(line)) { login = 'user'; say('334 VXNlcm5hbWU6'); }
        else if (verb === 'MAIL') { from = /<([^>]*)>/.exec(line)?.[1] ?? ''; to = []; say('250 2.1.0 ok'); }
        else if (verb === 'RCPT') {
          const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (rcpt.includes('reject')) say('550 5.1.1 no such user here');
          else { to.push(rcpt); say('250 2.1.5 ok'); }
        } else if (verb === 'DATA') { data = ''; say('354 go ahead'); }
        else if (verb === 'RSET') say('250 ok');
        else if (verb === 'QUIT') { say('221 bye'); socket.end(); }
        else say('502 5.5.1 unknown');
      }
    });
  }
}
