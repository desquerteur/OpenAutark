// The hidden window of the main process, built with its Electron seams (desktop.ts wires it):
// keyframes of stored videos in an on-demand hidden window of its own session (MM4,
// media-analyzer.ts); one dispose at quit.
// Owns: constructing it and disposing it. Never: shows a window, uses the person's window or
// session, or decides what is analyzed (host services ask).

import { BrowserWindow, session } from 'electron';
import { MediaAnalyzer } from './media-analyzer.ts';
import { electronAnalyzerWindows } from './media-analyzer-window.ts';

export interface HiddenWindowsDeps {
  blobsDir: string;
}

export interface HiddenWindows {
  mediaAnalyzer: MediaAnalyzer;
  dispose(): void;
}

export function hiddenWindows(deps: HiddenWindowsDeps): HiddenWindows {
  const mediaAnalyzer = new MediaAnalyzer({
    open: electronAnalyzerWindows({ BrowserWindow, fromPartition: (partition, partitionOptions) => session.fromPartition(partition, partitionOptions) }),
    blobsDir: deps.blobsDir,
  });
  return { mediaAnalyzer, dispose: () => mediaAnalyzer.dispose() };
}
