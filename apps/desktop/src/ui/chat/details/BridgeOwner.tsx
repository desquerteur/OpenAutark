// Chat details › Telegram › one bridge: "Link my Telegram" (C9) – the owner uses the bridged
// Telegram chat as their own device. Shows a one-time code to send as /link in that chat (with
// its expiry: one re-render then, no polling), the linked account and Unlink. The code is cleared
// when bridge.upserted reports the link, at its expiry, or on Cancel (which withdraws it in the
// runtime through bridges.unlinkOwner while nothing is linked).
// Owns: that part of the row. Never: keeps a code after it was used or expired, or offers a link
// for a channel (its posts have no sender).

import { useEffect, useState } from 'preact/hooks';
import type { Bridge, OwnerLinkCode } from '../../../shared/model/bridges.ts';
import { time } from '../../lib/format.ts';
import { rpc } from '../../lib/rpc.ts';
import { pushToast, toastError } from '../../lib/toasts.ts';
import { Button, confirm } from '../../lib/ui.tsx';
import { canLinkOwner, codeExpired, codeHint, codeUsed, linkCommandText, ownerText } from './bridge-owner-model.ts';

export function BridgeOwner(props: { bridge: Bridge; onChange: (bridge: Bridge) => void }) {
  const { bridge } = props;
  const [code, setCode] = useState<OwnerLinkCode | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { // the link arrived: the code is used up
    if (code && codeUsed(code, bridge)) { setCode(null); pushToast({ title: 'Telegram linked' }); }
  }, [code, bridge]);

  useEffect(() => { // one re-render at the expiry
    if (!code) return undefined;
    setExpired(codeExpired(code, Date.now()));
    const timer = setTimeout(() => setExpired(true), Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);

  const run = async (job: () => Promise<void>, failure: string) => {
    setBusy(true);
    try { await job(); } catch (error) { toastError(error, failure); } finally { setBusy(false); }
  };
  const start = () => run(async () => setCode(await rpc.call('bridges.linkOwner', { id: bridge.id })), 'Could not make a link code');
  const cancel = () => run(async () => {
    setCode(null);
    if (!bridge.owner) props.onChange(await rpc.call('bridges.unlinkOwner', { id: bridge.id })); // withdraws the unused code
  }, 'Could not cancel the code');
  const unlink = async () => {
    if (!await confirm({ title: 'Unlink your Telegram account?', body: 'Messages from it will show as an external contact again.', confirmLabel: 'Unlink', danger: true })) return;
    await run(async () => props.onChange(await rpc.call('bridges.unlinkOwner', { id: bridge.id })), 'Could not unlink');
  };
  const copy = (shown: OwnerLinkCode) => {
    navigator.clipboard.writeText(linkCommandText(shown)).then(() => pushToast({ title: 'Copied' }), (error: unknown) => toastError(error, 'Could not copy'));
  };

  if (bridge.owner) {
    return (
      <div class="bridge-field bridge-owner">
        <small>{ownerText(bridge)}</small>
        <div class="bridge-actions"><Button variant="ghost" busy={busy} onClick={() => void unlink()}>Unlink</Button></div>
      </div>
    );
  }
  if (code && !expired) {
    return (
      <div class="bridge-field bridge-owner">
        <strong class="pair-code">{code.code}</strong>
        <small>{codeHint(code, time(code.expiresAt))}</small>
        <div class="bridge-actions">
          <Button variant="ghost" onClick={() => copy(code)}>Copy</Button>
          <Button variant="ghost" busy={busy} onClick={() => void cancel()}>Cancel</Button>
        </div>
      </div>
    );
  }
  if (!canLinkOwner(bridge)) return null;
  return (
    <div class="bridge-field bridge-owner">
      <small>{code ? 'The code expired.' : 'Use this Telegram chat as your own device: your messages there post as you.'}</small>
      <div class="bridge-actions">
        <Button variant="ghost" busy={busy} onClick={() => void start()}>{code ? 'New code' : 'Link my Telegram'}</Button>
      </div>
    </div>
  );
}
