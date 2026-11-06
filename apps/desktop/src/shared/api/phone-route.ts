// Routes a phone link may carry (DEV5B): `pwa.link` appends one (e.g. #/home or
// #/chat/<id>) and the PWA opens it after pairing. Only plain hash routes of the app pass – no
// other scheme, host, query or fragment parameter can ride along.
// Owns: the route check shared by the runtime (pwa.link's param) and the PWA (the `to=` value).
// Never: parses routes (ui/lib/router.ts does).

const ROUTE = /^#\/[A-Za-z0-9._~%/-]{0,200}$/;

/** True for an app hash route such as `#/home` or `#/chat/ch_123`. */
export function isPhoneRoute(value: unknown): value is string {
  return typeof value === 'string' && ROUTE.test(value);
}
