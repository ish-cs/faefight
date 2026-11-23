import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// Pieces placed while moving are solid where they show: a ramp dropped in front of you while running holds you as
// you run up it, and a shore bridge deck holds you as you walk out and stand on it. Neither the predicted nor the
// host position sinks through, and the host never refuses what the client showed.

type V = { x: number; y: number; z: number };
type Piece = { id: number; kind: string; owner: number; pos: V; rotY: number };
type Snap = { players: { id: number; island: number; pos: V; alive: boolean }[]; pieces: Piece[]; time: number };
type Isl = { index: number; center: V; radius: number; groundY: number; bunker: { facingYaw: number } };
type Aim = { kind: string; tag: string; ghost: V; ok: boolean } | null;
type Track = { pred: number; host: number; predN: number; hostN: number; predMax: number; hostMax: number };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);
const fwd = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const rgt = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });
const at = (c: V, f: { x: number; z: number }, a: number, r: { x: number; z: number }, b: number, y = c.y): V =>
  ({ x: c.x + f.x * a + r.x * b, y, z: c.z + f.z * a + r.z * b });

async function start(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(() => dbg<{ active: boolean }>(page, 'predicted').then((p) => p.active), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefight: { input: { enabled: boolean } } }).__faefight.input.enabled), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(640, 360)?.tagName), { timeout: 30_000 }).toBe('CANVAS');
  const humanId = await dbg<number>(page, 'humanId');
  const me = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[me.island];
  // Keep the crosshair on window.__aimT every frame; while window.__zone is set, track the predicted and host feet
  // inside it (lowest and highest y).
  await page.evaluate((hid) => {
    const w = window as unknown as Record<string, unknown> & { __faefight: Record<string, unknown> };
    const api = w.__faefight as { renderer: { camera: { position: V } }; input: { yaw: number; pitch: number };
      predicted(): { pos: V | null }; snapshot(): Snap | null };
    const loop = () => {
      const t = w.__aimT as V | undefined;
      if (t) {
        const c = api.renderer.camera.position;
        const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z;
        api.input.yaw = Math.atan2(-dx, -dz);
        api.input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      const z = w.__zone as { c: V; r: number } | undefined;
      if (z) {
        const inside = (p: V) => Math.hypot(p.x - z.c.x, p.z - z.c.z) < z.r;
        const pp = api.predicted().pos, hp = api.snapshot()?.players.find((p) => p.id === hid)?.pos;
        const k = w.__track as Track;
        if (pp && inside(pp)) { k.pred = Math.min(k.pred, pp.y); k.predMax = Math.max(k.predMax, pp.y); k.predN++; }
        if (hp && inside(hp)) { k.host = Math.min(k.host, hp.y); k.hostMax = Math.max(k.hostMax, hp.y); k.hostN++; }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, humanId);
  await page.mouse.click(640, 360); // pointer lock (fists: a harmless punch)
  return { humanId, home, errors };
}

const aimAt = async (page: Page, t: V) => {
  await page.evaluate((v) => { (window as unknown as { __aimT: V }).__aimT = v; }, t);
  await page.waitForTimeout(250);
};
const aim = (page: Page) => dbg<Aim>(page, 'buildAim');
const mine = async (page: Page, humanId: number, kind: string) =>
  (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId && p.kind === kind).sort((a, b) => b.id - a.id);
const track = (page: Page, zone: { c: V; r: number } | null) => page.evaluate((z) => {
  const w = window as unknown as Record<string, unknown>;
  w.__zone = z ?? undefined;
  if (z) w.__track = { pred: Infinity, host: Infinity, predN: 0, hostN: 0, predMax: -Infinity, hostMax: -Infinity };
  return w.__track as Track;
}, zone);
const refused = (page: Page) => dbg<{ rejected: number }>(page, 'buildPredict').then((b) => b.rejected);

test('placed while moving, solid where shown: run up a ramp dropped in front of you; walk out onto a shore deck and stand', async ({ page }) => {
  const { humanId, home, errors } = await start(page);
  const fy = home.bunker.facingYaw, F = fwd(fy), R = rgt(fy);
  const C = { ...home.center, y: home.groundY };
  await dbg(page, 'give', { pieces: { ramp: 1 } });

  // 1) Ramp: run sideways across the island, aiming at the ground ~3.5 m ahead; place it mid-run and keep running.
  await page.keyboard.press('Digit2'); // slot 1 holds the starting pistol
  await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(C, R, -10, F, -4)));
  await page.waitForTimeout(300);
  const hold = { x: R.x, z: R.z };
  await page.evaluate(([h, c]) => {
    // aim point keeps 3.5 m ahead of the predicted feet along the run
    const w = window as unknown as Record<string, unknown> & { __faefight: { predicted(): { pos: V | null } } };
    const step = () => { const p = w.__faefight.predicted().pos; if (p && w.__runAim) w.__aimT = { x: p.x + h.x * 3.5, y: c, z: p.z + h.z * 3.5 }; requestAnimationFrame(step); };
    w.__runAim = true;
    requestAnimationFrame(step);
  }, [hold, C.y] as const);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(500);
  await expect.poll(async () => (await aim(page))?.ok, { timeout: 5000, intervals: [20] }).toBe(true);
  const before = await refused(page);
  await page.mouse.click(640, 360);
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__runAim = false; });
  await expect.poll(async () => (await mine(page, humanId, 'ramp')).length, { timeout: 5000 }).toBe(1);
  const ramp = (await mine(page, humanId, 'ramp'))[0];
  await track(page, { c: ramp.pos, r: 1.0 });
  await page.waitForTimeout(1200); // still running: up and over it
  await page.keyboard.up('KeyW');
  const onRamp = await track(page, null);
  expect(await refused(page), 'the host refused the ramp the client showed').toBe(before);
  expect(onRamp.predN).toBeGreaterThan(3);
  expect(onRamp.hostN).toBeGreaterThan(1);
  expect(onRamp.predMax - ramp.pos.y, 'predicted: ran up the ramp').toBeGreaterThan(0.4);
  expect(onRamp.hostMax - ramp.pos.y, 'host: ran up the ramp').toBeGreaterThan(0.4);

  // 2) Off the shore: the assist's first bridge segment, then walk out onto it and stand 3 s.
  await dbg(page, 'give', { pieces: { scaffold: 1 } });
  await page.keyboard.press('Digit2'); // slot 1 holds the starting pistol
  await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(C, R, home.radius - 2.5, F, 0)));
  await aimAt(page, at(C, R, home.radius + 2, F, 0, 0));
  await expect.poll(async () => { const a = await aim(page); return a?.ok && a.tag; }).toBe('shore');
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await mine(page, humanId, 'scaffold')).length, { timeout: 10_000 }).toBe(1);
  const deck = (await mine(page, humanId, 'scaffold'))[0];
  await aimAt(page, at(deck.pos, R, 12, R, 0, deck.pos.y + 1.5));
  await page.keyboard.down('KeyW');
  await expect.poll(async () => {
    const p = (await dbg<{ pos: V }>(page, 'predicted')).pos;
    return (p.x - deck.pos.x) * R.x + (p.z - deck.pos.z) * R.z;
  }, { timeout: 8000, intervals: [30] }).toBeGreaterThan(-0.3);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(400);
  await track(page, { c: deck.pos, r: 1.6 });
  await page.waitForTimeout(3000);
  const onDeck = await track(page, null);
  const top = deck.pos.y + 0.2;
  expect(onDeck.predN).toBeGreaterThan(30);
  expect(onDeck.hostN).toBeGreaterThan(10);
  expect(onDeck.pred, `predicted feet sank below the deck (top ${top})`).toBeGreaterThan(top - 0.05);
  expect(onDeck.host, `host feet sank below the deck (top ${top})`).toBeGreaterThan(top - 0.05);
  expect(errors, errors.join('\n')).toEqual([]);
});
