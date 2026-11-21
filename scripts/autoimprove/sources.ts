/// <reference types="node" />
/**
 * Where uploaded data comes from: the deployed admin API (/api/replays, /api/errors with
 * REPLAY_ADMIN_KEY) or, for tests and offline runs, a local directory laid out like the Blob store
 * (<dir>/replays/YYYY-MM-DD/<id>.faereplay, <dir>/errors/YYYY-MM-DD/<id>.json).
 */
import fs from 'node:fs';
import path from 'node:path';

export type RemoteBlob = { pathname: string; size: number; uploadedAt: string };

export interface DataSource {
  readonly name: string;
  list(prefix: 'replays' | 'errors', since?: string): Promise<RemoteBlob[]>;
  get(pathname: string): Promise<Uint8Array>;
}

export class HttpSource implements DataSource {
  readonly name: string;
  constructor(private base: string, private adminKey: string, private fetchImpl: typeof fetch = fetch) {
    if (!adminKey) throw new Error('HttpSource: REPLAY_ADMIN_KEY is not set (expected in .env.local)');
    this.name = base;
  }
  private async call(url: string): Promise<Response> {
    let last = '';
    for (let i = 0; i < 4; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      try {
        const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.adminKey}` } });
        if (res.ok) return res;
        last = `HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300);
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) { last = String(e); }
    }
    throw new Error(`GET ${url.replace(/\?.*/, '')} failed: ${last}`);
  }
  async list(prefix: 'replays' | 'errors', since?: string) {
    const res = await this.call(`${this.base}/api/${prefix}?list=1${since ? `&since=${encodeURIComponent(since)}` : ''}`);
    return ((await res.json()) as { blobs: RemoteBlob[] }).blobs;
  }
  async get(pathname: string) {
    const prefix = pathname.startsWith('errors/') ? 'errors' : 'replays';
    const res = await this.call(`${this.base}/api/${prefix}?path=${encodeURIComponent(pathname)}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export class DirSource implements DataSource {
  readonly name: string;
  constructor(private dir: string) { this.name = dir; }
  async list(prefix: 'replays' | 'errors', since?: string) {
    const root = path.join(this.dir, prefix);
    if (!fs.existsSync(root)) return [];
    const out: RemoteBlob[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const st = fs.statSync(p);
          out.push({ pathname: path.relative(this.dir, p).split(path.sep).join('/'), size: st.size, uploadedAt: st.mtime.toISOString() });
        }
      }
    };
    walk(root);
    return out.filter((b) => !since || b.uploadedAt > since).sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1));
  }
  async get(pathname: string) {
    if (pathname.includes('..')) throw new Error(`DirSource: bad path ${pathname}`);
    return new Uint8Array(fs.readFileSync(path.join(this.dir, pathname)));
  }
}

/** Download blobs newer than `since` into `cacheDir` (same relative paths); returns the new local files and newest upload time. */
export async function syncPrefix(src: DataSource, prefix: 'replays' | 'errors', cacheDir: string, since?: string): Promise<{ newFiles: string[]; newest?: string }> {
  const blobs = await src.list(prefix, since);
  const newFiles: string[] = [];
  let newest = since;
  for (const b of blobs) {
    const local = path.join(cacheDir, b.pathname);
    if (!fs.existsSync(local)) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, await src.get(b.pathname));
    }
    newFiles.push(local);
    if (!newest || b.uploadedAt > newest) newest = b.uploadedAt;
  }
  return { newFiles, newest };
}

export function listLocal(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
