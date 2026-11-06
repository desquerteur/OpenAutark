// Computer use on a PC as the person sees it (MP7): which agent uses this PC's screen, mouse or
// keyboard right now, and whether the person stopped computer use here (the Stop latch; X02: which
// paired phone or browser pressed it).
// Owns: the state shape shared by the runtime, main and the UI. Never: behaviour (runtime/computer/activity.ts).

export interface ComputerActivityState {
  /** An agent used this PC's screen, mouse or keyboard within the last few seconds. */
  active: boolean;
  /** The person pressed Stop: agents' computer calls and every call from a linked PC are refused until Resume. */
  stopped: boolean;
  /** X02: the paired phone or browser that pressed Stop (undefined: this PC's window, shortcut or tray). */
  stoppedFrom?: string;
  /** The agent's name (an agent of a linked PC: the name that PC sent). */
  agent?: string;
  agentId?: string;
  /** The linked PC the agent works from (undefined: an agent of this PC). */
  fromDevice?: string;
  /** The current step, e.g. "Click at 120,300" (redacted). */
  summary?: string;
  /** Epoch ms of the last change. */
  at: number;
}

