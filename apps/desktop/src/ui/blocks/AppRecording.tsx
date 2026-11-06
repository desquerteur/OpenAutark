// Owns: a mini-app's recording request, shown in the existing host recorder. Never: grants
// the opaque iframe device access, records on a bridge call, or keeps a pending call on unmount.

import { useEffect, useRef, useState } from 'preact/hooks';
import { APP_UPLOAD_LIMITS } from '../../shared/blocks/app-files.ts';
import { blockKey } from '../../shared/blocks/parse.ts';
import { Dialog } from '../lib/ui.tsx';
import { rpc } from '../lib/rpc.ts';
import { toolError, toolResult, type BridgeResult } from './app-host.ts';
import { appRecording, type AppRecordingOptions } from './app-recording.ts';
import { RecordWidget } from './ui/Record.tsx';

interface Request { options: AppRecordingOptions; resolve(result: BridgeResult): void }

export function useAppRecording(block: { messageId: string; index: number; todo: boolean; allow: string }) {
  const pending = useRef<Request | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = (result: BridgeResult) => {
    pending.current?.resolve(result);
    pending.current = null;
    setRequest(null);
  };
  useEffect(() => () => {
    pending.current?.resolve(toolError('Recording closed.'));
    pending.current = null;
  }, []);

  const record = (args: Record<string, unknown>) => appRecording(block, args, (options) => {
    if (pending.current) return Promise.resolve(toolError('A recording is already open.'));
    return new Promise<BridgeResult>((resolve) => {
      const next = { options, resolve };
      pending.current = next;
      setRequest(next);
    });
  });
  const submit = async (answer: unknown) => {
    if (!request || pending.current !== request) return false;
    const take = answer as { file: string };
    setBusy(true);
    try {
      const { file } = await rpc.call('blocks.file', { messageId: block.messageId, blockIndex: block.index, fileId: take.file });
      if (pending.current !== request) return false;
      finish(toolResult({ fileId: file.id, name: file.name, mime: file.mime, size: file.size }));
      return true;
    } finally { setBusy(false); }
  };
  const view = (
    <Dialog open={!!request} onClose={() => { if (!busy) finish(toolError('Recording cancelled.')); }} title="Record for mini-app" width={600}>
      {request && <div><RecordWidget block={{ type: 'record', ...request.options, maxBytes: APP_UPLOAD_LIMITS.fileBytes }}
        draftKey={`app-record:${blockKey(block.messageId, block.index)}`} submit={submit} busy={busy} /></div>}
    </Dialog>
  );
  return { record, view };
}
