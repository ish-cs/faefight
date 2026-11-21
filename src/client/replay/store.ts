import type { ReplayMeta } from '../../sim/replay/format';

/**
 * Recorded matches in IndexedDB (this browser only; nothing is uploaded). Two stores: `meta` (list rows,
 * plus lastUsed for LRU) and `data` (the .faereplay bytes). Over the size cap the least recently
 * played/recorded replays are deleted.
 */
export const DEFAULT_CAP_BYTES = 200 * 1024 * 1024;
const DB_NAME = 'faefight-replays';

export type StoredMeta = ReplayMeta & { lastUsed: number };

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error ?? new Error('replay store: transaction aborted'));
});

export class ReplayStore {
  private constructor(private db: IDBDatabase, readonly capBytes: number, private now: () => number) {}

  static async open(opts: { name?: string; capBytes?: number; idb?: IDBFactory; now?: () => number } = {}): Promise<ReplayStore> {
    const idb = opts.idb ?? globalThis.indexedDB;
    if (!idb) throw new Error('Replays need IndexedDB, which this browser does not provide');
    const open = idb.open(opts.name ?? DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
    };
    const db = await req(open);
    return new ReplayStore(db, opts.capBytes ?? DEFAULT_CAP_BYTES, opts.now ?? Date.now);
  }

  /** Newest first. */
  async list(): Promise<StoredMeta[]> {
    const tx = this.db.transaction('meta', 'readonly');
    const all = await req(tx.objectStore('meta').getAll() as IDBRequest<StoredMeta[]>);
    return all.sort((a, b) => b.recordedAt - a.recordedAt);
  }

  async totalBytes(): Promise<number> {
    return (await this.list()).reduce((s, m) => s + m.size, 0);
  }

  /** Save (or replace) a replay, then evict least recently used ones over the cap. Returns evicted ids. */
  async put(meta: ReplayMeta, bytes: Uint8Array): Promise<string[]> {
    if (bytes.length > this.capBytes) throw new Error(`replay ${meta.id} (${bytes.length} B) is bigger than the replay storage cap`);
    const tx = this.db.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').put({ ...meta, size: bytes.length, lastUsed: this.now() } satisfies StoredMeta);
    tx.objectStore('data').put(bytes, meta.id);
    await done(tx);
    return this.evict(meta.id);
  }

  /** The bytes of a replay (marks it used), or null if it's gone. */
  async get(id: string): Promise<Uint8Array | null> {
    const tx = this.db.transaction(['meta', 'data'], 'readwrite');
    const meta = await req(tx.objectStore('meta').get(id) as IDBRequest<StoredMeta | undefined>);
    const data = await req(tx.objectStore('data').get(id) as IDBRequest<Uint8Array | undefined>);
    if (meta) tx.objectStore('meta').put({ ...meta, lastUsed: this.now() });
    await done(tx);
    return data ? new Uint8Array(data) : null;
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
    await done(tx);
  }

  private async evict(keep: string): Promise<string[]> {
    const all = await this.list();
    let total = all.reduce((s, m) => s + m.size, 0);
    const out: string[] = [];
    for (const m of [...all].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= this.capBytes) break;
      if (m.id === keep) continue;
      await this.delete(m.id);
      total -= m.size;
      out.push(m.id);
    }
    if (out.length) console.info(`[replays] storage over ${Math.round(this.capBytes / 1048576)} MB: removed ${out.length} oldest`);
    return out;
  }

  close() { this.db.close(); }
}

let shared: Promise<ReplayStore> | null = null;
/** The app's store (opened once). */
export function replayStore(): Promise<ReplayStore> {
  shared ??= ReplayStore.open().catch((err) => { shared = null; throw err; });
  return shared;
}
