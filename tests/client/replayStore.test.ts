import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ReplayMeta } from '../../src/sim/replay/format';
import { ReplayStore } from '../../src/client/replay/store';
import { crc32, unzip, zip } from '../../src/client/replay/zip';

const meta = (id: string, recordedAt: number): ReplayMeta => ({
  id, recordedAt, kind: 'solo', players: [{ id: 1, name: 'You', isBot: false }], localId: 1, mapName: '2 islands',
  winner: 1, duration: 60, unfinished: false, size: 0,
});
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('ReplayStore', () => {
  it('stores, lists newest first, reads back and deletes', async () => {
    const s = await ReplayStore.open({ idb: new IDBFactory() });
    await s.put(meta('a', 1), bytes(10, 1));
    await s.put(meta('b', 2), bytes(20, 2));
    expect((await s.list()).map((m) => m.id)).toEqual(['b', 'a']);
    expect((await s.list())[0].size).toBe(20);
    expect(await s.get('a')).toEqual(bytes(10, 1));
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
    expect(await s.totalBytes()).toBe(20);
  });

  it('evicts least recently used replays over the cap, never the one just saved', async () => {
    let clock = 0;
    const s = await ReplayStore.open({ idb: new IDBFactory(), capBytes: 100, now: () => ++clock });
    await s.put(meta('a', 1), bytes(40));
    await s.put(meta('b', 2), bytes(40));
    await s.get('a'); // a played recently: b is now the least recently used
    const gone = await s.put(meta('c', 3), bytes(40));
    expect(gone).toEqual(['b']);
    expect((await s.list()).map((m) => m.id).sort()).toEqual(['a', 'c']);
    expect(await s.totalBytes()).toBeLessThanOrEqual(100);
    await expect(s.put(meta('huge', 4), bytes(101))).rejects.toThrow(/bigger than/);
  });
});

describe('zip', () => {
  it('round-trips files and computes standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const files = [{ name: 'a.faereplay', data: bytes(5, 3) }, { name: 'b é.faereplay', data: bytes(0) }];
    expect(unzip(zip(files))).toEqual(files);
  });
});
