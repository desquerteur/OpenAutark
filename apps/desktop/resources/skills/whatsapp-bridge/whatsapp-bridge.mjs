// WhatsApp ↔ Autark chat bridge (template of the whatsapp-bridge skill). One small process: WhatsApp messages
// arrive in one Autark chat as their senders (messages.send with `as: {key, name}` through the chat's connector
// token), and the chat's final messages from agents and the person go back to WhatsApp. It uses the person's own
// WhatsApp account as a linked device (Baileys, like WhatsApp Web) – the QR code to scan is posted into the chat.
//
// Folder: <data>/connectors/whatsapp/ holding this file, config.json and (written here) auth/.
//   config.json  {"conversationId": "...", "token": "wfx_...", "allowed": ["4917612345678"], "replyTo": "4917612345678"}
//     token     – the chat's connector token (wf call chats.connectExternal {conversationId, name: "WhatsApp"})
//     allowed   – optional: only these numbers (digits, with country code) reach the chat; [] or absent = everyone
//     replyTo   – optional: the number (or group JID) that gets the chat's messages; default the last sender
// Run: npm install @whiskeysockets/baileys qrcode   (once, in this folder), then: node whatsapp-bridge.mjs
// Needs Node 20+. Reconnects by itself; stop it with Ctrl+C or by ending the process.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '..');
const config = JSON.parse(readFileSync(path.join(here, 'config.json'), 'utf8'));
const runtime = () => JSON.parse(readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')); // {port, token, pid} – re-read: the port changes per start
const base = () => `http://127.0.0.1:${runtime().port}`;
const allowed = new Set((config.allowed ?? []).map((number) => String(number).replace(/\D/g, '')));
let replyTo = config.replyTo ? jidOf(String(config.replyTo)) : undefined;
let socket;
let rpcId = 0;
const sent = new Set(); // chat message ids already forwarded

function jidOf(value) { return value.includes('@') ? value : `${value.replace(/\D/g, '')}@s.whatsapp.net`; }
function log(...parts) { console.log(new Date().toISOString(), ...parts); }

/** One call of the app's RPC with the chat's connector token. */
async function rpc(method, params) {
  const response = await fetch(`${base()}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ id: ++rpcId, method, params }),
  });
  const frame = await response.json();
  if (frame.error) throw new Error(`${method}: ${frame.error.message}`);
  return frame.result;
}

/** The QR code of a new link as an image in the chat. */
async function postQr(qr) {
  const png = await QRCode.toBuffer(qr, { width: 360 });
  writeFileSync(path.join(here, 'qr.png'), png);
  const file = await rpc('files.upload', { name: 'whatsapp-qr.png', mime: 'image/png', dataBase64: png.toString('base64') });
  await rpc('messages.send', { conversationId: config.conversationId, body: 'Scan this in WhatsApp › Settings › Linked devices › Link a device.', attachments: [{ fileId: file.id, name: 'whatsapp-qr.png', mime: 'image/png', size: png.length }] });
}

function textOf(message) {
  const m = message.message ?? {};
  return m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption
    ?? (m.imageMessage ? '[photo]' : m.audioMessage ? '[voice message]' : m.documentMessage ? `[file ${m.documentMessage.fileName ?? ''}]` : undefined);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(here, 'auth'));
  socket = makeWASocket({ auth: state, printQRInTerminal: false });
  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) await postQr(qr).catch((error) => log('qr not posted', error.message));
    if (connection === 'open') log('WhatsApp connected');
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      log('WhatsApp closed', loggedOut ? '(logged out – delete auth/ and start again to link anew)' : '(reconnecting)');
      if (!loggedOut) setTimeout(start, 3000);
    }
  });
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      const jid = message.key.remoteJid ?? '';
      if (message.key.fromMe || jid === 'status@broadcast') continue;
      const number = (message.key.participant ?? jid).split('@')[0].replace(/\D/g, '');
      if (allowed.size && !allowed.has(number)) continue;
      const body = textOf(message);
      if (!body) continue;
      if (!config.replyTo) replyTo = jid; // answers go to whoever wrote last
      try {
        await rpc('messages.send', { conversationId: config.conversationId, body, as: { key: number, name: message.pushName || number } });
      } catch (error) { log('not posted', error.message); }
    }
  });
}

/** The chat's events: final messages from agents and the person go to WhatsApp. */
async function follow() {
  for (;;) {
    try {
      const response = await fetch(`${base()}/events?topics=chat:${encodeURIComponent(config.conversationId)}`, { headers: { authorization: `Bearer ${config.token}` } });
      const decoder = new TextDecoder();
      let buffer = '';
      let event = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ') && (event === 'message.created' || event === 'message.updated')) await forward(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { log('events lost', error.message); }
    await new Promise((resolve) => setTimeout(resolve, 3000)); // the app restarted: listen again
  }
}

async function forward(message) {
  if (message.authorKind === 'external' || message.authorKind === 'system' || message.state !== 'final' || message.silent) return;
  if (message.kind !== 'text' && message.kind !== 'answer') return;
  if (sent.has(message.id) || !replyTo || !socket || !message.body?.trim()) return;
  sent.add(message.id);
  if (sent.size > 2000) sent.delete(sent.values().next().value);
  const name = message.author?.name;
  await socket.sendMessage(replyTo, { text: name ? `${name}: ${message.body}` : message.body }).catch((error) => log('not sent', error.message));
}

await start();
void follow();
