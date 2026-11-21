/** Minimal blob storage the ingest endpoints need (Vercel Blob in production, in-memory in tests). */
export type StoredBlob = { pathname: string; size: number; uploadedAt: Date };

export interface BlobStore {
  put(pathname: string, body: Uint8Array, contentType: string): Promise<void>;
  /** One page of blobs under `prefix` (oldest/newest order is not guaranteed). */
  list(prefix: string, cursor?: string): Promise<{ blobs: StoredBlob[]; cursor?: string }>;
  get(pathname: string): Promise<Uint8Array | null>;
  del(pathnames: string[]): Promise<void>;
}

/** In-memory store for unit tests. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, { body: Uint8Array; contentType: string; uploadedAt: Date }>();
  now: () => Date = () => new Date();
  pageSize = 1000;
  async put(pathname: string, body: Uint8Array, contentType: string) {
    this.blobs.set(pathname, { body, contentType, uploadedAt: this.now() });
  }
  async list(prefix: string, cursor?: string) {
    const all = [...this.blobs.entries()].filter(([p]) => p.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
    return { blobs: page.map(([pathname, b]) => ({ pathname, size: b.body.byteLength, uploadedAt: b.uploadedAt })), cursor: next };
  }
  async get(pathname: string) {
    return this.blobs.get(pathname)?.body ?? null;
  }
  async del(pathnames: string[]) {
    for (const p of pathnames) this.blobs.delete(p);
  }
}

/** Every blob under `prefix`, following pagination. */
export async function listAll(store: BlobStore, prefix: string): Promise<StoredBlob[]> {
  const out: StoredBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(prefix, cursor);
    out.push(...page.blobs);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** Delete the oldest blobs until the store holds at most `capBytes`. Returns what was removed. */
export async function pruneToCap(store: BlobStore, capBytes: number): Promise<{ deleted: number; freedBytes: number; totalBytes: number }> {
  const all = await listAll(store, '');
  let total = all.reduce((s, b) => s + b.size, 0);
  const victims: StoredBlob[] = [];
  for (const b of [...all].sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())) {
    if (total <= capBytes) break;
    victims.push(b);
    total -= b.size;
  }
  for (let i = 0; i < victims.length; i += 500) await store.del(victims.slice(i, i + 500).map((v) => v.pathname));
  return { deleted: victims.length, freedBytes: victims.reduce((s, b) => s + b.size, 0), totalBytes: total };
}
