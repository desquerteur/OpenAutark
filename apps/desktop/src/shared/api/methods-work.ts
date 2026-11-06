// RPC contract part: the person's emergency stop of all agent work on one PC (21.10. 17:09 – the chat
// has no everyday Stop; runtime agents/work-stop.ts, handlers rpc/handlers/work.ts). Merged into
// Methods by module augmentation (methods.ts is at its size limit), like the other contract parts.
// Owns: these three method shapes. Never: behaviour.

import type { WorkStopState } from '../model/work-stop.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Whether the person stopped all agent work on this PC (any paired device sees it). */
    'work.state': { params: void; result: WorkStopState };
    /** The person's emergency stop: every running turn ends now (tasks pause), no new turn until work.resume. */
    'work.stop': { params: void; result: WorkStopState };
    /** The person's Resume after work.stop: what waited runs; tasks the stop paused stay paused. */
    'work.resume': { params: void; result: WorkStopState };
  }
}
