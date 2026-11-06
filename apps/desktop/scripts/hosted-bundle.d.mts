// Types of scripts/hosted-bundle.mjs (the iPhone web app's two bundles for the website).

export const HOSTED_ENTRIES: ReadonlyArray<{ entry: string; file: string; format: 'esm' | 'iife' }>;
export const BANNER: string;
export function sourceHash(root: string, inputs: Iterable<string>): Promise<string>;
export function bundleHosted(root: string, target: { entry: string; format: 'esm' | 'iife' }, options?: { minify?: boolean }): Promise<{ code: string; hash: string }>;
export function writeHosted(root: string, options?: { out?: string; minify?: boolean }): Promise<Array<{ file: string; hash: string }>>;
