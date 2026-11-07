// An account's picture (AF-009): the provider's logo, else the account's own avatar, else its initials – lib/account-face.ts
// decides. An avatar that does not load turns into the initials, so the slot is never empty. Decorative (aria-hidden):
// the name beside it, or the badge's label, says whose it is.
// Owns: drawing that picture. Never: chooses it, or loads anything from the network.

import { useState } from 'preact/hooks';
import { accountFace, type AccountFaceInput } from './account-face.ts';
import { ProviderLogo } from './provider-logos.tsx';

export function AccountAvatar(props: AccountFaceInput & { size?: number; class?: string }) {
  const [failed, setFailed] = useState<string | undefined>(undefined); // the avatar URL that did not load
  const face = accountFace(props, failed !== undefined && failed === props.avatar?.trim());
  const size = props.size ?? 20;
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(9, Math.round(size * 0.45))}px` };
  const className = `account-face${props.class ? ` ${props.class}` : ''}`;
  if (face.kind === 'logo') {
    return <span class={className} data-face="logo" data-logo={face.logo} style={style} aria-hidden="true"><ProviderLogo logo={face.logo} /></span>;
  }
  if (face.kind === 'avatar') {
    return <span class={className} data-face="avatar" style={style} aria-hidden="true"><img src={face.src} alt="" draggable={false} onError={() => setFailed(face.src)} /></span>;
  }
  // the letters are drawn by the stylesheet (account-face.css ::before), so a row's text stays its name alone
  return <span class={className} data-face="initials" data-initials={face.text} data-color={face.color} style={style} aria-hidden="true" />;
}
