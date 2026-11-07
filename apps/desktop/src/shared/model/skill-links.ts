// Skills installed from a link (AF-007): a GitHub repository or folder (also /tree/<branch>/<path>), a direct SKILL.md
// address, a ZIP address or an uploaded ZIP. The preview the person sees before anything is written, the places a skill
// can go (shared, an agent's own, an agent's home project), the source record kept beside an installed skill
// (`.autark-source.json`) and the preview of an update. The skill folders stay agentskills.io / Claude Code skills.
// Owns: the shapes. Never: logic (runtime/skills/links/).

export type SkillLinkKind = 'github' | 'file' | 'zip' | 'upload';

export interface SkillLinkSource {
  kind: SkillLinkKind;
  /** The address as read (normalised); for an upload the file's name. */
  url: string;
  /** GitHub: owner/name. */
  repo?: string;
  /** GitHub: the branch, tag or commit as given (absent: the default branch). */
  ref?: string;
  /** GitHub: the folder the link points at ('' or absent: the whole repository). */
  folder?: string;
}

export interface SkillLinkFile {
  /** Relative to the skill folder, '/' separators. */
  path: string;
  size: number;
  /** Looks like something that runs (a script extension, scripts/ or bin/, an executable bit). */
  script?: true;
}

/** One skill of a preview: a folder of the source with SKILL.md. */
export interface SkillLinkCandidate {
  /** The folder in the source, '/' separators ('' = its root). */
  route: string;
  name: string;
  description: string;
  files: SkillLinkFile[];
  /** Bytes of all its files. */
  size: number;
  /** The paths of its files that look like scripts – they are only saved, never run on install. */
  scripts: string[];
  /** Short notes for the person: what is left out and why, the name taken from the folder … */
  notes: string[];
}

export interface SkillLinkPreview {
  /** Install with this id while it is valid (the bytes the person saw are the bytes that are written). */
  id: string;
  source: SkillLinkSource;
  skills: SkillLinkCandidate[];
  /** Folders with a SKILL.md that cannot be installed, and why. */
  problems: Array<{ route: string; problem: string }>;
  /** A bound was reached: the source may hold more skills. */
  truncated?: true;
  expiresAt: number;
}

/** Where an installed skill goes – the existing skill routes. */
export type SkillInstallTarget =
  | { kind: 'shared' } // <workspace>/skills/<name>: every agent
  | { kind: 'agent'; agentId: string } // <workspace>/agents/<slug>/skills/<name>: the agent and, for a manager, everyone below it
  | { kind: 'project'; agentId: string }; // <home project>/.claude/skills/<name>: the agent's home project (Claude Code's project skills)

export interface SkillLinkTarget {
  target: SkillInstallTarget;
  label: string;
  hint: string;
  /** The folder the skill folders go into. */
  folder: string;
}

/** `.autark-source.json` in an installed skill's folder. */
export interface SkillLinkRecord {
  version: 1;
  source: SkillLinkSource;
  /** The skill's folder in the source. */
  route: string;
  name: string;
  installedAt: number;
  updatedAt: number;
  /** sha256 of every file as written – an update tells the person's own edits apart. */
  files: Record<string, string>;
  /** GitHub: the commit the archive was made from (its comment), when it said. */
  commit?: string;
}

/** A skill installed from a link, wherever it went. */
export interface LinkedSkill {
  name: string;
  description: string;
  /** The skill folder. */
  path: string;
  target: SkillInstallTarget;
  /** "Shared", "Own · Ada", "Project · Ada". */
  place: string;
  source: SkillLinkSource;
  route: string;
  installedAt: number;
  updatedAt: number;
  commit?: string;
}

export interface SkillFileChange {
  path: string;
  change: 'added' | 'removed' | 'changed';
  /** The new size (the old one for a removed file). */
  size: number;
  /** Text files: lines that come and go. */
  lines?: { added: number; removed: number };
  /** The file was edited on this PC since it was installed – the update replaces that edit. */
  local?: true;
  script?: true;
}

export interface SkillUpdatePreview {
  id: string;
  path: string;
  name: string;
  source: SkillLinkSource;
  changes: SkillFileChange[];
  unchanged: number;
  /** The description before and after, when it changes. */
  description?: { before: string; after: string };
  /** Scripts the update adds or changes – saved, never run. */
  scripts: string[];
  /** The commit before and after (GitHub), when known. */
  commit?: { before?: string; after?: string };
  expiresAt: number;
}
