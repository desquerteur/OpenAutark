// RPC contract part: references.remember – "Remember why…" on the person's own message (runtime/references/
// references.ts; handler rpc/handlers/references.ts). A reference is a knowledge item of scope 'reference'.
// Merged into Methods by module augmentation. Owns: this method shape. Never: behaviour.

import type { KnowledgeItem } from '../model/knowledge.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** The message as an example and/or the reason; repeating it on the same message replaces the earlier ones. */
    'references.remember': {
      params: { messageId: string; why?: string; whyKind?: 'reason' | 'goal' | 'exception' | 'style'; keepExample?: boolean; situation?: string; audience?: string };
      result: KnowledgeItem[];
    };
  }
}
