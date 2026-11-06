// Tiny IndexedDB key/value store shared by the PWA page, the desktop window and the service worker.
// Owns: the 'workforce-pwa' database with one 'kv' object store: offline snapshots and (F07) the
// record widget's unsent takes ('take:<draftKey>', at most TAKE_MAX_BYTES each, swept once older
// than TAKE_MAX_AGE_MS).
// Never: stores tokens or secrets (the device token lives in localStorage 'wf.token' only), or
// keeps a take after it was sent, retaken or discarded.

const DB_NAME = 'workforce-pwa';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** One readwrite transaction; resolves when it committed. */
async function write(change: (store: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      change(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error); // e.g. the quota is full
    });
  } finally {
    db.close();
  }
}

export function idbSet(key: string, value: unknown): Promise<void> {
  return write((store) => { store.put(value, key); });
}

export function idbDelete(key: string): Promise<void> {
  return write((store) => { store.delete(key); });
}

/** Deletes the entries under `prefix` that `drop` picks (one cursor pass). */
export function idbSweep(prefix: string, drop: (value: unknown) => boolean): Promise<void> {
  return write((store) => {
    const req = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (drop(cursor.value)) cursor.delete();
      cursor.continue();
    };
  });
}

/** Key of the last "For you" list snapshot ({ at, items: TaskView[] }). */
export const TODO_SNAPSHOT_KEY = 'todos';

// ------------------------------------------------------------------ unsent takes (F07)

/** A record widget's take that was not sent yet ("Resume unsent recording"). */
export interface StoredTake {
  blob: Blob;
  mime: string;
  seconds: number;
  /** When it was recorded (epoch ms). */
  at: number;
}

const TAKE_PREFIX = 'take:';
/**
 * Unsent takes hold the person's voice or face: one older than a week is deleted by the next
 * sweep – on every save and load of a take and whenever a For-you list mounts (sweepTakes).
 */
export const TAKE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A larger take is not copied into the store (it stays in memory only): no multi-GB copies. */
export const TAKE_MAX_BYTES = 500 * 1024 * 1024;

export function isStaleTake(value: unknown, now: number): boolean {
  const at = (value as { at?: unknown } | null)?.at;
  return typeof at !== 'number' || now - at > TAKE_MAX_AGE_MS;
}

// Take writes run one after another, so a quick Retake or Send never races the save before it.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const sweepStale = () => idbSweep(TAKE_PREFIX, (value) => isStaleTake(value, Date.now()));

/**
 * Keeps a take under its widget's draft key; storage that is blocked or full keeps nothing. A
 * take above TAKE_MAX_BYTES is not kept and clears the key, so no older take stands in for it.
 */
export function saveTake(key: string, take: StoredTake): Promise<void> {
  if (take.blob.size > TAKE_MAX_BYTES) return dropTake(key);
  return serial(async () => {
    await idbSet(TAKE_PREFIX + key, take);
    await sweepStale();
  }).catch(() => undefined);
}

export function loadTake(key: string): Promise<StoredTake | undefined> {
  return serial(async () => {
    await sweepStale();
    const value = await idbGet<StoredTake>(TAKE_PREFIX + key);
    return value && value.blob instanceof Blob && value.blob.size > 0 ? value : undefined;
  }).catch(() => undefined);
}

/** Deletes the takes older than a week, also those whose widget never mounts again. */
export function sweepTakes(): Promise<void> {
  return serial(sweepStale).catch(() => undefined);
}

export function dropTake(key: string): Promise<void> {
  return serial(() => idbDelete(TAKE_PREFIX + key)).catch(() => undefined);
}
