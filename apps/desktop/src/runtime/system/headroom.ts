// B-078 T10: how many heavy turns (CLI engine processes) the PC carries at once, from its real memory headroom.
// Free physical RAM alone was the old signal (clamp((free − 1.5 GB) / 250 MB, 1, cores − 2)) and it held the 8 GB
// reference PC at one turn all day: Windows keeps physical RAM busy on purpose and trims and compresses idle working
// sets, so ~0.9 GB "available" sat beside ~6.9 GB of commit headroom (measured 06.11.2026: 7.9 GB RAM, commit limit
// 23.3 GB, 7.0 GB commit free, memory compression on). An engine CLI mostly waits on the network: a claude CLI holds
// ~180 MB private, a codex turn ~50 MB (the app-server ~80 MB once per account), and their idle pages compress well.
// The rule (pure, heavySlotsFor):
//   headroom = available physical + PAGED_SHARE × (commit free − available physical)   [Windows, commit known]
//            = available physical                                                     [elsewhere: Linux MemAvailable;
//                                                                                       macOS free + purgeable]
//   slots    = floor((headroom − RESERVE_MB) / TURN_MB), at least MIN_SLOTS, at most min(cores − 2, total / TOTAL_MB_PER_SLOT)
//   one slot only when the number is the OS's own allocatable estimate (Windows commit, Linux MemAvailable) and it is
//   below RESERVE_MB + TURN_MB – a genuinely starved PC still holds back (the supervisor adds its one borrowed slot).
// Numbers: TURN_MB 300 = a claude CLI (~180 MB) plus the tools it starts; RESERVE_MB 1 GB stays for Windows and the
// person's own apps; PAGED_SHARE ½ counts commit beyond physical RAM at half (compressed or paged idle pages cost
// little, but not nothing); TOTAL_MB_PER_SLOT 1.5 GB keeps an 8 GB PC at five, a 16 GB one at ten. On the reference PC
// this gives 5 (was 1). Without Electron's memory info (tests, another host) Windows' and macOS' physical number is not
// trusted for "starved" and the floor of two holds.
// Owns: reading the memory snapshot (Electron's process.getSystemMemoryInfo when the host process has it – feature-
// detected, no electron import – else node:os) and the slot formula. Never: counts or holds slots (supervisor.ts),
// polls (it is read when a turn asks for a slot).

import * as nodeOs from 'node:os';

export const RESERVE_MB = 1024;
export const TURN_MB = 300;
export const PAGED_SHARE = 0.5;
export const TOTAL_MB_PER_SLOT = 1536;
export const MIN_SLOTS = 2;

const MB = 1024 * 1024;

export interface MemorySnapshot {
  /** Physical memory usable without paging, MB (Windows: available incl. standby; Linux: MemAvailable; macOS: free + purgeable). */
  availableMb: number;
  totalMb?: number;
  /** Windows: commit still available (commit limit − commit charge), MB. */
  commitFreeMb?: number;
  /** The number is the OS's own allocatable estimate (Windows commit, Linux MemAvailable): "starved" can be trusted. */
  exact: boolean;
}

/** Heavy slots for this memory state and core count (see the header). */
export function heavySlotsFor(memory: MemorySnapshot, cores: number): number {
  const available = Math.max(0, memory.availableMb);
  const paged = memory.commitFreeMb === undefined ? 0 : Math.max(0, memory.commitFreeMb - available);
  const headroom = available + PAGED_SHARE * paged;
  if (memory.exact && headroom < RESERVE_MB + TURN_MB) return 1;
  let upper = Math.max(MIN_SLOTS, cores - 2);
  if (memory.totalMb && memory.totalMb > 0) upper = Math.min(upper, Math.max(MIN_SLOTS, Math.floor(memory.totalMb / TOTAL_MB_PER_SLOT)));
  const byRam = Math.floor((headroom - RESERVE_MB) / TURN_MB);
  return Math.min(Math.max(byRam, MIN_SLOTS), upper);
}

/** Electron's SystemMemoryInfo (KB); every field optional – each platform fills some. */
interface ElectronMemory { total?: number; free?: number; available?: number; purgeable?: number; swapFree?: number }

const kbToMb = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1024 : undefined;

/** The PC's memory now. `probe` defaults to process.getSystemMemoryInfo when the host process has it. */
export function readMemory(
  platform: NodeJS.Platform = process.platform,
  probe: (() => ElectronMemory) | undefined = electronProbe(),
  os: Pick<typeof nodeOs, 'freemem' | 'totalmem'> = nodeOs,
): MemorySnapshot {
  const osFree = os.freemem() / MB;
  const osTotal = os.totalmem() / MB;
  let info: ElectronMemory | undefined;
  try { info = probe?.(); } catch { info = undefined; }
  if (!info) return { availableMb: osFree, totalMb: osTotal, exact: platform === 'linux' };
  const totalMb = kbToMb(info.total) ?? osTotal;
  if (platform === 'win32') {
    const commitFreeMb = kbToMb(info.swapFree);
    return { availableMb: kbToMb(info.free) ?? osFree, totalMb, ...(commitFreeMb !== undefined ? { commitFreeMb } : {}), exact: commitFreeMb !== undefined };
  }
  if (platform === 'linux') return { availableMb: kbToMb(info.available) ?? osFree, totalMb, exact: true };
  return { availableMb: (kbToMb(info.free) ?? osFree) + (kbToMb(info.purgeable) ?? 0), totalMb, exact: false };
}

function electronProbe(): (() => ElectronMemory) | undefined {
  const get = (process as unknown as { getSystemMemoryInfo?: () => ElectronMemory }).getSystemMemoryInfo;
  return typeof get === 'function' ? () => get.call(process) : undefined;
}
