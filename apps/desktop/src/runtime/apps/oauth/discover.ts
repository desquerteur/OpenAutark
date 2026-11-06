// MCP authorization (B-052 track B): where an app signs in. Protected Resource Metadata (RFC 9728) from the 401's
// `resource_metadata` address, else the path-aware well-known address, else the root one; its `resource` must cover
// the app's address (same origin, path prefix). Then the authorization server's metadata (RFC 8414, OIDC discovery)
// at the path-aware well-known addresses, whose `issuer` must equal the expected issuer exactly, with PKCE S256
// required. Without any protected resource metadata, the app's origin is tried as the issuer (MCP 2025-03-26).
// No metadata anywhere: the app has no MCP sign-in (OAuthUnsupported → the token prompt). A candidate address that
// answers 4xx, 5xx, no JSON or no object is "not here" (the next one is tried; a 5xx is reported only when none
// answers). Every address the server names must pass endpointUrl with the app's `local` (an app not on this PC never
// leads to this PC or a private address). Also: the scope choice and the token endpoint's client authentication methods.
// Owns: discovery, its checks and scope selection. Never: trusts a server's text beyond these fields, or follows an
// address that is not HTTPS (plain HTTP only on this PC).

import { WorkforceError } from '../../../shared/errors.ts';
import { OAuthUnsupported } from '../types.ts';
import { callJson, endpointUrl, isLocalUrl, OAuthHttpError, record, strings, UnreadableAnswer, type FetchLike } from './http.ts';

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  grantTypesSupported?: string[];
  /** token_endpoint_auth_methods_supported, when listed (register.ts picks the registration's method from it). */
  authMethodsSupported?: string[];
  /** RFC 9207: the server sends `iss` with every authorization answer (so a missing one is refused). */
  issParameter: boolean;
}

export interface Discovery {
  /** The RFC 8707 `resource` value for the authorization and token requests. */
  resource: string;
  server: AuthServer;
  /** The protected resource's scopes_supported, when it lists them. */
  scopesSupported?: string[];
}

const WHAT = "The app's sign-in server";
const unsafe = () => new WorkforceError('forbidden', "The app's sign-in server does not use a secure address.");

/** The app's address as an RFC 8707 resource: no fragment, no trailing slash. */
export function canonicalResource(resourceUrl: string): string {
  const url = endpointUrl(resourceUrl.split('#')[0]);
  if (!url) throw unsafe();
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}${url.search}`;
}

const slashed = (path: string) => (path.endsWith('/') ? path : `${path}/`);

/** RFC 9728 §3.3 as MCP clients apply it: the metadata's resource is the app's origin and a prefix of its path. */
export function resourceCovers(metadataResource: string, resourceUrl: string): boolean {
  const meta = endpointUrl(metadataResource);
  const app = endpointUrl(resourceUrl);
  if (!meta || !app || meta.origin !== app.origin) return false;
  return slashed(app.pathname).startsWith(slashed(meta.pathname));
}

/** The app is on this PC (only then may its sign-in addresses be). */
export function appIsLocal(resourceUrl: string): boolean {
  const url = endpointUrl(resourceUrl);
  return url !== undefined && isLocalUrl(url);
}

/** The well-known addresses of the protected resource metadata (path-aware first). */
export function resourceMetadataCandidates(resourceUrl: string, header?: string, local = appIsLocal(resourceUrl)): string[] {
  if (header) {
    const url = endpointUrl(header, local);
    if (!url) throw unsafe();
    return [url.href];
  }
  const app = endpointUrl(resourceUrl);
  if (!app) throw unsafe();
  const path = app.pathname.replace(/\/+$/, '');
  const root = `${app.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/** The metadata addresses of an issuer (RFC 8414 §3.1 and OIDC discovery, path-aware). */
export function serverMetadataCandidates(issuer: string, local = true): string[] {
  const url = endpointUrl(issuer, local);
  if (!url) throw unsafe();
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** The first candidate that answers with a JSON object; 4xx, 5xx, no JSON or no object mean "not here". */
async function firstDocument(fetchFn: FetchLike, candidates: string[], local: boolean): Promise<Record<string, unknown> | undefined> {
  let failed: OAuthHttpError | undefined;
  for (const candidate of candidates) {
    try {
      const document = record(await callJson<unknown>(fetchFn, candidate, { method: 'GET', local }, WHAT));
      if (document) return document;
    } catch (error) {
      if (error instanceof OAuthHttpError) { if (error.status >= 500) failed ??= error; continue; }
      if (error instanceof UnreadableAnswer) continue; // a catch-all page
      throw error;
    }
  }
  if (failed) throw new WorkforceError('unavailable', `${WHAT} is not available right now (HTTP ${failed.status}).`);
  return undefined;
}

/** The checked metadata of `issuer`, or undefined when it publishes none. */
export async function serverMetadata(fetchFn: FetchLike, issuer: string, local = true): Promise<AuthServer | undefined> {
  const document = await firstDocument(fetchFn, serverMetadataCandidates(issuer, local), local);
  if (!document) return undefined;
  if (document.issuer !== issuer) throw new WorkforceError('forbidden', "The app's sign-in server did not identify itself correctly.");
  const authorization = endpointUrl(document.authorization_endpoint, local);
  const token = endpointUrl(document.token_endpoint, local);
  if (!authorization || !token) throw unsafe();
  if (!strings(document.code_challenge_methods_supported)?.includes('S256')) {
    throw new WorkforceError('forbidden', "The app's sign-in server does not support a secure sign-in (PKCE).");
  }
  const responseTypes = strings(document.response_types_supported);
  if (responseTypes && !responseTypes.includes('code')) throw new OAuthUnsupported();
  const grantTypes = strings(document.grant_types_supported);
  if (grantTypes && !grantTypes.includes('authorization_code')) throw new OAuthUnsupported();
  const registration = document.registration_endpoint === undefined ? undefined : endpointUrl(document.registration_endpoint, local);
  if (document.registration_endpoint !== undefined && !registration) throw unsafe();
  return {
    issuer,
    authorizationEndpoint: authorization.href,
    tokenEndpoint: token.href,
    ...(registration ? { registrationEndpoint: registration.href } : {}),
    ...(endpointUrl(document.revocation_endpoint, local) ? { revocationEndpoint: endpointUrl(document.revocation_endpoint, local)!.href } : {}),
    ...(strings(document.scopes_supported) ? { scopesSupported: strings(document.scopes_supported) } : {}),
    ...(grantTypes ? { grantTypesSupported: grantTypes } : {}),
    ...(strings(document.token_endpoint_auth_methods_supported) ? { authMethodsSupported: strings(document.token_endpoint_auth_methods_supported) } : {}),
    issParameter: document.authorization_response_iss_parameter_supported === true,
  };
}

/** Discovery for the app at `resourceUrl` that answered with a 401/403 (`resourceMetadata` from its header). */
export async function discover(fetchFn: FetchLike, resourceUrl: string, resourceMetadata?: string): Promise<Discovery> {
  const canonical = canonicalResource(resourceUrl);
  const local = appIsLocal(canonical);
  const metadata = await firstDocument(fetchFn, resourceMetadataCandidates(resourceUrl, resourceMetadata, local), local);
  let resource = canonical;
  let issuers = [new URL(canonical).origin];
  let scopesSupported: string[] | undefined;
  if (metadata) {
    if (metadata.resource !== undefined) {
      if (typeof metadata.resource !== 'string' || !resourceCovers(metadata.resource, canonical)) {
        throw new WorkforceError('forbidden', "The app's sign-in details belong to a different address.");
      }
      resource = metadata.resource;
    }
    const listed = (strings(metadata.authorization_servers) ?? []).filter((issuer) => endpointUrl(issuer, local)).slice(0, 3);
    if (listed.length) issuers = listed;
    scopesSupported = strings(metadata.scopes_supported);
  }
  for (const issuer of issuers) {
    const server = await serverMetadata(fetchFn, issuer, local);
    if (server) return { resource, server, ...(scopesSupported ? { scopesSupported } : {}) };
  }
  throw new OAuthUnsupported();
}

const words = (text: string | undefined) => (text ?? '').split(/\s+/).filter((word) => word && word.length <= 200);

/**
 * The scopes to ask for: the challenge's, else the resource's scopes_supported; united with `granted` (a 403
 * insufficient_scope step-up keeps what was granted); offline_access only when the server lists it and other scopes
 * are asked for (alone it could narrow a grant the server would otherwise give with its default scopes).
 */
export function chooseScopes(input: { challenge?: string; resourceScopes?: string[]; serverScopes?: string[]; granted?: string[] }): string[] {
  const asked = words(input.challenge);
  const scopes = new Set([...(asked.length ? asked : input.resourceScopes ?? []), ...(input.granted ?? [])]);
  if (scopes.size && input.serverScopes?.includes('offline_access')) scopes.add('offline_access');
  return [...scopes].slice(0, 100);
}
