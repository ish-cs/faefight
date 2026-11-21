import { del, get, list, put } from '@vercel/blob';
import type { BlobStore } from './store.js';

/** Vercel Blob (private store; BLOB_READ_WRITE_TOKEN comes from the project env). */
export class VercelBlobStore implements BlobStore {
  async put(pathname: string, body: Uint8Array, contentType: string) {
    await put(pathname, Buffer.from(body), { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false });
  }
  async list(prefix: string, cursor?: string) {
    const r = await list({ prefix, cursor, limit: 1000 });
    return { blobs: r.blobs.map((b) => ({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt) })), cursor: r.hasMore ? r.cursor : undefined };
  }
  async get(pathname: string) {
    const r = await get(pathname, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return new Uint8Array(await new Response(r.stream).arrayBuffer());
  }
  async del(pathnames: string[]) {
    if (pathnames.length) await del(pathnames);
  }
}
