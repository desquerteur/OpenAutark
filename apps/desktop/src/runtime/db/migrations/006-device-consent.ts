// Migration 6 (MP4): per-linked-PC consent on the PC that executes remote tools – `devices.allow`
// holds {screen, control, browser, files} for each linked PC (all off by default) – and the
// bounded audit of what agents of linked PCs did here (`remote_audit`, the last 200 per PC).

export const sql = /* sql */ `
ALTER TABLE devices ADD COLUMN allow TEXT NOT NULL DEFAULT '{}';
CREATE TABLE remote_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, at INTEGER NOT NULL, agent TEXT NOT NULL,
  tool TEXT NOT NULL, summary TEXT NOT NULL, ok INTEGER NOT NULL
) STRICT;
CREATE INDEX remote_audit_device ON remote_audit (device_id, id);
`;
