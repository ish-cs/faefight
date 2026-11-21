import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; alive: boolean; island: number; emote?: { id: string; at: number }; quip?: { id: string; at: number } };
type Snap = { time: number; players: P[] };
type Isl = { center: { x: number; z: number } };

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

const revealed = async (p: Page) => {
  await expect.poll(() => p.evaluate(() =>
    !(window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible()), { timeout: 60_000 }).toBe(true);
  await p.waitForTimeout(800);
};

/** Hold the wheel key, push the cursor (dx, dy) from the screen centre, release. */
async function pick(page: Page, dx: number, dy: number, shot?: string) {
  await page.keyboard.down('KeyT');
  await expect(page.getByTestId('emote-wheel')).toBeVisible();
  await page.mouse.move(640 + dx * 0.3, 360 + dy * 0.3);
  await page.mouse.move(640 + dx, 360 + dy);
  if (shot) await page.screenshot({ path: shot });
  await page.keyboard.up('KeyT');
  await expect(page.getByTestId('emote-wheel')).toBeHidden();
}

test('emote wheel: quick chat "GG" lands in chat; Wave sets the emote state (third person even in first person)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await revealed(page);
  const humanId = await dbg<number>(page, 'humanId');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  // Somewhere open, standing still.
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  await dbg(page, 'teleport', home.center.x + 2, home.center.z + 2);
  await page.waitForTimeout(500);

  // Esc / releasing in the middle sends nothing.
  await page.keyboard.down('KeyT');
  await expect(page.getByTestId('emote-wheel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('emote-wheel')).toBeHidden();
  await page.keyboard.up('KeyT');

  // GG sits straight up (slot 0).
  await pick(page, 0, -110, SHOTS ? 'docs/screens/emotes-wheel.png' : undefined);
  await expect.poll(async () => (await dbg<string[]>(page, 'chatLines')).some((l) => /GG$/.test(l ?? '')), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await me()).quip?.id).toBe('gg');
  if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: 'docs/screens/emotes-quickchat.png' }); }

  // A second pick within 2 s is refused (client hint + host/sim limit).
  await pick(page, 110, -110);
  await page.waitForTimeout(400);
  expect((await me()).emote).toBeUndefined();

  // First person on: the emote still shows our own avatar in third person.
  await page.keyboard.press('KeyV');
  expect(await dbg<string>(page, 'cameraMode')).toBe('first');
  await page.waitForTimeout(1800);
  // Wave sits up-right (slot 1).
  await pick(page, 110, -110);
  await expect.poll(async () => (await me()).emote?.id, { timeout: 5000 }).toBe('wave');
  await expect.poll(async () => (await dbg<{ selfVisible: boolean }>(page, 'spectator')).selfVisible).toBe(true);
  if (SHOTS) { await page.waitForTimeout(700); await page.screenshot({ path: 'docs/screens/emotes-wave.png' }); }

  // Moving cancels it; the camera goes back to first person.
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await me()).emote).toBeUndefined();
  await page.keyboard.up('KeyW');
  await expect.poll(async () => (await dbg<{ selfVisible: boolean }>(page, 'spectator')).selfVisible).toBe(false);
  await page.keyboard.press('KeyV');

  expect(errors).toEqual([]);
});
