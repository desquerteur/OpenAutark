// Pure model of the pane's Video tab: a chat's videos (media library rows) grouped into renders and
// their versions – one file-name stem (intro_v1, intro_v2, intro-final, "intro (2)") is one render,
// versions oldest (v1) to newest – and which version is shown: the picked one while it exists, else
// the newest render's newest version.
// Owns: these rules. Never: the DOM or RPC (tested in test/unit/ui/workspace-tabs.test.ts).

import type { MediaInfo } from '../../shared/model/media.ts';

export interface VideoRender { key: string; title: string; versions: MediaInfo[] }

const WORD = '(?:v|ver|version|rev|take|draft|render|cut)';
const VERSION_MARKS = [
  new RegExp(`(?:[\\s._-]+|(?<![a-z]))${WORD}?[\\s._-]*(?<!\\d)\\d{1,3}$`), // _v2, -take 3, " 02"
  /\s*\(\d+\)$/, // "(2)"
  /[\s._-]+(?:final|draft|preview|proxy|lowres|hq|new|old)$/,
  /[\s._-]+\d{8}(?:[\s._-]?\d{4,6})?$/, // -20261021, -20261021-1530
];

/** The versions of one render share this key: the file name without its folder, extension and version marks. */
export function renderKey(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '');
  let stem = base;
  for (let changed = true; changed && stem;) {
    changed = false;
    for (const mark of VERSION_MARKS) {
      const next = stem.replace(mark, '');
      if (next !== stem) { stem = next; changed = true; }
    }
  }
  return stem || base;
}

/** The chat's renders, the one with the newest version first. */
export function videoRenders(rows: readonly MediaInfo[]): VideoRender[] {
  const groups = new Map<string, MediaInfo[]>();
  for (const row of rows) {
    if (row.kind !== 'video') continue;
    const key = renderKey(row.name);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, versions]): VideoRender => {
    versions.sort((a, b) => a.createdAt - b.createdAt);
    return { key, title: versions[versions.length - 1]!.name, versions };
  }).sort((a, b) => b.versions[b.versions.length - 1]!.createdAt - a.versions[a.versions.length - 1]!.createdAt);
}

/** The version shown: `picked` while it exists, else the newest render's newest version. */
export function shownVideo(renders: readonly VideoRender[], picked: string | null): { render: VideoRender; index: number } | undefined {
  for (const render of renders) {
    const index = render.versions.findIndex((version) => version.fileId === picked);
    if (index >= 0) return { render, index };
  }
  const newest = renders[0];
  return newest ? { render: newest, index: newest.versions.length - 1 } : undefined;
}

/** After picking `fileId`: kept as picked, or null (follow the newest again) when it is the newest anyway. */
export function pickAfter(renders: readonly VideoRender[], fileId: string): string | null {
  const newest = renders[0]?.versions.at(-1);
  return newest?.fileId === fileId ? null : fileId;
}
