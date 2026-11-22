import { expect, test, type Page } from '@playwright/test';

// Host-migration networking that needs no GPU, so it runs on CI (migration.spec.ts plays a real match
// and is skipped there). Three real tabs on the same-browser transport (?net=local's BroadcastChannel),
// no game: the pages load a source module as plain text and import the net code from the dev server.
//
// The race this guards (migration.spec under load): a tab's main thread stalls for seconds (shader
// compiles at match start), the heartbeat check runs late, and the 3 s timeout dropped every guest mid-
// match ("lost the connection to the host"), which also moved the backup host to whoever was connected.

type Net = typeof import('../../src/net/broadcast');
const NET_URL = '/src/net/broadcast.ts';
type W = Window & { __net?: { closes: number; joins: number } };

async function open(p: Page) {
  await p.goto(NET_URL);
}

const stall = (p: Page, ms: number) => p.evaluate((ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* long frame */ } }, ms);
const closes = (p: Page) => p.evaluate(() => (window as W).__net!.closes);

test('net=local links survive stalled tabs; a closed host reaches every guest at once', async ({ context }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const [a, b, c] = [await context.newPage(), await context.newPage(), await context.newPage()];
  for (const [tag, p] of [['A', a], ['B', b], ['C', c]] as const) p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  await Promise.all([open(a), open(b), open(c)]);

  const code = await a.evaluate(async (url) => {
    const { BroadcastTransport } = (await import(url)) as Net;
    const w = window as W;
    w.__net = { closes: 0, joins: 0 };
    const room = await new BroadcastTransport().host();
    room.onJoin((l) => { w.__net!.joins++; l.onClose(() => w.__net!.closes++); });
    return room.code;
  }, NET_URL);
  for (const p of [b, c]) {
    await p.evaluate(async ([code, url]) => {
      const { BroadcastTransport } = (await import(url)) as Net;
      const w = window as W;
      w.__net = { closes: 0, joins: 0 };
      const link = await new BroadcastTransport().join(code);
      link.onClose(() => w.__net!.closes++);
    }, [code, NET_URL] as const);
  }
  await expect.poll(() => a.evaluate(() => (window as W).__net!.joins)).toBe(2);

  // The host tab stalls 5 s (longer than the old 3 s timeout), then a guest tab does.
  await a.waitForTimeout(1500);
  await stall(a, 5000);
  await stall(b, 5000);
  await a.waitForTimeout(2500);
  expect([await closes(a), await closes(b), await closes(c)]).toEqual([0, 0, 0]);

  // The host's tab goes away: both guests learn it at once (bye), not after a timeout.
  const t0 = Date.now();
  await a.close();
  await expect.poll(async () => [await closes(b), await closes(c)], { timeout: 15_000 }).toEqual([1, 1]);
  expect(Date.now() - t0).toBeLessThan(8000);
  expect(errors, errors.join('\n')).toEqual([]);
});
