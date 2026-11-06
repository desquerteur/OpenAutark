// Learned time estimates (B-041 track A2, the My day concept §4.3): said in the text > the
// person's latest correction > the mean of ≥ 2 measured times (the focus timer) > the model's guess > the mean of
// the to-do's category (≥ 2 samples) > 30 min. Counters only in task_estimates (migration 068): one row per member
// and sha256(member + short key) – the split's canonical key or the folded title words without filler ("die
// Küche aufräumen" = "küche aufräumen") – and one per member and inferCategory bucket (routing/categories.ts) as
// the second key; a person's correction pins its row (measured times no longer move it). Fed by the day service
// (day.setEstimate, and a finished to-do's focus time). Built by compose/calendar.ts.
// Owns: the estimate rule and its counters. Never: stores task text, or an estimate outside 1 min – 24 h.

import { createHash } from 'node:crypto';
import { DEFAULT_ESTIMATE_MIN, type EstimateSource } from '../../shared/model/calendar.ts';
import { foldText } from '../../shared/text/normalize.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Estimates } from '../contracts/calendar.ts';
import { inferCategory } from '../routing/categories.ts';

export type EstimateDeps = Pick<RuntimeServices, 'db' | 'clock'> & Partial<Pick<RuntimeServices, 'log'>>;

const MAX_MIN = 24 * 60;
/** Measured times a key needs before its mean counts. */
export const MIN_SAMPLES = 2;
const usable = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1;
const capped = (value: number) => Math.min(Math.max(Math.round(value), 1), MAX_MIN);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Filler words a key leaves out (folded DE/EN): articles, possessives, "I need to", small prepositions. */
const FILLER = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'mein', 'meine', 'meinen', 'meinem', 'meiner',
  'meines', 'dein', 'deine', 'unser', 'unsere', 'noch', 'mal', 'etwas', 'was', 'bitte', 'ich', 'muss', 'will', 'mochte', 'wollte', 'sollte',
  'soll', 'am', 'im', 'an', 'auf', 'zu', 'zum', 'zur', 'fur', 'mit', 'und', 'the', 'a', 'my', 'our', 'your', 'some', 'to', 'for', 'with',
  'and', 'please', 'i', 'need', 'want', 'must', 'should', 'just',
]);

interface Row { minutes: number; samples: number; person_set: number; updated_at: number }

export class TaskEstimates implements Estimates {
  readonly s: EstimateDeps;
  constructor(s: EstimateDeps) { this.s = s; }

  estimateFor(input: { ownerId: string; title: string; key?: string; saidMin?: number; modelMin?: number }): { minutes: number; source: EstimateSource } {
    if (usable(input.saidMin)) return { minutes: capped(input.saidMin), source: 'said' };
    const rows = this.keysOf(input.title, input.key).map((key) => this.row(input.ownerId, key)).filter((row): row is Row => row !== undefined);
    const corrected = rows.filter((row) => row.person_set).sort((a, b) => b.updated_at - a.updated_at)[0];
    if (corrected) return { minutes: capped(corrected.minutes), source: 'person' };
    const measured = rows.find((row) => row.samples >= MIN_SAMPLES);
    if (measured) return { minutes: capped(measured.minutes), source: 'learned' };
    if (usable(input.modelMin)) return { minutes: capped(input.modelMin), source: 'model' };
    const category = inferCategory(input.title);
    const bucket = category ? this.row(input.ownerId, `category:${category}`) : undefined;
    if (bucket && bucket.samples >= MIN_SAMPLES) return { minutes: capped(bucket.minutes), source: 'learned' };
    return { minutes: DEFAULT_ESTIMATE_MIN, source: 'default' };
  }

  /** A correction by the person pins the key's minutes (latest wins); a measured time joins the key's mean. Both join the category's mean. */
  learn(ownerId: string, title: string, minutes: number, kind: 'person' | 'actual', key?: string): void {
    if (!usable(minutes)) return;
    const value = capped(minutes);
    const keyed = this.keysOf(title, key)[0];
    const category = inferCategory(title);
    try {
      this.s.db.tx(() => {
        if (keyed) this.count(ownerId, keyed, value, category, kind);
        if (category) this.count(ownerId, `category:${category}`, value, category, 'actual');
      });
    } catch (error) {
      this.s.log?.warn('estimate not learned', { error: String(error) });
    }
  }

  /** The short canonical key: folded words of the title (letters and digits) without filler, at most 6 words / 80 characters. */
  keyOf(title: string): string {
    const words = foldText(title).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const kept = words.filter((word) => !FILLER.has(word));
    return (kept.length ? kept : words).slice(0, 6).join(' ').slice(0, 80);
  }

  /** The split's key first, then the title's (distinct, non-empty). */
  private keysOf(title: string, key?: string): string[] {
    return [...new Set([key ? this.keyOf(key) : '', this.keyOf(title)].filter(Boolean))];
  }

  private row(ownerId: string, key: string): Row | undefined {
    try {
      return this.s.db.get<Row>('SELECT minutes, samples, person_set, updated_at FROM task_estimates WHERE owner_id = ? AND key_hash = ?', [ownerId, hash(`${ownerId}\u0000${key}`)]);
    } catch {
      return undefined; // a database without the table (older test setups): nothing learned
    }
  }

  private count(ownerId: string, key: string, minutes: number, category: string | undefined, kind: 'person' | 'actual'): void {
    const keyHash = hash(`${ownerId}\u0000${key}`);
    const now = this.s.clock.now();
    const row = this.row(ownerId, key);
    if (kind === 'person') {
      this.s.db.run(
        `INSERT INTO task_estimates (owner_id, key_hash, category, minutes, samples, person_set, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?)
         ON CONFLICT(owner_id, key_hash) DO UPDATE SET minutes = excluded.minutes, person_set = 1, category = excluded.category, updated_at = excluded.updated_at`,
        [ownerId, keyHash, category ?? null, minutes, now],
      );
      return;
    }
    if (row?.person_set) return; // the person's word stands
    const samples = (row?.samples ?? 0) + 1;
    const mean = Math.round(((row?.minutes ?? 0) * (samples - 1) + minutes) / samples);
    this.s.db.run(
      `INSERT INTO task_estimates (owner_id, key_hash, category, minutes, samples, person_set, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(owner_id, key_hash) DO UPDATE SET minutes = excluded.minutes, samples = excluded.samples, category = excluded.category, updated_at = excluded.updated_at`,
      [ownerId, keyHash, category ?? null, capped(mean), samples, now],
    );
  }
}
