import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

type P = { id: number; island: number; pos: { x: number; y: number; z: number }; alive: boolean };
type Snap = { time: number; suddenDeath: boolean; barrierAt?: number; sealed: boolean[]; players: P[] };
type Isl = { center: { x: number; z: number }; groundY: number; bunker: { center: { x: number; z: number }; doorways: { center: { x: number; z: number }; yaw: number }[] } };

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
/** Directory for screenshots (the hand-off), e.g. E2E_SHOTS=/tmp/x pnpm e2e barriers. */
const SHOTS = env.E2E_SHOTS;

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);
const look = (page: Page, yaw: number, pitch: number) => page.evaluate(([y, p]) => {
  const f = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight;
  f.input.yaw = y; f.input.pitch = p;
}, [yaw, pitch]);

test('sudden death: one ALL BUNKERS SEALED announcement, no per-bunker seal lines, concrete barriers that block the doorways', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [], logs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else logs.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?debug=1&bots=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() =>
    !(window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible()), { timeout: 120_000 }).toBe(true);
  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];
  const front = home.bunker.doorways[0];
  const out = { x: -Math.sin(front.yaw), z: -Math.cos(front.yaw) }; // forward(yaw): out through the front doorway

  // Stand 7 m out from the front doorway, facing it.
  await dbg(page, 'teleport', front.center.x + out.x * 7, front.center.z + out.z * 7);
  await look(page, front.yaw + Math.PI, -0.05);
  await expect(page.getByTestId('all-sealed')).toBeHidden();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/barriers-before.png` });

  await dbg(page, 'time', 899.6);
  await expect(page.getByTestId('storm-warn')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('all-sealed')).toBeVisible();
  await expect(page.getByTestId('all-sealed')).toHaveText('ALL BUNKERS SEALED');
  const s = await snap();
  expect(s.suddenDeath).toBe(true);
  expect(s.barrierAt).toBeGreaterThanOrEqual(900);
  expect(s.sealed.every(Boolean)).toBe(true);
  await page.waitForTimeout(500); // mid-landing: dust
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/barriers-drop.png` });
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/barriers-banner.png` });

  // No per-bunker seal lines: no SEALED kill-feed entries, no big "X's bunker is sealed" headline.
  await expect(page.locator('.feed-item.sealed')).toHaveCount(0);
  await expect(page.locator('.seal-announce.show')).toHaveCount(0);
  await expect(page.locator('.hud .killfeed')).toContainText('all bunkers sealed');
  expect(logs.some((l) => l.includes('[barriers]') && l.includes('dropped'))).toBe(true);

  // Close-up of the slab after the banner has gone.
  await page.waitForTimeout(4000);
  await dbg(page, 'hp', 100);
  await dbg(page, 'teleport', front.center.x + out.x * 4 + Math.cos(front.yaw) * 1.5, front.center.z + out.z * 4 - Math.sin(front.yaw) * 1.5);
  await look(page, front.yaw + Math.PI + 0.35, -0.12);
  await page.waitForTimeout(1200);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/barriers-closeup.png` });

  // Walk straight at the front doorway for 2 s: the slab stops me outside.
  await dbg(page, 'teleport', front.center.x + out.x * 2.6, front.center.z + out.z * 2.6);
  await look(page, front.yaw + Math.PI, 0);
  await page.keyboard.down('w');
  await page.waitForTimeout(2000);
  await page.keyboard.up('w');
  const p = await me();
  const d = Math.hypot(p.pos.x - home.bunker.center.x, p.pos.z - home.bunker.center.z);
  expect(d).toBeGreaterThan(2.6);
  expect(errors).toEqual([]);
});
