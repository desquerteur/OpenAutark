// Android phones over ADB as agents see them (phone.* tools, runtime/phone).
// Owns: the shapes shared by the phone driver and its tools. Never: behaviour.

/** A phone announcing wireless debugging on this network (`adb mdns services`). */
export interface NearbyPhone {
  /** The mDNS instance name ("adb-R58N123-AbCdEf"). */
  name: string;
  /** 'pairing' = its "Pair device with pairing code" dialog is open; 'connect' = paired phones can connect. */
  service: 'pairing' | 'connect';
  /** host:port to pair with or connect to. */
  address: string;
}
