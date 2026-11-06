// Migration 31 (MM5): measured colours and loudness of media rows. `colors` (JSON list of at most
// five {hex, share}, largest share first), `peak_db` / `rms_db` (dBFS of the loudest sample and of
// the RMS level), `silent` (1 = nothing louder than -60 dBFS), `loudness_partial` (1 = only the
// start was measured, at most its first 10 minutes) and `measured_at` (when it ran – also when nothing
// could be measured, so it is not repeated). Rule: measured values only, never model guesses.

export const sql = /* sql */ `
ALTER TABLE media ADD COLUMN colors TEXT;
ALTER TABLE media ADD COLUMN peak_db REAL;
ALTER TABLE media ADD COLUMN rms_db REAL;
ALTER TABLE media ADD COLUMN silent INTEGER;
ALTER TABLE media ADD COLUMN loudness_partial INTEGER;
ALTER TABLE media ADD COLUMN measured_at INTEGER;
`;
