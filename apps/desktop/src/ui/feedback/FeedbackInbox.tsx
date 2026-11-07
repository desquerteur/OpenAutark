// Owns: the team's local feedback inbox: fetch on opening or Refresh, select text and screenshot, remove a report.
// Never: exposes keys, polls the mailbox or renders a report as HTML. The runtime permits inbox calls only to the owner.

import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { reportNumber, type FeedbackInboxItem } from '../../shared/model/feedback-delivery.ts'; // AF-003: the sender's "Report no."
import { useContextMenu } from '../lib/context-menu.tsx';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { errorText, rpc } from '../lib/rpc.ts';
import { can, session } from '../lib/session.ts';

const selectedReport = signal<string | undefined>(undefined); // preserve selection across desktop/phone shell mounts

/** A fixed action cell: the asynchronous status answer cannot move the feedback form. */
export function FeedbackInboxEntry(props: { shown: boolean; onOpen: () => void }) {
  const info = session.value;
  const allowed = can('feedback.inboxList');
  const [receiving, setReceiving] = useState(false);
  useEffect(() => {
    let live = true;
    if (!allowed) { setReceiving(false); return; }
    void rpc.call('feedback.status').then(
      (status) => { if (live) setReceiving(status.receiving); },
      () => { if (live) setReceiving(false); },
    );
    return () => { live = false; };
  }, [info, allowed, props.shown]);
  if (!allowed) return null;
  return <div class="feedback-inbox-entry">{receiving && <button type="button" class="button ghost small" onClick={props.onOpen}>Inbox</button>}</div>;
}

function ReportRow(props: { item: FeedbackInboxItem; selected: boolean; select: () => void; remove: () => void; busy: boolean }) {
  const { item } = props;
  const menu = useContextMenu(() => [{ items: [
    { label: 'Read', onSelect: props.select },
    { label: 'Delete', onSelect: props.remove, disabled: props.busy },
  ] }]);
  return (
    <button type="button" class={`feedback-inbox-row${props.selected ? ' selected' : ''}`} aria-pressed={props.selected}
      title={item.text} onClick={props.select} {...menu}>
      <span>{item.text}</span>
      <small>{new Date(item.createdAt).toLocaleString()}</small>
    </button>
  );
}

function ReportScreenshot(props: { item: FeedbackInboxItem }) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setImage(undefined);
    setError(undefined);
    if (props.item.screenshot) {
      void rpc.call('feedback.inboxScreenshot', { id: props.item.id }).then(
        (shot) => { if (live) setImage(`data:${shot.mime};base64,${shot.dataBase64}`); },
        (err) => { if (live) setError(errorText(err)); },
      );
    }
    return () => { live = false; };
  }, [props.item.id]);
  if (!props.item.screenshot) return null;
  return <div class="feedback-inbox-image">{image ? <img src={image} alt="Feedback screenshot" /> : <p>{error ?? 'Loading screenshot…'}</p>}</div>;
}

function InboxContent() {
  const [items, setItems] = useState<FeedbackInboxItem[]>([]);
  const selected = selectedReport.value;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  const current = items.find((item) => item.id === selected);

  const list = async () => {
    const reports = await rpc.call('feedback.inboxList');
    if (!live.current) return;
    setItems(reports);
    if (!reports.some((item) => item.id === selectedReport.peek())) selectedReport.value = reports[0]?.id;
  };
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setMessage('Fetching reports…');
    try {
      await list(); // local reports stay readable when the cloud is unavailable
      const result = await rpc.call('feedback.inboxFetch');
      await list();
      if (live.current) {
        const unreadable = result.unreadable ? ` ${result.unreadable} could not be opened.` : '';
        setMessage(`${result.total} reports.${unreadable}${result.more ? ' More are waiting; refresh again.' : ''}`);
      }
    } catch (err) {
      if (live.current) { setFailed(true); setMessage(errorText(err)); }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await rpc.call('feedback.inboxRemove', { id });
      await list();
      if (live.current) setMessage('Deleted from this PC.');
    } catch (err) {
      if (live.current) { setFailed(true); setMessage(errorText(err)); }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };
  useEffect(() => { void refresh(); return () => { live.current = false; }; }, []);

  return (
    <>
      <div class="feedback-inbox-content">
        <div class="feedback-inbox-list" aria-label="Feedback reports">
          {items.map((item) => <ReportRow key={item.id} item={item} selected={item.id === selected} busy={busy}
            select={() => { selectedReport.value = item.id; }} remove={() => void remove(item.id)} />)}
          {!items.length && <p class="feedback-inbox-empty">{busy ? 'Loading reports…' : 'No reports yet.'}</p>}
        </div>
        <section class="feedback-inbox-report" aria-label="Selected feedback">
          {current ? <>
            <p class="feedback-inbox-meta">No. {reportNumber(current.id)} · {new Date(current.createdAt).toLocaleString()} · {current.appVersion} · {current.os}{current.fromAgent ? ' · Agent report' : ''}</p>
            <p class="feedback-inbox-text">{current.text}</p>
            <ReportScreenshot key={current.id} item={current} />
            {current.diagnostics && <details><summary>Diagnostics</summary><pre>{current.diagnostics}</pre></details>}
          </> : <p class="feedback-inbox-empty">Select a report to read it.</p>}
        </section>
      </div>
      <DialogActions message={message} tone={failed ? 'error' : 'muted'}>
        <button type="button" class="button secondary" disabled={busy || !current} onClick={() => current && void remove(current.id)}>Delete</button>
        <button type="button" class="button primary feedback-inbox-refresh" disabled={busy} onClick={() => void refresh()}>Refresh</button>
      </DialogActions>
    </>
  );
}

export function FeedbackInbox(props: { open: boolean; onClose: () => void }) {
  return <Dialog open={props.open && can('feedback.inboxList')} onClose={props.onClose} title="Feedback inbox" class="feedback-inbox" width={920}>
    {props.open && <InboxContent />}
  </Dialog>;
}
