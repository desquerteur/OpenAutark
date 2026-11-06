// Types of scripts/check-boundaries.mjs (the structure guards; trees map 'src/…' posix paths to text).

export type Tree = ReadonlyMap<string, string>;
export interface Findings { problems: string[]; warnings: string[] }

export const ENTRIES: readonly string[];
export const KNOWN_ORPHANS: Readonly<Record<string, string>>;
export function isModule(file: string): boolean;
export function importSpecs(file: string, text: string): string[];
export function resolveSpec(from: string, spec: string, files: Tree): string | undefined;
export function orphanModules(files: Tree, entries?: readonly string[]): string[];
export function unresolvedImports(files: Tree): Array<{ file: string; spec: string }>;
export function emptyStylesheets(files: Tree): string[];
export function leadingComment(text: string): string;
export function missingOwnsHeaders(files: Tree): string[];
export function layerProblems(files: Tree): Findings;
export function checkTree(files: Tree, options?: { entries?: readonly string[]; knownOrphans?: Readonly<Record<string, string>> }): Findings;
export function readTree(root: string): Promise<Map<string, string>>;
