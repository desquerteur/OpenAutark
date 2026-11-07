// RPC contract part (AF-007): skills installed from a link – a GitHub repository or folder, a SKILL.md address, a ZIP
// address or an uploaded ZIP (files.upload / the desktop's file picker). Preview first (nothing written), then install
// the chosen skills into one place; the source is kept beside each skill so an update can be previewed and applied.
// Scripts are only saved, never run. Handlers: runtime/rpc/handlers/skill-links.ts ('manage', like skills.save).
// Merged into Methods by module augmentation. Owns: these method shapes. Never: behaviour.

import type { LinkedSkill, SkillInstallTarget, SkillLinkPreview, SkillLinkTarget, SkillUpdatePreview } from '../model/skill-links.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Reads a link (`url`: GitHub repository/folder/tree/blob, a SKILL.md or a ZIP address) or an uploaded ZIP (`fileId`) and lists its skills with their files. */
    'skills.previewLink': { params: { url?: string; fileId?: string }; result: SkillLinkPreview };
    /** The places a skill from a link can go: shared, each agent's own skills, each agent's home project. */
    'skills.linkTargets': { params: void; result: SkillLinkTarget[] };
    /** Installs the skills of a preview (`routes`: their folders in the source) into `target`; a taken name there is a 'conflict'. */
    'skills.installLink': { params: { previewId: string; routes: string[]; target: SkillInstallTarget }; result: { installed: LinkedSkill[] } };
    /** Every skill installed from a link, with its source. */
    'skills.linked': { params: void; result: LinkedSkill[] };
    /** Reads an installed skill's source again and lists what an update would change (`fileId`: the new ZIP of an uploaded one). */
    'skills.checkUpdate': { params: { path: string; fileId?: string }; result: SkillUpdatePreview };
    /** Applies a checked update (the files the preview showed); the folder is swapped in one step. */
    'skills.applyUpdate': { params: { previewId: string }; result: LinkedSkill };
  }
}

export {};
