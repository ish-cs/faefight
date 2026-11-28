import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

// Charged grenade throw end to end (vs an easy bot): holding the button charges (meter + dotted arc + landing ring),
// a longer hold lands further, releasing throws, and the grenade goes off where the marker was (impact detonation).
// A right click while charging cancels without throwing. GC_SHOTS=<dir> saves a frame sequence there (for a GIF).

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Player = { id: number; island: number; pos: V; hotbar: (string | null)[]; inv: { grenades: number } };
type Snap = { players: Player[] };
type Arc = { charge: number; kind: string | null; shown: boolean; x: number; y: number; z: number; hit: boolean; count: number; dots: number };
type Boom = { type: string; kind?: string; pos: V; by: number; t: number };

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SHOTS = env.GC_SHOTS;
let frame = 0;
const shot = async (page: Page) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/f${String(frame++).padStart(3, '0')}.png` }); };
const look = (page: Page, yaw: number, pitch: number) => page.evaluate(([y, p]) => {
  const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
  input.yaw = y; input.pitch = p;
}, [yaw, pitch] as const);
const d2 = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z);

test('hold charges the throw (arc + ring + meter), release throws, and it goes off at the marker; right click cancels', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    const k = 'faefight.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    localStorage.setItem(k, JSON.stringify({ ...s, video: { ...(s.video ?? {}), power: 'quality' } }));
  });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const def = await dbg<{ islands: { center: V }[] }>(page, 'mapDef');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const arc = () => dbg<Arc>(page, 'throwArc');
  const c = def.islands[(await me()).island].center;

  await dbg(page, 'give', { grenades: 2 });
  await expect.poll(async () => (await me()).inv.grenades).toBe(2);
  const slot = (await me()).hotbar.indexOf('grenade');
  expect(slot).toBeGreaterThanOrEqual(0);
  await page.locator('canvas.game').click();
  await page.keyboard.press(`Digit${slot + 1}`);
  await dbg(page, 'teleport', c.x - 14, c.z - 10);
  await look(page, -Math.PI / 2, 0.25); // toward +X across the island, lobbed: a tap lands ~7 m out, a full charge ~30 m
  await page.waitForTimeout(1500); // spawn protection off, settled
  await expect(page.getByTestId('charge-ring')).toBeHidden();
  expect((await arc()).shown).toBe(false);
  await shot(page);

  // Hold: a short charge first.
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const early = await arc();
  await shot(page);
  expect(early.shown).toBe(true);
  expect(early.kind).toBe('grenade');
  expect(early.charge).toBeGreaterThan(0.1);
  expect(early.charge).toBeLessThan(0.7);
  expect(early.hit).toBe(true);
  expect(early.dots).toBeGreaterThan(4);
  await expect(page.getByTestId('charge-ring')).toBeVisible();
  // Keep holding to full: lands further, then the charge caps.
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(170); await shot(page); }
  await page.waitForTimeout(300);
  const full = await arc();
  expect(full.charge).toBe(1);
  await expect(page.getByTestId('charge-ring')).toHaveAttribute('data-pct', '100');
  const at = (await me()).pos;
  expect(d2(full, at)).toBeGreaterThan(d2(early, at) + 3);
  await page.waitForTimeout(200);
  const capped = await arc();
  expect(capped.charge).toBe(1);
  expect(d2(capped, full)).toBeLessThan(0.3); // capped: the same arc
  await shot(page);

  // Release: it's thrown and goes off at the marker.
  await page.mouse.up();
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(90); await shot(page); }
  await expect.poll(async () => (await dbg<Boom[]>(page, 'booms')).filter((b) => b.by === humanId && b.kind === 'grenade').length, { timeout: 4000 }).toBe(1);
  const boom = (await dbg<Boom[]>(page, 'booms')).find((b) => b.by === humanId && b.kind === 'grenade')!;
  expect(d2(boom.pos, capped)).toBeLessThan(1.0);
  expect(Math.abs(boom.pos.y - capped.y)).toBeLessThan(0.6);
  expect((await me()).inv.grenades).toBe(1);
  expect((await arc()).shown).toBe(false);
  await expect(page.getByTestId('charge-ring')).toBeHidden();
  for (let i = 0; i < 4; i++) { await page.waitForTimeout(120); await shot(page); }

  // Cancel: hold, right click, release: nothing thrown.
  await page.mouse.down();
  await page.waitForTimeout(400);
  expect((await arc()).shown).toBe(true);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(100);
  expect((await arc()).shown).toBe(false);
  expect((await arc()).charge).toBe(-1);
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect((await me()).inv.grenades).toBe(1);

  expect(errors.filter((e) => !/favicon|DevTools/.test(e))).toEqual([]);
});

// GIF capture only (GC_SHOTS set): a medium charge that lands in view, frames as fast as screenshots go.
test('gif: charge, arc, impact (GC_SHOTS only)', async ({ page }) => {
  test.skip(!SHOTS, 'frame capture only');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);
  const humanId = await dbg<number>(page, 'humanId');
  const def = await dbg<{ islands: { center: V }[] }>(page, 'mapDef');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const c = def.islands[(await me()).island].center;
  await dbg(page, 'give', { grenades: 3 });
  await expect.poll(async () => (await me()).inv.grenades).toBe(3);
  const slot = (await me()).hotbar.indexOf('grenade');
  await page.locator('canvas.game').click();
  await page.keyboard.press(`Digit${slot + 1}`);
  await dbg(page, 'teleport', c.x - 14, c.z - 10);
  await look(page, -Math.PI / 2 + 0.35, 0.02);
  await page.waitForTimeout(1500);
  const g = (name: string) => page.screenshot({ path: `${SHOTS}/g${name}.jpg`, type: 'jpeg', quality: 70 });
  let k = 0;
  const snap = () => g(String(k++).padStart(3, '0'));
  for (let i = 0; i < 2; i++) await snap();
  await page.mouse.move(640, 360);
  await page.mouse.down();
  const t0 = Date.now();
  while (Date.now() - t0 < 1300) await snap(); // charging: the arc reaches out, then caps
  await page.mouse.up();
  const t1 = Date.now();
  while (Date.now() - t1 < 2200) await snap(); // flight + impact
});
