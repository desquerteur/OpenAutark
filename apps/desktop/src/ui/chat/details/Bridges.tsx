// Chat details › Telegram: links this chat to a Telegram chat through a bot (bridges.*), lists
// the links with their status and disconnects them; each row offers "Link my Telegram" (C9,
// BridgeOwner.tsx). Kept fresh by bridge.upserted (topic 'chats').
// Owns: the rows and the connect form. Never: keeps the bot token after a successful connect
// (it goes straight to the runtime, which stores it in the secret vault) or shows vault ids.

import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from '../../../shared/model/bridges.ts';
import { errorText, rpc } from '../../lib/rpc.ts';
import { toastError } from '../../lib/toasts.ts';
import { Button, confirm, Icon, Spinner } from '../../lib/ui.tsx';
import { BridgeOwner } from './BridgeOwner.tsx';
import { applyBridge, connectProblem, statusText } from './bridges-model.ts';

function useBridges(conversationId: string) {
  const [list, setList] = useState<Bridge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setList(null);
    rpc.call('bridges.list', { conversationId })
      .then((items) => { if (alive) { setList(items); setError(null); } })
      .catch((err) => { if (alive) setError(errorText(err)); });
    const off = rpc.on('bridge.upserted', (bridge) => setList((current) => applyBridge(current ?? [], bridge, conversationId)));
    return () => { alive = false; off(); };
  }, [conversationId]);
  const apply = (bridge: Bridge) => setList((current) => applyBridge(current ?? [], bridge, conversationId));
  return { list, error, apply };
}

function BridgeRow(props: { bridge: Bridge; onChange: (bridge: Bridge) => void }) {
  const { bridge } = props;
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!await confirm({ title: 'Disconnect Telegram?', body: `Telegram chat ${bridge.externalChatId}`, confirmLabel: 'Disconnect', danger: true })) return;
    setBusy(true);
    try {
      await rpc.call('bridges.disconnect', { id: bridge.id });
      props.onChange({ ...bridge, status: 'stopped' });
    } catch (error) {
      toastError(error, 'Could not disconnect');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class={`bridge-row is-${bridge.status}`}>
      <Icon name="plugs" size={16} />
      <div class="bridge-text">
        <span class="bridge-title">Telegram {bridge.externalChatId}</span>
        <span class="bridge-status">{statusText(bridge)}</span>
        <BridgeOwner bridge={bridge} onChange={props.onChange} />
      </div>
      <Button variant="ghost" class="bridge-disconnect" busy={busy} onClick={() => void disconnect()}>Disconnect</Button>
    </li>
  );
}

function ConnectForm(props: { conversationId: string; onDone: (bridge: Bridge) => void; onCancel: () => void }) {
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    const issue = connectProblem(token, chatId);
    if (issue) { setProblem(issue); return; }
    setBusy(true);
    setProblem(null);
    try {
      const bridge = await rpc.call('bridges.connectTelegram', { conversationId: props.conversationId, botToken: token.trim(), externalChatId: chatId.trim() });
      setToken('');
      props.onDone(bridge);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="bridge-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label class="bridge-field">
        <span>Bot token</span>
        <input class="input" type="password" autocomplete="off" spellcheck={false} value={token} maxLength={200} autoFocus
          onInput={(event) => setToken((event.currentTarget as HTMLInputElement).value)} />
        <small>Create a bot with @BotFather and paste its token (for groups, also turn off its privacy with /setprivacy).</small>
      </label>
      <label class="bridge-field">
        <span>Chat id</span>
        <input class="input" type="text" autocomplete="off" spellcheck={false} value={chatId} maxLength={64} placeholder="Number or @channel"
          onInput={(event) => setChatId((event.currentTarget as HTMLInputElement).value)} />
        <small>Message @userinfobot in Telegram to see your chat id; group ids start with -100.</small>
      </label>
      {problem && <p class="bridge-problem" role="alert">{problem}</p>}
      <div class="bridge-actions">
        <Button variant="ghost" onClick={props.onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!token.trim() || !chatId.trim()}>Connect</Button>
      </div>
    </form>
  );
}

export function Bridges(props: { conversationId: string }) {
  const { list, error, apply } = useBridges(props.conversationId);
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [props.conversationId]);
  const shown = list ?? [];
  return (
    <section class="details-section" aria-label="Telegram">
      <h3 class="details-heading">Telegram</h3>
      {error && <p class="details-note">{error}</p>}
      {!error && list === null && <Spinner size={14} />}
      {shown.length > 0 && <ul class="bridge-list">{shown.map((bridge) => <BridgeRow key={bridge.id} bridge={bridge} onChange={apply} />)}</ul>}
      {!adding && (
        <button type="button" class="details-add" onClick={() => setAdding(true)}>
          <span class="details-add-icon"><Icon name="plugs" size={16} /></span>
          <span>Connect Telegram</span>
        </button>
      )}
      {adding && <ConnectForm conversationId={props.conversationId} onCancel={() => setAdding(false)} onDone={(bridge) => { apply(bridge); setAdding(false); }} />}
    </section>
  );
}
