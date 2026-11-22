import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

// Eliminated by a player: the killcam, then the end screen with the death recap. Every block of that
// screen (title, subtitle, recap card, buttons) must sit apart and stay clickable at common window sizes,
// and only one state's hints show at a time (no free-fly hint under the end screen or the killcam).
test.skip(ON_CI, NEEDS_GPU); // plays a match

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; alive: boolean; pos: { x: number; z: number } };
type Snap = { players: P[] };
type Box = { x: number; y: number; width: number; height: number };

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;
const SIZES = [
  { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 },
  { width: 1024, height: 640 }, { width: 800, height: 600 },
];

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function box(page: Page, sel: string): Promise<Box> {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, `${sel} has a box`).not.toBeNull();
  return b!;
}

/** Title, subtitle, recap and buttons: all visible, none overlapping, all on screen, buttons hit-testable. */
async function checkLayout(page: Page, tag: string) {
  const parts = {
    title: '[data-testid="end-screen"] .end-title',
    sub: '[data-testid="end-screen"] .end-sub',
    recap: '[data-testid="death-recap"]',
    buttons: '[data-testid="end-screen"] .end-buttons',
  };
  for (const sel of Object.values(parts)) await expect(page.locator(sel).first(), `${tag}: ${sel}`).toBeVisible();
  const boxes = Object.fromEntries(await Promise.all(Object.entries(parts).map(async ([k, s]) => [k, await box(page, s)] as const)));
  const vp = page.viewportSize()!;
  const keys = Object.keys(boxes);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++)
      expect(overlaps(boxes[keys[i]], boxes[keys[j]]), `${tag}: ${keys[i]} overlaps ${keys[j]} ${JSON.stringify(boxes)}`).toBe(false);
  }
  // Stacked in reading order: title, subtitle, recap, buttons.
  expect(boxes.title.y + boxes.title.height, tag).toBeLessThanOrEqual(boxes.sub.y);
  expect(boxes.sub.y + boxes.sub.height, tag).toBeLessThanOrEqual(boxes.recap.y);
  expect(boxes.recap.y + boxes.recap.height, tag).toBeLessThanOrEqual(boxes.buttons.y);
  for (const b of [boxes.recap, boxes.buttons]) {
    expect(b.x, tag).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, tag).toBeLessThanOrEqual(vp.width);
  }
  // Buttons on screen and on top: the element under each button's centre is that button.
  for (const id of ['spectate', 'back-to-menu']) {
    const btn = page.getByTestId(id);
    await btn.scrollIntoViewIfNeeded();
    const b = (await btn.boundingBox())!;
    expect(b.y + b.height, `${tag}: ${id} below the fold`).toBeLessThanOrEqual(vp.height);
    const hit = await page.evaluate(([x, y, t]) => {
      const e = document.elementFromPoint(x as number, y as number);
      return !!e?.closest(`[data-testid="${t}"]`);
    }, [b.x + b.width / 2, b.y + b.height / 2, id] as const);
    expect(hit, `${tag}: ${id} is covered`).toBe(true);
  }
  // Only the end screen's own controls: no spectator hint under it.
  await expect(page.getByTestId('spectate-banner'), tag).toBeHidden();
}

async function eliminatedByBot(page: Page) {
  await page.goto('/?debug=1');
  await page.getByTestId('bots-2').click(); // 3 players: being out doesn't end the match
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() =>
    !(window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible()), { timeout: 60_000 }).toBe(true);
  const me = await dbg<number>(page, 'humanId');
  const snap = await dbg<Snap>(page, 'snapshot');
  const bot = snap.players.find((p) => p.id !== me)!.id;
  await expect.poll(async () => (await dbg<{ frames: number }>(page, 'killcam')).frames, { timeout: 15_000 }).toBeGreaterThan(90);
  // Some damage on record first, so the recap card has its "damage taken" rows (as in a real fight).
  await dbg(page, 'hp', 100);
  const at = snap.players.find((p) => p.id === me)!.pos;
  await dbg(page, 'explode', 'grenade', at.x + 3.5, at.z);
  await page.waitForTimeout(400);
  // Killed by the bot and out for good (as when your bunker is sealed).
  await dbg(page, 'kill', me, bot);
  await dbg(page, 'eliminate', me);
  return { me, bot };
}

test('eliminated: killcam, then title / subtitle / recap / buttons apart at common sizes; one set of hints at a time', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize(SIZES[0]);
  await eliminatedByBot(page);

  // Killcam: its own banner; the recap sits aside; no spectator free-fly hint.
  const kc = page.getByTestId('killcam');
  const recap = page.getByTestId('death-recap');
  if (await kc.isVisible()) {
    await expect(recap).toBeVisible();
    await expect(page.getByTestId('spectate-banner')).toBeHidden();
    expect(overlaps(await box(page, '[data-testid="killcam"]'), await box(page, '[data-testid="death-recap"]'))).toBe(false);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/elim-killcam-1280x720.png` });
    await page.keyboard.press('Space');
  }
  await expect(page.getByTestId('end-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.end-title')).toHaveText('ELIMINATED');
  await expect(recap).toContainText('Killed by');
  await page.waitForTimeout(700); // title slam animation settles

  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/elim-${size.width}x${size.height}.png` });
    await checkLayout(page, `${size.width}x${size.height}`);
  }

  // Spectate: the end screen (and the recap with it) goes, the free-fly hint comes.
  await page.setViewportSize(SIZES[0]);
  await page.getByTestId('spectate').click();
  await expect(page.getByTestId('end-screen')).toBeHidden();
  await expect(recap).toBeHidden();
  await expect(page.getByTestId('spectate-banner')).toBeVisible();
  await expect(page.getByTestId('spectate-banner')).toContainText('SPECTATING');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/elim-spectating-1280x720.png` });
  expect(errors).toEqual([]);
});

test.describe('retina', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
  test('eliminated end screen at 2x: no overlap, buttons clickable', async ({ page }) => {
    await eliminatedByBot(page);
    if (await page.getByTestId('killcam').isVisible()) await page.keyboard.press('Space');
    await expect(page.getByTestId('end-screen')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(700);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/elim-1440x900@2x.png` });
    await checkLayout(page, '1440x900@2x');
    await page.getByTestId('back-to-menu').click();
    await expect(page.getByTestId('play-medium')).toBeVisible({ timeout: 15_000 });
  });
});
