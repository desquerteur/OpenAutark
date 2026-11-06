// Page hosts: the normal form of a host (the resource of browser calls, site notes and knowledge scopes).
// Owns: host normalisation. Never: fetches anything or trusts page text – only the URL host counts.
//
// Decisions:
// * Normal host = lowercase, IDN as punycode (WHATWG URL), without a trailing dot and without a
//   leading "www." / "www2." label. "shop.example" and "www.shop.example" are one site.
// * A resource names a host when it is an http(s) URL or a bare host name with at least one dot
//   (a linked PC's name such as "Tower" or a recipient "bob@example.com" is not a host).

const HOST_ONLY = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** The normal form of a host name (see Decisions), or undefined when it is not one. */
export function normalHost(host: string | undefined): string | undefined {
  if (typeof host !== 'string') return undefined;
  const raw = host.trim();
  if (!raw || /[/\\@?#\s]/.test(raw)) return undefined;
  let value: string;
  try { value = new URL(`http://${raw}`).hostname; } catch { return undefined; }
  value = value.replace(/\.$/, '').replace(/^www\d*\./, '');
  return value || undefined;
}

/** The normal host of an http(s) URL or of a bare host name; undefined for anything else. */
export function resourceHost(resource: string | undefined): string | undefined {
  if (typeof resource !== 'string') return undefined;
  const value = resource.trim();
  if (/^https?:\/\//i.test(value)) {
    try { return normalHost(new URL(value).hostname); } catch { return undefined; }
  }
  return HOST_ONLY.test(value) ? normalHost(value) : undefined;
}
