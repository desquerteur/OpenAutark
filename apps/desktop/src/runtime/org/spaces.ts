// Spaces: the person's life areas (company, personal brand, private life, custom areas).
// Owns: space CRUD and validation, the lazily created default space of a template's kind
// (company → the profile's company name or "Company", brand → "Personal brand", private →
// "Private"; none for app customization agents), and the 'space.upserted' event.
// Never: archives or moves agents (agents keep their space id; lists hide archived spaces),
// revives an archived space, auto-creates custom spaces, or seeds spaces on first run.

import type { Bus } from '../bus.ts';
import type { Clock } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import type { AgentTemplate, Space } from '../../shared/model/org.ts';
import { SpaceRepo } from '../store/spaces.ts';
import { cleanColor, cleanName, cleanSpaceKind } from './validate.ts';

export interface SpacesDeps {
  db: Db;
  bus: Bus;
  clock: Clock;
  /** The person's company name (settings.json profile.company; compose passes it) – the company space's name. */
  companyName?: () => string | undefined;
}

/** Default names of the spaces created on demand (company uses the profile's company first). */
export const DEFAULT_SPACE_NAMES: Readonly<Record<'company' | 'brand' | 'private', string>> = {
  company: 'Company', brand: 'Personal brand', private: 'Private',
};

/** The area a hire from `template` belongs to: the template's spaceKind. */
export function areaKind(template: Pick<AgentTemplate, 'spaceKind'> | undefined): Space['kind'] | undefined {
  return template?.spaceKind;
}

export class Spaces {
  private readonly deps: SpacesDeps;
  private readonly repo: SpaceRepo;

  constructor(deps: SpacesDeps) {
    this.deps = deps;
    this.repo = new SpaceRepo(deps.db);
  }

  list(includeArchived = false): Space[] {
    return this.repo.list(includeArchived);
  }

  get(id: string): Space | undefined {
    return this.repo.get(id);
  }

  save(input: Partial<Space> & { name: string }): Space {
    const existing = input.id ? this.repo.get(input.id) : undefined;
    if (input.id && !existing) throw new WorkforceError('not_found', 'This space no longer exists.');
    const space: Space = existing ?? {
      id: newId('sp', this.deps.clock.now()), name: '', kind: 'custom', sort: this.repo.maxSort() + 1, createdAt: this.deps.clock.now(),
    };
    space.name = cleanName(input.name, 'space name');
    if (input.kind !== undefined) space.kind = cleanSpaceKind(input.kind);
    if (input.color !== undefined) space.color = input.color === null ? undefined : cleanColor(input.color);
    if (input.sort !== undefined) {
      if (!Number.isInteger(input.sort)) throw new WorkforceError('bad_request', 'Invalid sort order.');
      space.sort = input.sort;
    }
    this.repo.upsert(space);
    const saved = this.repo.get(space.id)!;
    this.deps.bus.emit('space.upserted', saved);
    return saved;
  }

  /** Archives a space. Its agents stay as they are and simply show without a space heading. */
  archive(id: string): void {
    const space = this.repo.get(id);
    if (!space) throw new WorkforceError('not_found', 'This space no longer exists.');
    if (space.archivedAt) return;
    space.archivedAt = this.deps.clock.now();
    this.repo.upsert(space);
    this.deps.bus.emit('space.upserted', space);
  }

  /**
   * The active space of `kind`: `prefer` (the new manager's space) when it is an active space of
   * that kind, else the first in sort order. For company, brand and private it is created when
   * none is active – an archived one stays archived. Custom spaces are never created automatically.
   */
  forKind(kind: Space['kind'], prefer?: string): Space | undefined {
    const spaces = this.repo.list().filter((space) => space.kind === kind);
    const active = spaces.find((space) => space.id === prefer) ?? spaces[0];
    if (active || kind === 'custom') return active;
    const name = kind === 'company' ? companyName(this.deps.companyName?.()) ?? DEFAULT_SPACE_NAMES.company : DEFAULT_SPACE_NAMES[kind];
    return this.save({ name, kind });
  }
}

/** The profile's company name, cleaned (undefined when none is set). */
function companyName(company: unknown): string | undefined {
  if (typeof company !== 'string') return undefined;
  const clean = company.replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/gu, ' ').slice(0, 80).trim();
  return clean || undefined;
}
