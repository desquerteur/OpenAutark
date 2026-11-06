// B-044 first run (contract decision 21): the owner's methods of the first-run layer
// (ui/onboarding/FirstRun.tsx) – "Set up team again" and the end of the layer – joining the RPC
// contract by module augmentation (methods.ts is at its size limit).
// Owns: these shapes. Never: behaviour (runtime/onboarding/service.ts, ui/onboarding).

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner only, "Set up team again": onboarding is open again (step 'ai') – the first-run layer returns. */
    'onboarding.reset': { params: void; result: { ok: true } };
    /**
     * Owner only: the first-run cards are through – step 'done', the Manager's first chat (made when
     * there is none) and the app's start text posted there as the person's own line (one ordinary message).
     */
    'onboarding.start': { params: void; result: { conversationId: string } };
  }
}
