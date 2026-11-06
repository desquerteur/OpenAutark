// Contract of the deterministic evidence checks of a task result (B-047 D11, runtime/subconscious/verify-evidence.ts):
// a file the result names exists and is not empty, a link it names answers – run before the verifier's predicate.
// Adds the optional `RuntimeServices.evidence` by module augmentation (contracts.ts is a size hotspot), so existing
// fakes keep compiling and tests never reach the network; without it the predicate alone judges, as before.
// Owns: interface shapes only. Never: behaviour.

import type { Evidence } from '../../shared/model/tasks.ts';

export interface EvidenceCheck {
  kind: 'file' | 'link';
  /** The path or URL checked (as the evidence named it). */
  target: string;
  /** true: holds; false: confidently does not (missing, empty, 404/410); undefined: could not tell (network, relative path). */
  ok: boolean | undefined;
  /** One line for the verifier's context or the reason ("file exists (12 KB): …", "link answers HTTP 404: …"). */
  line: string;
}

export interface EvidenceChecker {
  check(evidence: readonly Evidence[], context?: { workspace?: string; signal?: AbortSignal }): Promise<EvidenceCheck[]>;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** B-047 D11: deterministic evidence checks before the verifier (compose/services.ts); missing = the predicate only. */
    evidence?: EvidenceChecker;
  }
}
