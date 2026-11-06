// Settings › Feedback: the person's own reports ("Reports"), the reports agents filed ("From agents", unverified, with Dismiss),
// on the one PC that holds the team's key the "Inbox" (ui/feedback/FeedbackInbox.tsx: what people sent, fetched when it opens).
// B-078: no "Include recent warnings" switch – the redacted lines always go with Send. A report opens in full in Review, which also sends it;
// "New report" opens the feedback menu under the header cell, "Watch how it works" the tour. The group hint is always there, so
// the answer of feedback.status moves nothing.
// Owns: these lists and the review dialog. Never: sends without the person's click, or claims more than the mailbox confirmed.

import { useEffect, useState } from 'preact/hooks';
import type { FeedbackStatus } from '../../shared/model/feedback-delivery.ts';
import type { FeedbackReport } from '../../shared/model/system.ts';
import { FeedbackInbox } from '../feedback/FeedbackInbox.tsx';
import { openFeedback } from '../feedback/popover-state.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { plainPreview } from '../lib/format.ts';
import { bridge, openExternal } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { agentName } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { openTour } from '../tour/open.ts';
import { act, ActionButton, Group, Row, useAsync, useBusy } from './controls.tsx';
import { reportLine, reportsHint, sendable } from './feedback-text.ts';

/** Where the reports live: "this PC" in the desktop window, "your PC" on a phone. */
const pc = (): string => (bridge ? 'this PC' : 'your PC');

function ReportRow(props: { report: FeedbackReport; onReview: () => void; onDismiss?: () => void }) {
  const { report } = props;
  return (
    <Row label={plainPreview(report.text, 90)} hint={reportLine(report, agentName, undefined, pc())} reserve>
      {report.url && report.status === 'sent' && <button type="button" class="button ghost small" onClick={() => openExternal(report.url!)}>Open</button>}
      <button type="button" class="button ghost small" aria-haspopup="dialog" onClick={props.onReview}>Review</button>
      {props.onDismiss && report.status !== 'sent' && <button type="button" class="button ghost small" onClick={props.onDismiss}>Dismiss</button>}
    </Row>
  );
}

function ReviewDialog(props: { report: FeedbackReport | undefined; sending: boolean | undefined; onClose: () => void }) {
  const { report } = props;
  const [busy, run] = useBusy();
  const done = report?.status === 'sent';
  const canSend = report !== undefined && sendable(report, props.sending) && can('feedback.send');
  const message = done ? (report?.deliveryWarning ? `Sent to the team. ${report.deliveryWarning}` : 'Sent to the team.') : canSend ? `Encrypted on ${pc()} before it leaves. Only the Teydra team can read it.` : '';
  return (
    <Dialog open={report !== undefined} onClose={props.onClose} title="Report" width={520} class="anchored">
      {report && (
        <>
          <p class="dialog-text feedback-review-text">{report.text}</p>
          <DialogActions message={message} tone={done ? 'ok' : 'muted'}>
            <Button variant="secondary" onClick={props.onClose}>Close</Button>
            <Button variant="primary" busy={busy} disabled={!canSend} onClick={() => void run(() => rpc.call('feedback.send', { id: report.id }))}>Send</Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

export function FeedbackPage() {
  const list = useAsync(() => rpc.call('feedback.list'), []);
  const status = useAsync<FeedbackStatus>(() => (can('feedback.status') ? rpc.call('feedback.status') : Promise.resolve({ sending: false, receiving: false })), []);
  const [reviewing, setReviewing] = useState<string | undefined>();
  const [inbox, setInbox] = useState(false);
  useEffect(() => rpc.on('feedback.upserted', () => void list.reload()), [list.reload]);
  const sending = status.data?.sending ?? (status.error ? false : undefined);
  const visible = [...(list.data ?? [])].filter((report) => report.status !== 'dismissed').sort((a, b) => b.createdAt - a.createdAt);
  const mine = visible.filter((report) => report.author === 'human');
  const fromAgents = visible.filter((report) => report.author !== 'human');
  const agentsFiled = (list.data ?? []).some((report) => report.author !== 'human'); // dismissed ones too: the group keeps its place
  const dismiss = (id: string) => void act(async () => { await rpc.call('feedback.dismiss', { id }); await list.reload(); }, 'Could not dismiss');
  return (
    <>
      <Group title="Reports" id="settings-feedback" hint={reportsHint(sending, pc())} actions={(
        <>
          <button type="button" class="button ghost small" onClick={() => openTour()}>Watch how it works</button>
          {can('feedback.create') && <button type="button" class="button ghost small" onClick={() => openFeedback()}>New report</button>}
        </>
      )}>
        {list.error && <Row label="Unavailable" hint={list.error} reserve />}
        {list.data && !mine.length && <Row label="No reports yet" reserve />}
        {mine.map((report) => <ReportRow key={report.id} report={report} onReview={() => setReviewing(report.id)} />)}
      </Group>
      {agentsFiled && (
        <Group title="From agents" id="feedback-from-agents">
          {!fromAgents.length && <Row label="No reports from agents" reserve />}
          {fromAgents.map((report) => <ReportRow key={report.id} report={report} onReview={() => setReviewing(report.id)} onDismiss={() => dismiss(report.id)} />)}
        </Group>
      )}
      {status.data?.receiving === true && (
        <Group title="Inbox" id="feedback-inbox">
          <Row label="What people sent" hint="Opened on this PC with the team key; fetched when it opens" reserve>
            <span class="account-slot"><ActionButton label="Open" onClick={() => setInbox(true)} /></span>
          </Row>
        </Group>
      )}
      <ReviewDialog report={visible.find((report) => report.id === reviewing)} sending={sending} onClose={() => setReviewing(undefined)} />
      <FeedbackInbox open={inbox} onClose={() => setInbox(false)} />
    </>
  );
}
