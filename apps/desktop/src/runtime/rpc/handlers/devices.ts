// RPC handlers: linked devices (list, rename, remove), phone/browser access (pwa.*), the live screen
// preview and the person's computer-use Stop / Resume.
// Owns: param checks and scope rules. `pwa.exchange` is callable without a token (via `POST /rpc`);
// `pwa.pushSubscribe`, `pwa.pushConfig` and `pwa.pushUnsubscribe` are open to every authenticated
// device and bound to the caller's scope; computer.activity/stop/resume to every paired device
// ('todo'). Everything else is owner-only.
// Never: implements mesh/PWA behaviour.

import { WorkforceError } from '../../../shared/errors.ts';
import type { Settings } from '../../../shared/model/system.ts';
import { bad, id, input, onlyKeys, optBool, optId, optNum, optOneOf, optText, text } from '../params.ts';
import { computerActivityOf } from '../../computer/activity.ts';
import { callerDeviceName } from '../device-name.ts';
import { isPhoneRoute } from '../../../shared/api/phone-route.ts';
import type { HandlerTable } from '../table.ts';

const BINDS: readonly Settings['pwa']['bind'][] = ['localhost', 'lan', 'tailscale'];

/** Phones name themselves "iPhone · Safari" / "Android · Chrome" (ui/pwa/install.ts). */
function clientKind(name: string | undefined): 'phone' | 'browser' {
  return name && /^(iphone|android)\b/i.test(name) ? 'phone' : 'browser';
}

/** `{endpoint?}` of pwa.pushConfig / pwa.pushUnsubscribe: a browser's https push endpoint. */
function pushEndpoint(params: unknown): string | undefined {
  const o = input(params);
  onlyKeys(o, ['endpoint']);
  const endpoint = optText(o, 'endpoint', { max: 2000 });
  if (endpoint !== undefined && !/^https:\/\//.test(endpoint)) bad('endpoint', 'an https push endpoint');
  return endpoint;
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- linked devices
  table.add('devices.list', (_params, ctx) => ctx.services.devices.list());
  table.add('devices.rename', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'name']);
    return ctx.extras.mesh.rename(id(o), text(o, 'name', { max: 60 }));
  });
  table.add('devices.revoke', async (params, ctx) => {
    const deviceId = id(input(params));
    const device = ctx.services.devices.list().find((entry) => entry.id === deviceId);
    if (!device) throw new WorkforceError('not_found', 'Device not found.');
    // Phones/browsers hold PWA tokens and push subscriptions: those end too.
    if (device.kind === 'phone' || device.kind === 'browser') await ctx.extras.pwa.revoke(deviceId);
    else ctx.extras.mesh.revoke(deviceId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- phone / browser access
  table.add('pwa.state', (_params, ctx) => ctx.extras.pwa.state());
  table.add('pwa.enable', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['enabled', 'bind']);
    const enabled = optBool(o, 'enabled');
    if (enabled === undefined) bad('enabled', 'true or false');
    return ctx.extras.pwa.enable({ enabled, bind: optOneOf(o, 'bind', BINDS) });
  });
  table.add('pwa.link', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'route']);
    const route = optText(o, 'route', { max: 210 });
    if (route !== undefined && !isPhoneRoute(route)) bad('route', 'an app route such as #/home or #/chat/<id>');
    return ctx.extras.pwa.link({ name: optText(o, 'name', { max: 60 }), ...(route ? { route } : {}) });
  });
  table.add('pwa.revoke', async (params, ctx) => {
    await ctx.extras.pwa.revoke(id(input(params), 'deviceId'));
    return { ok: true };
  });
  table.add('pwa.pushSubscribe', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['subscription']);
    const subscription = o.subscription as { endpoint?: unknown } | null | undefined;
    if (!subscription || typeof subscription !== 'object' || typeof subscription.endpoint !== 'string' || !/^https:\/\//.test(subscription.endpoint)) {
      bad('subscription', 'a PushSubscription (JSON) with an https endpoint');
    }
    if (JSON.stringify(subscription).length > 4096) bad('subscription', 'at most 4 KB');
    ctx.extras.pwa.pushSubscribe(subscription, ctx.scope);
    return { ok: true };
  }, 'any');
  table.add('pwa.pushConfig', (params, ctx) => ctx.extras.pwa.pushConfig(ctx.scope, pushEndpoint(params)), 'any');
  table.add('pwa.pushUnsubscribe', (params, ctx) => ({ ok: true, removed: ctx.extras.pwa.pushUnsubscribe(ctx.scope, pushEndpoint(params)) }), 'any');
  table.add('pwa.exchange', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['secret', 'name']);
    const secret = text(o, 'secret', { max: 200 });
    const name = optText(o, 'name', { max: 60 });
    return ctx.extras.pwa.exchange(secret, { name, kind: clientKind(name) });
  }, 'any');

  // ---------------------------------------------------------------- computer use
  table.add('computer.preview', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['deviceId', 'display']);
    return ctx.extras.computer.preview({ deviceId: optId(o, 'deviceId'), display: optNum(o, 'display', { min: 0, max: 16 }) });
  });
  table.add('computer.activity', (_params, ctx) => computerActivityOf(ctx.services).current(), { capability: 'todo' });
  table.add('computer.stop', (_params, ctx) => computerActivityOf(ctx.services).stop(callerDeviceName(ctx)), { capability: 'todo' });
  table.add('computer.resume', (_params, ctx) => computerActivityOf(ctx.services).resume(), { capability: 'todo' });
}
