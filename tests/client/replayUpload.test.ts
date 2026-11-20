import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, ReplayUploader } from '../../src/client/telemetry/replayUpload';
import type { UploadDeps } from '../../src/client/telemetry/upload';
import { decodeReplay } from '../../src/sim/replay/codec';
import { withoutChat } from '../../src/sim/replay/format';
import { Recorder } from '../../src/sim/replay/recorder';
import { Match } from '../../src/sim/match';

function deps(statuses: number[]) {
  const posts: { body: unknown; type: string }[] = [];
  const d: UploadDeps = {
    fetch: (async (_url: string, init: RequestInit) => {
      posts.push({ body: init.body, type: (init.headers as Record<string, string>)['content-type'] });
      return new Response('{}', { status: statuses.shift() ?? 201 });
    }) as typeof fetch,
    sleep: async () => {},
  };
  return { d, posts };
}
const now = async () => {};
const bytes = new Uint8Array([70, 65, 69, 82, 1, 0, 0, 0]);

describe('ReplayUploader', () => {
  it('uploads a finished match once, retrying transient failures', async () => {
    const { d, posts } = deps([503, 201]);
    const u = new ReplayUploader(d, '/api/replays', now);
    expect(await u.share(bytes, { id: 'a', unfinished: false, duration: 30 })).toBe(true);
    expect(posts.length).toBe(2);
    expect(posts[0].type).toBe('application/octet-stream');
    expect(await u.share(bytes, { id: 'a', unfinished: false, duration: 30 })).toBe(false);
    expect(posts.length).toBe(2);
  });

  it('uploads an unfinished match only after 60 s, once, and still takes the final one later', async () => {
    const { d, posts } = deps([]);
    const u = new ReplayUploader(d, '/api/replays', now);
    expect(await u.share(bytes, { id: 'b', unfinished: true, duration: 59 })).toBe(false);
    expect(await u.share(bytes, { id: 'b', unfinished: true, duration: 75 })).toBe(true);
    expect(await u.share(bytes, { id: 'b', unfinished: true, duration: 90 })).toBe(false);
    expect(await u.share(bytes, { id: 'b', unfinished: false, duration: 400 })).toBe(true);
    expect(posts.length).toBe(2);
  });

  it('a rejected upload (4xx) is not retried and never throws', async () => {
    const { d, posts } = deps([422]);
    const u = new ReplayUploader(d, '/api/replays', now);
    expect(await u.share(bytes, { id: 'c', unfinished: false, duration: 100 })).toBe(false);
    expect(posts.length).toBe(1);
  });
});

describe('ReplayUploader limits', () => {
  it('drops a recording over the size cap without sending anything', async () => {
    const { d, posts } = deps([]);
    const u = new ReplayUploader(d, '/api/replays', now);
    expect(await u.share(new Uint8Array(MAX_UPLOAD_BYTES + 1), { id: 'big', unfinished: false, duration: 100 })).toBe(false);
    expect(posts.length).toBe(0);
  });

  it('waits for an idle moment before sending, and sends one upload at a time', async () => {
    const { d, posts } = deps([]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let idleCalls = 0;
    const u = new ReplayUploader(d, '/api/replays', () => { idleCalls++; return gate; });
    const a = u.share(bytes, { id: 'x', unfinished: false, duration: 100 });
    const b = u.share(bytes, { id: 'y', unfinished: false, duration: 100 });
    await Promise.resolve();
    expect(posts.length).toBe(0);
    expect(idleCalls).toBe(1); // the second waits behind the first
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(posts.length).toBe(2);
    expect(idleCalls).toBe(2);
  });
});

describe('chat never reaches a recording', () => {
  it('withoutChat drops chat events and chat tags and leaves a chat-free recording untouched', () => {
    const header = { tags: { chatLog: ['hi'], gen: 3 } } as never;
    const r = withoutChat({ header, events: [[1, 'kill', {}], [10, 'chat', { from: 'A', text: 'my address is…' }]] as [number, string, Record<string, unknown>][] });
    expect(r.events.map(([, t]) => t)).toEqual(['kill']);
    expect((r.header as { tags: unknown }).tags).toEqual({ gen: 3 });
    const clean = { header: { tags: { gen: 3 } } as never, events: [] };
    expect(withoutChat(clean)).toBe(clean);
  });

  it('the recorder strips chat tags before encoding', async () => {
    const setup = { players: [{ name: 'A', isBot: true, difficulty: 'easy' as const }, { name: 'B', isBot: true, difficulty: 'easy' as const }], seed: 5 };
    const m = await Match.create(setup);
    try {
      const rec = new Recorder(m, { setup, kind: 'test', localId: 0, tags: { chatLog: ['secret'], gen: 1 } });
      for (let i = 0; i < 30; i++) rec.tick(new Map());
      const { bytes } = await rec.finish();
      const r = await decodeReplay(bytes);
      expect(r.header.tags).toEqual({ gen: 1 });
      expect(r.events.some(([, t]) => /chat/i.test(t))).toBe(false);
    } finally {
      m.dispose();
    }
  });
});
