// Migration 7 (MM3): an agent's speaking voice (`voice`, e.g. "nova"), the default of the
// media.speak tool. Empty = the speech model's default voice.

export const sql = /* sql */ `
ALTER TABLE agents ADD COLUMN voice TEXT;
`;
