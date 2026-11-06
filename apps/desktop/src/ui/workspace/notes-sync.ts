// A chat's shared notes in the pane's Notes tab, kept in step with the runtime the simple way: load
// (notes.get); save after a pause in typing and when the tab closes (notes.save on the version it was
// made on – when someone changed the notes meanwhile, the save is made again on the newer version:
// the last write wins, and the runtime keeps every version); and when someone else changed them (the
// notes.updated event, a reconnect, the field getting focus) the newer text is loaded while nothing
// typed waits, so the line under it says "Updated by <agent>".
// Owns: that loop. Never: merges texts or shows the history (an agent restores a version on request).

import { signal } from '@preact/signals';
import type { ChatNotes } from '../../shared/model/notes.ts';

export const SAVE_DELAY_MS = 1000;

export interface NotesState {
  loaded: boolean;
  text: string;
  version: number;
  updatedBy?: string;
  updatedAt?: number;
  /** Typed text that is not saved yet. */
  dirty: boolean;
  saving: boolean;
  error?: string;
}

export interface NotesCalls {
  get(): Promise<ChatNotes>;
  save(text: string, baseVersion: number): Promise<ChatNotes>;
  /** The runtime refused a save made on an older version. */
  conflict(error: unknown): boolean;
  errorText(error: unknown): string;
}

export class NotesSync {
  readonly state = signal<NotesState>({ loaded: false, text: '', version: 0, dirty: false, saving: false });
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private readonly calls: NotesCalls;
  private readonly delay: number;

  constructor(calls: NotesCalls, delay = SAVE_DELAY_MS) {
    this.calls = calls;
    this.delay = delay;
  }

  /** Loads the current notes; typed text that waits is kept (its save wins). */
  async load(): Promise<void> {
    try {
      const notes = await this.calls.get();
      const now = this.state.peek();
      if (now.dirty || now.saving) return;
      this.state.value = { loaded: true, text: notes.text, version: notes.version, updatedBy: notes.updatedBy, updatedAt: notes.updatedAt, dirty: false, saving: false };
    } catch (error) {
      this.state.value = { ...this.state.peek(), error: this.calls.errorText(error) };
    }
  }

  edit(text: string): void {
    this.state.value = { ...this.state.peek(), text, dirty: true, error: undefined };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.save(); }, this.delay);
  }

  /** Saves now (the tab closes, Ctrl+S, the field loses focus). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return this.save();
  }

  /** Someone saved version `version`: load it unless typed text waits. */
  changed(version: number): void {
    const now = this.state.peek();
    if (version > now.version && !now.dirty && !now.saving) void this.load();
  }

  private save(): Promise<void> {
    this.saving ??= this.send().finally(() => { this.saving = undefined; });
    return this.saving;
  }

  private async send(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) { // typed on while saving, or a newer version came between
      const now = this.state.peek();
      if (!now.dirty || !now.loaded) return;
      this.state.value = { ...now, saving: true };
      try {
        const saved = await this.calls.save(now.text, now.version);
        const after = this.state.peek();
        const dirty = after.text !== now.text;
        this.state.value = { ...after, version: saved.version, updatedBy: saved.updatedBy, updatedAt: saved.updatedAt, saving: false, dirty, error: undefined };
        if (!dirty) return;
      } catch (error) {
        if (!this.calls.conflict(error)) { this.state.value = { ...this.state.peek(), saving: false, error: this.calls.errorText(error) }; return; }
        try {
          const latest = await this.calls.get(); // the last write wins: this text goes onto the newer version
          this.state.value = { ...this.state.peek(), version: latest.version, saving: false };
        } catch (failed) {
          this.state.value = { ...this.state.peek(), saving: false, error: this.calls.errorText(failed) };
          return;
        }
      }
    }
  }
}
