import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; name: string; isBot: boolean; alive: boolean; island: number; reloadUntil: number;
  inv: { cash: number; weapons: Record<string, { mag: number; spare: number }>; pieces: Record<string, number> } };
type Snap = { time: number; players: P[]; winner: number | null; stats?: unknown[] };
type Isl = { center: { x: number; z: number }; shop: { x: number; z: number }; bunker: { facingYaw: number } };

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;
const snapOf = (p: Page) => dbg<Snap>(p, 'snapshot');

/** The loading screen has faded (screenshots show the game, not the loader). */
const revealed = async (p: Page) => {
  await expect.poll(() => p.evaluate(() =>
    !(window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible()), { timeout: 60_000 }).toBe(true);
  await p.waitForTimeout(800); // fade-out
};

function watchErrors(tag: string, p: Page, errors: string[]) {
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
}

async function startSolo(page: Page, opts: { bots?: number } = {}) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  if (opts.bots) await page.getByTestId(`bots-${opts.bots}`).click();
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await revealed(page);
  return dbg<number>(page, 'humanId');
}

test.describe.configure({ mode: 'serial' });

test('menu remembers difficulty + bot count; compass; Esc pauses vs bots; death recap', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  watchErrors('P', page, errors);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  // Segmented bot count (no dropdown); pick 3, then hard.
  await expect(page.getByTestId('bot-count')).toBeVisible();
  await expect(page.getByTestId('bots-1')).toHaveClass(/on/);
  await page.getByTestId('bots-3').click();
  if (SHOTS) { await revealed(page); await page.screenshot({ path: `${SHOTS}/qol-menu.png` }); }
  await page.getByTestId('play-hard').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await revealed(page);
  const me = await dbg<number>(page, 'humanId');
  expect((await snapOf(page)).players).toHaveLength(4);

  // Compass: other islands labelled with their owners' nicknames, plus home.
  const compass = page.getByTestId('compass');
  await expect(compass).toBeVisible();
  const bots = (await snapOf(page)).players.filter((p) => p.id !== me);
  await expect(compass.locator('.qc-marker.home')).toHaveCount(1);
  await expect(compass.locator('.qc-marker.island')).toHaveCount(3);
  for (const b of bots) await expect(compass).toContainText(b.name);

  // Esc (pointer released) pauses the world: sim time stops; Resume restarts it.
  await page.locator('canvas.game').click();
  await expect.poll(() => page.evaluate(() => !!document.pointerLockElement)).toBe(true);
  // Esc releases the pointer (the browser does that; synthetic key presses don't, so release it directly).
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByTestId('pause')).toBeVisible();
  await expect(page.getByTestId('pause')).toContainText('Match paused');
  await page.waitForTimeout(300);
  const t0 = (await snapOf(page)).time;
  await page.waitForTimeout(1200);
  expect((await snapOf(page)).time).toBe(t0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol-pause.png` });
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('pause')).toBeHidden();
  await expect.poll(async () => (await snapOf(page)).time).toBeGreaterThan(t0 + 0.5);

  // Death recap: walk off into the sea → "You drowned", gone again after respawn.
  // Open water just past the outer rim of our island (the map origin is the center island now).
  await page.evaluate(() => {
    const f = (window as any).__faefight; const id = f.humanId();
    const isl = f.map()[f.snapshot().players.find((p: any) => p.id === id).island];
    const d = Math.hypot(isl.center.x, isl.center.z), k = (d + isl.radius + 6) / d;
    f.teleport(isl.center.x * k, isl.center.z * k);
  });
  const recap = page.getByTestId('death-recap');
  await expect(recap).toBeVisible({ timeout: 15_000 });
  await expect(recap).toContainText('You drowned');
  await expect(recap).toContainText('Water');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol-recap.png` });
  await expect.poll(async () => (await snapOf(page)).players.find((p) => p.id === me)!.alive, { timeout: 15_000 }).toBe(true);
  await expect(recap).toBeHidden();

  // A fresh menu remembers hard + 3 bots.
  await page.goto('/?debug=1');
  await expect(page.getByTestId('play-hard')).toHaveClass(/primary/);
  await expect(page.getByTestId('play-medium')).not.toHaveClass(/primary/);
  await expect(page.getByTestId('bots-3')).toHaveClass(/on/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('combat QoL: ammo warnings, auto-reload, R on a full gun, Shift+click bulk buy, quick re-buy', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  watchErrors('P', page, errors);
  const humanId = await startSolo(page);
  const me = async () => (await snapOf(page)).players.find((p) => p.id === humanId)!;
  await page.locator('canvas.game').click();

  // Two rounds left and nothing spare: "Last rounds", the slot's count tinted.
  await dbg(page, 'give', { weapons: { pistol: { mag: 2, spare: 0 } } });
  await page.keyboard.press('Digit1');
  const warn = page.getByTestId('ammo-warning');
  await expect(warn).toHaveText('Last rounds');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-ammo', 'nospare');
  await expect(page.getByTestId('hotbar-slot-0')).toContainText(/[12]\/0/);
  // More ammo: still low in the mag ("Low ammo"); the slot is fine.
  await dbg(page, 'give', { weapons: { pistol: { mag: 0, spare: 24 } } });
  await expect(warn).toHaveText('Low ammo');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-ammo', '');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol-ammo.png` });

  // Firing the last rounds reloads on its own.
  for (let i = 0; i < 4 && (await me()).reloadUntil === 0; i++) { await page.mouse.down(); await page.waitForTimeout(250); await page.mouse.up(); await page.waitForTimeout(150); }
  await expect.poll(async () => { const p = await me(); return p.inv.weapons.pistol.mag === 12 || p.reloadUntil > 0; }).toBe(true);
  await expect.poll(async () => (await me()).inv.weapons.pistol.mag, { timeout: 10_000 }).toBe(12);
  await expect(warn).toBeHidden();
  // R tops up the chamber round (a tactical reload: 12 + 1); R on that full gun does nothing.
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await me()).inv.weapons.pistol.mag, { timeout: 10_000 }).toBe(13);
  await expect.poll(async () => (await me()).reloadUntil).toBe(0);
  const full = (await me()).inv.weapons.pistol;
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(400);
  expect((await me()).reloadUntil).toBe(0);
  expect((await me()).inv.weapons.pistol).toEqual(full);

  // Shop: Shift+click a piece buys 5; then the quick re-buy button / B buys it again.
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  await dbg(page, 'give', { cash: 1000 });
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await page.getByTestId('buy-wood').click({ modifiers: ['Shift'] });
  await expect.poll(async () => (await me()).inv.pieces.wood ?? 0).toBe(5);
  const quick = page.getByTestId('quick-buy');
  await expect(quick).toContainText('Wood');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol-shop.png` });
  await quick.click();
  await expect.poll(async () => (await me()).inv.pieces.wood ?? 0).toBe(6);
  await page.keyboard.press('KeyB');
  await expect.poll(async () => (await me()).inv.pieces.wood ?? 0).toBe(7);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('end screen: match summary with per-player stats and awards', async ({ page }) => {
  const errors: string[] = [];
  watchErrors('P', page, errors);
  const humanId = await startSolo(page);
  // Earn a little and build a piece so there's something to award.
  const me = async () => (await snapOf(page)).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  // Stand in the open between the bunker and the island centre, facing the centre, and drop a sandbag wall.
  const yaw = home.bunker.facingYaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  await dbg(page, 'teleport', home.center.x + fx * 4 + rx * 3, home.center.z + fz * 4 + rz * 3);
  await page.evaluate((y) => { const i = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input; i.yaw = y; i.pitch = -0.35; }, yaw);
  await dbg(page, 'give', { pieces: { sandbags: 1 } });
  await expect.poll(async () => (await me()).inv.pieces.sandbags ?? 0).toBe(1);
  await page.locator('canvas.game').click();
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('hotbar')).toHaveAttribute('data-ghost', 'ok', { timeout: 30_000 });
  await expect(async () => {
    if (((await me()).inv.pieces.sandbags ?? 0) > 0) await page.mouse.click(640, 360);
    await expect.poll(async () => (await me()).inv.pieces.sandbags ?? 0, { timeout: 1500 }).toBe(0);
  }).toPass({ timeout: 15_000 });

  const bot = (await snapOf(page)).players.find((p) => p.id !== humanId)!;
  await dbg(page, 'eliminate', bot.id);
  const end = page.getByTestId('end-screen');
  await expect(end).toBeVisible();
  const summary = page.getByTestId('match-summary');
  await expect(summary).toBeVisible();
  await expect(page.getByTestId(`summary-${humanId}`)).toContainText('You'.toLowerCase());
  await expect(page.getByTestId(`summary-${bot.id}`)).toContainText(bot.name);
  await expect(page.getByTestId('award-builder')).toContainText('You');
  await expect(summary.locator('th')).toContainText(['Kills', 'Deaths', 'Damage', 'Seals', 'Built', 'Cash', 'Longest life']);
  await expect(page.getByTestId('play-again')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol-summary.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('online: invite link, ?join= link, ping column, reconnect within the grace period', async ({ context }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  watchErrors('A', a, errors);
  watchErrors('B', b, errors);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await a.getByTestId('copy-invite').click();
  await expect(a.getByTestId('copy-invite')).toHaveText('Link copied');
  const link = await a.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`^http://localhost:\\d+/\\?net=local&debug=1&join=${code}$`));
  if (SHOTS) { await revealed(a); await a.screenshot({ path: `${SHOTS}/qol-lobby-invite.png` }); }

  // B opens the link: code filled, name focused; with the name typed it's one click.
  await b.goto(link);
  await expect(b.getByTestId('code-input')).toHaveValue(code);
  await expect(b.getByTestId('name-input')).toBeFocused();
  await b.keyboard.type('Bob');
  if (SHOTS) { await revealed(b); await b.screenshot({ path: `${SHOTS}/qol-join-link.png` }); }
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('start-match').click();
  const players = async (p: Page) => (await dbg<Snap | null>(p, 'snapshot'))?.players.length ?? 0;
  await expect.poll(() => players(b), { timeout: 30_000 }).toBe(2);
  await revealed(b);
  const bId = await dbg<number>(b, 'humanId');

  // Ping column (host shows "host", Bob a number of ms) and the host's tick health.
  await b.locator('canvas.game').focus();
  await expect.poll(async () => {
    await b.keyboard.down('Tab');
    const t = await b.getByTestId(`ping-${bId}`).textContent().catch(() => '');
    await b.keyboard.up('Tab');
    return t ?? '';
  }, { timeout: 15_000 }).toMatch(/^\d+ ms$/);
  await b.keyboard.down('Tab');
  await expect(b.getByTestId('ping-1')).toHaveText('host');
  await expect(b.getByTestId('scoreboard')).toContainText(/Host tick (ok|strained)/);
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/qol-ping.png` });
  await b.keyboard.up('Tab');

  // B's tab reloads mid-match: a bot holds the seat; B takes it back from the rejoin offer.
  await b.reload();
  await expect.poll(async () => (await dbg<Snap>(a, 'snapshot')).players.find((x) => x.id === bId)!.isBot, { timeout: 10_000 }).toBe(true);
  await expect(b.getByTestId('rejoin-offer')).toContainText(code);
  await expect(b.getByTestId('name-input')).toHaveValue('Bob');
  await b.getByTestId('join-game').click();
  await expect.poll(() => players(b), { timeout: 30_000 }).toBe(2);
  expect(await dbg<number>(b, 'humanId')).toBe(bId);
  await expect.poll(async () => (await dbg<Snap>(a, 'snapshot')).players.find((x) => x.id === bId)!.isBot, { timeout: 10_000 }).toBe(false);
  await expect(a.getByTestId('chat-feed')).toContainText('Bob reconnected');
  // And B controls it again: W moves B's player on the host.
  const posOn = async () => (await dbg<{ players: { id: number; pos: { x: number; z: number } }[] }>(a, 'snapshot')).players.find((x) => x.id === bId)!.pos;
  const p0 = await posOn();
  await b.bringToFront();
  await b.locator('canvas.game').focus();
  await b.keyboard.down('KeyW');
  await b.waitForTimeout(1000);
  await b.keyboard.up('KeyW');
  await expect.poll(async () => { const p1 = await posOn(); return Math.hypot(p1.x - p0.x, p1.z - p0.z); }).toBeGreaterThan(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
