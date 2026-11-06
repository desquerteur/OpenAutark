// B-078: the phone.* tools' one driver over both ways to a phone – ADB (USB or wireless debugging, adb.ts) and the
// Autark Android app's phone use (app-driver.ts, serial = the phone's device id). phone.devices lists both; a step with
// a serial goes to the phone that carries it; without one it goes to the only phone there is (an app phone counts when
// ADB has no ready phone). Wireless pairing (pair, connect, disconnect, discover) stays ADB's.
// Owns: that choice. Never: drives a phone itself.

import type { PhoneDriver, PhoneShot, PhoneStepOptions, PhoneTree, PhoneWireless } from './driver.ts';
import type { PhoneDevice } from './uiautomator.ts';
import type { AppPhones } from './app-driver.ts';

type Adb = PhoneDriver & PhoneWireless;

export function mergedPhones(adb: Adb, app: Pick<AppPhones, keyof PhoneDriver | 'has' | 'serials'>): Adb {
  const adbReady = async (): Promise<boolean> => (await adb.devices().catch(() => [] as PhoneDevice[])).some((device) => device.state === 'device');
  /** The driver for a step: the app phone named (or the only phone, when ADB has none ready), else ADB. */
  const of = async (serial: string | undefined): Promise<PhoneDriver> => {
    if (serial) return app.has(serial) ? app : adb;
    if (app.serials().length && !(await adb.available().catch(() => false) && await adbReady())) return app;
    return adb;
  };
  return {
    available: async () => (await app.available()) || adb.available().catch(() => false),
    devices: async () => {
      const own = await app.devices();
      const viaAdb = (await adb.available().catch(() => false)) ? await adb.devices().catch(() => [] as PhoneDevice[]) : [];
      return [...own, ...viaAdb];
    },
    screenshot: async (serial?: string, step?: PhoneStepOptions): Promise<PhoneShot> => (await of(serial)).screenshot(serial, step),
    uiTree: async (serial?: string, step?: PhoneStepOptions): Promise<PhoneTree> => (await of(serial)).uiTree(serial, step),
    tap: async (serial, x, y, step) => (await of(serial)).tap(serial, x, y, step),
    swipe: async (serial, from, to, durationMs, step) => (await of(serial)).swipe(serial, from, to, durationMs, step),
    type: async (serial, value, step) => (await of(serial)).type(serial, value, step),
    key: async (serial, name, step) => (await of(serial)).key(serial, name, step),
    open: async (serial, target, step) => (await of(serial)).open(serial, target, step),
    pair: (address, code) => adb.pair(address, code),
    connect: (address) => adb.connect(address),
    disconnect: (serial) => adb.disconnect(serial),
    discover: () => adb.discover(),
  };
}
