// The PC UI inside the iPhone web app (B-078 follow-up): the website's shell (ui/hosted/shell.ts, served at the
// website's appUrl, an origin of its own) loads this PC's own UI into its document and reaches the PC through the meeting server. What the UI does
// differently there goes through one explicit contract, window.autarkHosted v1: its RPC socket (a WebSocket-like on a
// tunnel stream – a service worker cannot carry WebSockets), the base every relative PC path lives under (the shell's
// service worker relays it to the PC), the frame URL of an ```app block, and "Forget this phone".
// Owns: that contract's shape and the accessors the UI uses. Never: talks to the PC itself.

/** D6, said honestly wherever the iPhone app shows what it can do. */
export const IOS_PHONE_USE = 'On an iPhone, agents can’t use your other apps – iOS lets no app do that. Chats, tasks, notifications and the microphone work here.';

/** What lib/rpc.ts needs of a socket (the browser's WebSocket fits it too). */
export interface HostedSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface AutarkHosted {
  v: 1;
  /** The shell's directory, e.g. '/app/': the PC's '/x' is '<base>x' here. */
  base: string;
  /** A socket to the PC's own path (only '/ws' today). */
  socket(path: string): HostedSocket;
  /** The address of a PC path the service worker relays (a sandbox frame '/sandbox/app?…'). */
  frameUrl(path: string): string;
  /** Asks, then unsubscribes push, clears this phone's pairing, token and caches and shows the connect screen. */
  forget(): Promise<void>;
}

declare global {
  interface Window { autarkHosted?: AutarkHosted }
}

/** The shell's contract when this UI runs inside the iPhone web app. */
export function hostedShell(): AutarkHosted | undefined {
  const value = (globalThis as { autarkHosted?: AutarkHosted }).autarkHosted;
  return value && value.v === 1 ? value : undefined;
}

/** A PC path as this page addresses it: under the shell's base when hosted, unchanged otherwise. */
export function hostedPath(path: string): string {
  const hosted = hostedShell();
  return hosted ? `${hosted.base}${path.replace(/^\//, '')}` : path;
}
