// Fake adb for the phone tests (PH1): an AdbPhone over a fake AdbExec that records every
// argument array and answers from small handlers – no real adb ever runs.

import { AdbPhone, type ExecResult } from '../../../src/runtime/phone/adb.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';

export const DEVICES = [
  'List of devices attached',
  '192.168.1.20:37099      device product:oriole model:Pixel_6 device:oriole transport_id:3',
  'adb-R58N123-AbCdEf._adb-tls-connect._tcp device product:a52 model:SM_A525F transport_id:5',
  'R58N999 unauthorized usb:1-1 transport_id:4',
  '',
].join('\n');

export const MDNS = [
  'List of discovered mdns services',
  'adb-R58N123-AbCdEf\t_adb-tls-connect._tcp\t192.168.1.30:40111',
  'adb-R58N123-AbCdEf\t_adb-tls-pairing._tcp.\t192.168.1.30:37005',
  'adb-XYZ\t_adb-tls-connect._tcp\t192.168.1.20:37099',
  'adb-legacy\t_adb._tcp\t192.168.1.40:5555',
  'weird line',
  'adb-bad\t_adb-tls-connect._tcp\tnot-an-address',
  'adb-other\t_googlecast._tcp\t192.168.1.50:8009',
  'adb-R58N123-AbCdEf\t_adb-tls-connect._tcp\t192.168.1.30:40111',
].join('\n');

export type Answer = (args: string[]) => Partial<ExecResult> | undefined;

/** AdbPhone over a fake AdbExec: answers in order, then `adb devices` / empty success. */
export function fakeAdb(answers: Answer[] = []) {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
    calls.push(args);
    for (const answer of answers) {
      const result = answer(args);
      if (result) return { code: 0, stdout: new Uint8Array(), stderr: '', ...result };
    }
    if (args[0] === 'devices') return { code: 0, stdout: Buffer.from(DEVICES), stderr: '' };
    return { code: 0, stdout: new Uint8Array(), stderr: '' };
  };
  const phone = new AdbPhone({ log: new MemoryLogger(), exec, finder: { find: async () => ({ command: 'adb', prefixArgs: [], path: 'adb' }) } });
  return { phone, calls };
}

export const out = (text: string, code = 0): Partial<ExecResult> => ({ code, stdout: Buffer.from(text) });

