// Migration 71 (TeleCoding removed, B-044, 25.10.2026):
// what the TeleCoding producer left in the database goes – its keychain-wrapped bearer token and
// signing key and the person's "hidden" choice (kv 'telecoding'), the request ledger of its tools
// (kv 'telecoding.requests'), the copy of the v7 app's TeleCoding settings (kv 'legacy' /
// 'telecoding') and the connection's device rows ('telecoding:<random>', kind phone), revoked or
// not, so no agent or device list shows a "TeleCoding" phone any more. The settings section
// itself went with migration 69.
// Owns: these deletions. Never: other kv namespaces or devices, or files (TeleCoding's own
// config folder outside the data folder is not this app's).

export const sql = /* sql */ `
DELETE FROM kv WHERE ns IN ('telecoding', 'telecoding.requests') OR (ns = 'legacy' AND key = 'telecoding');
DELETE FROM devices WHERE substr(id, 1, 11) = 'telecoding:';
`;
