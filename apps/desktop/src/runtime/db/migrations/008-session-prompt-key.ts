// Migration 8 (SES2): which system prompt and tool offer a native session was started with.
// `prompt_key` = sha256 of the stable prompt + the sorted offered tool names, `mode` = the mode
// key of that prompt. A turn resumes a session only while the key still matches; otherwise the
// session is renewed ("Mode changed from X to Y"). Rows from earlier versions keep NULL here and
// are accepted once (the turn stamps them with its key).

export const sql = /* sql */ `
ALTER TABLE engine_sessions ADD COLUMN prompt_key TEXT;
ALTER TABLE engine_sessions ADD COLUMN mode TEXT;
`;
