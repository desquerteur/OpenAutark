// RPC handler: `rpc.methods` – what can be called, for programs and AIs: every name of the finished handler table with who may
// call it, its params and comment as the contract writes them (method-docs.generated.ts, written by each build, because a
// packaged app has no source). Like session.ts it reads the table at call time.
// Owns: that projection. Never: grants anything (the server checks every call) or lists a method the table does not have.

import '../../../shared/api/methods-rpc.ts';
import type { RpcMethodInfo, RpcMethodList } from '../../../shared/api/methods-rpc.ts';
import { METHOD_DOCS, TYPE_DOCS } from '../method-docs.generated.ts';
import { input, onlyKeys, optText } from '../params.ts';
import type { HandlerTable, ScopeRule } from '../table.ts';

const namesIn = (text: string): string[] => [...new Set(text.match(/\b[A-Z]\w*\b/g) ?? [])].filter((name) => Object.hasOwn(TYPE_DOCS, name));

function whoOf(rule: ScopeRule): Pick<RpcMethodInfo, 'who' | 'connector' | 'person'> {
  if (typeof rule === 'string') return { who: rule };
  if ('person' in rule) return { ...whoOf(rule.base), person: true };
  return { who: rule.capability, ...(rule.external ? { connector: true as const } : {}) };
}

/** The named types `methods` use, the types those use included. */
function typesOf(methods: readonly RpcMethodInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  const queue = methods.flatMap((method) => namesIn(method.params));
  while (queue.length) {
    const name = queue.pop()!;
    if (out[name]) continue;
    out[name] = TYPE_DOCS[name];
    queue.push(...namesIn(out[name]));
  }
  return out;
}

export function methodList(table: HandlerTable, match?: string): RpcMethodList {
  const all = table.methods().flatMap((name): RpcMethodInfo[] => {
    const entry = table.get(name);
    if (!entry) return [];
    const doc = METHOD_DOCS[name];
    return [{ name, params: doc?.params ?? 'unknown', ...(doc?.note ? { note: doc.note } : {}), ...whoOf(entry.scope) }];
  });
  const wanted = match?.trim().toLowerCase();
  if (!wanted) return { methods: all };
  const methods = all.filter((method) => method.name.toLowerCase().includes(wanted) || method.note?.toLowerCase().includes(wanted));
  return { methods, types: typesOf(methods) };
}

export function register(table: HandlerTable): void {
  table.add('rpc.methods', (params) => {
    const o = input(params);
    onlyKeys(o, ['match']);
    return methodList(table, optText(o, 'match', { max: 100 }));
  }, 'any');
}
