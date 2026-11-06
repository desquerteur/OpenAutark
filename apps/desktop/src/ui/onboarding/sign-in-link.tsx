// The model setup's reserved "Open sign-in page" cell beside the plan buttons: while a CLI's sign-in printed its page
// (accounts.add signInUrl, accounts.login url) a link that opens it in the system browser, otherwise an inert
// placeholder of the same text and size, so a link that comes or goes never moves a neighbour.
// Owns: this cell's markup. Never: keeps, logs or shows the address itself.

import { openExternal } from '../lib/platform.ts';

export const OPEN_SIGN_IN = 'Open sign-in page';

export function SignInLink(props: { url?: string; class?: string }) {
  const extra = props.class ? ` ${props.class}` : '';
  const url = props.url;
  return url
    ? <button type="button" class={`first-run-link${extra}`} onClick={() => openExternal(url)}>{OPEN_SIGN_IN}</button>
    : <span class={`first-run-link inert${extra}`} aria-hidden="true">{OPEN_SIGN_IN}</span>;
}
