// Types of scripts/sw-precache.mjs (the PWA service worker's build-time precache list).

export interface PrecacheMetafile {
  outputs: Record<string, { imports?: ReadonlyArray<{ path: string; kind: string; external?: boolean }>; cssBundle?: string }>;
}

export function swPrecacheDefines(input: {
  metafile: PrecacheMetafile;
  outdir?: string;
  entry?: string;
  read?: (file: string) => Promise<Uint8Array | string>;
}): Promise<{ __SHELL_EXTRA__: string; __BUILD_ID__: string }>;
