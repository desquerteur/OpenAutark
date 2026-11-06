// RPC handlers (B-078, D5/D6): the owner's Android phone. phoneUse.attach – the app's own use socket makes phone use
// reachable while it is open (phone/app-driver.ts hears it on the bus) and gets my PCs back (this PC and my other PCs,
// never an employer's or an employee's), so the phone tunnels to the first one online; phoneUse.reply answers one
// phoneUse.request. Both only for the paired phone app itself (secure transport, a phone row with its key); so is
// phone.pcs – the same list for the iPhone web app, which claims no phone use; phone.forget – the phone app removes its
// own row (its Forget). phone.pairLink (owner): this PC's Remote ID and the QR of
// its pair link for "Connect a phone" (shared/api/methods-phone.ts PHONE_PAIR_LINK).
// Owns: param checks. Never: drives the phone or decides what it does.

import '../../../shared/api/methods-phone.ts';
import { phonePairLink, type PhonePc } from '../../../shared/api/methods-phone.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { DevicesRepo, type DeviceRecord } from '../../devices/repo.ts';
import { qrDataUrl } from '../../pwa/qr.ts';
import { bad, capJson, input, onlyKeys, optBool, optObj, optText, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import type { RuntimeServices } from '../../contracts.ts';

/** A screenshot answer stays below this (JPEG of a phone screen: a few hundred KB). */
const REPLY_MAX = 6_000_000;

/**
 * The phone app itself: a device scope on a secure transport (the app's loopback tunnel through the meeting server)
 * whose row is a paired phone with its own key (rendezvous pairing). A QR-paired browser, or anything on plain LAN
 * http, never becomes a phone here – phone.type sends resolved secrets to the attached phone.
 */
function deviceOf(ctx: HandlerContext): string {
  const refuse = () => { throw new WorkforceError('forbidden', 'Only the phone app itself attaches for phone use.'); };
  if (ctx.scope.kind !== 'device' || ctx.scope.secure !== true) return refuse();
  const record = new DevicesRepo(ctx.services.db).get(ctx.scope.deviceId);
  if (!record || record.revokedAt || record.kind !== 'phone' || !record.publicKey) return refuse();
  return ctx.scope.deviceId;
}

/** This PC and my other PCs (no employer's or employee's PC) with the key the phone pins. */
export function myPcs(s: Pick<RuntimeServices, 'db'>): PhonePc[] {
  const own = (record: DeviceRecord) => record.kind === 'pc' && !record.revokedAt && record.status !== 'revoked' && !record.personId && record.joinedAs !== 'employee' && Boolean(record.publicKey);
  return new DevicesRepo(s.db).list({ kinds: ['pc'] }).filter(own)
    .sort((a, b) => Number(b.self) - Number(a.self))
    .slice(0, 16)
    .map((record) => ({ deviceId: record.id, name: record.name, fingerprint: record.fingerprint, publicKey: record.publicKey! }));
}

export function register(table: HandlerTable): void {
  table.add('phoneUse.attach', (params, ctx) => {
    const deviceId = deviceOf(ctx);
    const o = input(params);
    onlyKeys(o, ['model', 'screen', 'ready']);
    const screen = optObj(o, 'screen');
    const size = (key: string) => {
      const value = screen?.[key];
      return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 20_000 ? value : bad(`screen.${key}`, 'pixels');
    };
    const model = optText(o, 'model', { max: 60 });
    const ready = optBool(o, 'ready');
    const bus = ctx.services.bus;
    bus.emit('phoneUse.attached', { deviceId, on: true, ...(model ? { model } : {}), ...(screen ? { screen: { width: size('width'), height: size('height') } } : {}), ...(ready === undefined ? {} : { ready }) });
    ctx.signal.addEventListener('abort', () => bus.emit('phoneUse.attached', { deviceId, on: false }), { once: true });
    return { pcs: myPcs(ctx.services) };
  }, 'any');

  table.add('phoneUse.reply', (params, ctx) => {
    const deviceId = deviceOf(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'result', 'error']);
    const id = text(o, 'id', { max: 40 });
    const error = optObj(o, 'error');
    capJson('result', o.result, REPLY_MAX);
    ctx.services.bus.emit('phoneUse.reply', {
      deviceId, id,
      ...(error ? { error: { code: text(error, 'code', { max: 40 }), message: optText(error, 'message', { max: 300 }) ?? '' } } : { result: o.result }),
    });
    return { ok: true as const };
  }, 'any');

  table.add('phone.pcs', (params, ctx) => {
    deviceOf(ctx);
    if (params !== undefined && params !== null) onlyKeys(input(params), []);
    return { pcs: myPcs(ctx.services) };
  }, 'any');

  // "Forget this phone" in the phone app: its own row ends like Remove on the PC (token, push subscriptions, the pin;
  // the roster carries the revoked row to my other PCs). The answer still reaches the phone: the pin drains for a moment.
  table.add('phone.forget', async (params, ctx) => {
    const deviceId = deviceOf(ctx);
    if (params !== undefined && params !== null) onlyKeys(input(params), []);
    await ctx.extras.pwa.revoke(deviceId);
    return { ok: true as const };
  }, 'any');

  table.add('phone.pairLink', async (_params, ctx) => {
    const remoteId = ctx.extras.remote?.state().self.remoteId;
    if (!remoteId) throw new WorkforceError('unavailable', 'Connecting devices is not available on this PC.');
    const url = phonePairLink(remoteId);
    return { remoteId, url, qrDataUrl: await qrDataUrl(url) };
  });
}
