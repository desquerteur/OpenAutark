// RPC contract part: `rpc.methods`, the list of what can be called, so a program or an AI needs no source file.
// Owns: this method's shape. Never: behaviour (rpc/handlers/rpc-methods.ts).

export interface RpcMethodInfo {
  name: string;
  /** The params as the contract writes them ('void' = none), with its named types spelled out in `types`. */
  params: string;
  note?: string;
  /** Who may call it: 'owner' (the launch token in runtime.json), 'any' device, or the capability a device needs. */
  who: string;
  /** A chat's connector token (chats.connectExternal) reaches it too, only for its own chat. */
  connector?: true;
  /** A person of the organisation reaches it too. */
  person?: true;
}

export interface RpcMethodList {
  methods: RpcMethodInfo[];
  /** The named types those params use (with `match` only: the whole list would be long). */
  types?: Record<string, string>;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** Every method with its params. `match`: only names or notes holding this text, with the types they use spelled out. */
    'rpc.methods': { params: { match?: string } | void; result: RpcMethodList };
  }
}
