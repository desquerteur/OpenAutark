// Types of scripts/rpc-docs.mjs for the tests that import it.
export interface MethodDoc { params: string; note?: string }
export interface RpcDocs { methods: Record<string, MethodDoc>; types: Record<string, string> }
export function blankComments(text: string): string;
export function methodsIn(source: string): Record<string, MethodDoc>;
export function typesIn(source: string): Record<string, string>;
export function namesIn(text: string, types: Record<string, string>): string[];
export function readDocs(root: string): Promise<RpcDocs>;
export function docsModule(docs: RpcDocs): string;
export function writeDocs(root: string): Promise<boolean>;
