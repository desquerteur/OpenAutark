// The chat mirror's write marks (B-050 K8 a, mirror.ts): every line to append gets an event number; a
// chat written whole, or one month of it written from the database, records the number it began at. An
// append up to that number is in that write already (dropped); a line of that chat or month arriving
// while the write runs becomes one more month rewrite (it may or may not be in yet) – so no line is
// written twice and none is lost.
// Owns: those numbers and marks. Never: writes a file or reads the database.

export class WriteMarks {
  private events = 0;
  /** The chat being written whole now. */
  private whole?: string;
  /** '<chat>/<month>' of the months being written now. */
  private readonly months = new Set<string>();
  private readonly wholeFrom = new Map<string, number>();
  private readonly monthFrom = new Map<string, Map<string, number>>();

  /** The number of a new line to append; undefined while a write of its chat or month runs (rewrite the month instead). */
  append(chatId: string, month: string): number | undefined {
    if (this.whole === chatId || this.months.has(`${chatId}/${month}`)) return undefined;
    return ++this.events;
  }

  /** True when a whole or month write that began after the append numbered `event` has its line. */
  covered(chatId: string, month: string, event: number): boolean {
    return event <= (this.wholeFrom.get(chatId) ?? 0) || event <= (this.monthFrom.get(chatId)?.get(month) ?? 0);
  }

  /** Runs the chat's whole write under its mark. */
  async writeWhole<T>(chatId: string, write: () => Promise<T>): Promise<T> {
    this.wholeFrom.set(chatId, this.events);
    this.monthFrom.delete(chatId); // its month writes began before this one
    this.whole = chatId;
    try {
      return await write();
    } finally {
      this.whole = undefined;
    }
  }

  /** Runs the write of one month of the chat under its mark. */
  async writeMonth<T>(chatId: string, month: string, write: () => Promise<T>): Promise<T> {
    let byMonth = this.monthFrom.get(chatId);
    if (!byMonth) this.monthFrom.set(chatId, byMonth = new Map());
    byMonth.set(month, this.events);
    const key = `${chatId}/${month}`;
    this.months.add(key);
    try {
      return await write();
    } finally {
      this.months.delete(key);
    }
  }

  /** The chat's folder went: its marks go too. */
  forget(chatId: string): void {
    this.wholeFrom.delete(chatId);
    this.monthFrom.delete(chatId);
  }
}
