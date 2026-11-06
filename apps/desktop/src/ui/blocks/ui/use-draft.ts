// useDraft: widget input that survives navigation, reloads and restarts (local storage).
// Owns: the hook. Never: stores secrets – secret form fields are excluded by the caller.

import { useState } from 'preact/hooks';
import { readDraft, writeDraft } from '../host.ts';

export function useDraft<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readDraft<T>(key) ?? initial);
  const set = (next: T) => {
    setValue(next);
    writeDraft(key, next);
  };
  return [value, set];
}
