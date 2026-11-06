// Migration 3 (R4): agents remember the agent they were derived from or imported as
// (`based_on`). No foreign key: the original may live on another PC or be archived.

export const sql = /* sql */ `
ALTER TABLE agents ADD COLUMN based_on TEXT;
`;
