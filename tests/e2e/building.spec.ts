import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// Building: the ghost follows the crosshair (or snaps to a smart spot nearby), its colour is computed
// locally every frame, and whatever is placed lands exactly where the ghost showed.

type V = { x: number; y: number; z: number };
type Piece = { id: number; kind: string; owner: number; pos: V; rotY: number };
type Snap = { players: { id: number; island: number; pos: V; busyUntil: number }[]; pieces: Piece[]; time: number };
type Isl = { index: number; center: V; radius: number; groundY: number; bunker: { facingYaw: number; doorways: { center: V; yaw: number }[] } };
type Aim = { kind: string; tag: string; ghost: V; rotY: number; ok: boolean; reason: string | null; req: { kind: string; pos: V; rotY: number; free: boolean } | null };
type Logged = { req: { pos: V; rotY: number }; aim: Aim };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

const fwd = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const rgt = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });
const at = (c: V, f: { x: number; z: number }, a: number, r: { x: number; z: number }, b: number, y = c.y): V =>
  ({ x: c.x + f.x * a + r.x * b, y, z: c.z + f.z * a + r.z * b });
const d2 = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z);

async function start(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(() => dbg<{ active: boolean }>(page, 'predicted').then((p) => p.active), { timeout: 15_000 }).toBe(true);
  // Input stays off until the loading screen (shader warm-up) is gone.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefight: { input: { enabled: boolean } } }).__faefight.input.enabled), { timeout: 30_000 }).toBe(true);
  // ...and clicks reach the game canvas only once the loading overlay has gone.
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(640, 360)?.tagName), { timeout: 30_000 }).toBe('CANVAS');
  const humanId = await dbg<number>(page, 'humanId');
  const me = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const map = await dbg<Isl[]>(page, 'map');
  // Keep the crosshair on window.__aimT every frame (yaw/pitch from the camera to the target), and log
  // every build request with the ghost that was showing when it was sent.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { __faefight: Record<string, unknown> };
    const api = w.__faefight as { renderer: { camera: { position: V } }; input: { yaw: number; pitch: number; queue: (p: { build?: unknown }) => void }; buildAim: () => unknown };
    const builds: unknown[] = [];
    w.__builds = builds;
    const q = api.input.queue.bind(api.input);
    api.input.queue = (p) => { if (p.build) builds.push({ req: JSON.parse(JSON.stringify(p.build)), aim: JSON.parse(JSON.stringify(api.buildAim())) }); q(p); };
    const loop = () => {
      const t = w.__aimT as V | undefined;
      if (t) {
        const c = api.renderer.camera.position;
        const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z;
        api.input.yaw = Math.atan2(-dx, -dz);
        api.input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.mouse.click(640, 360); // pointer lock (fists: a harmless punch)
  return { humanId, home: map[me.island], enemy: map.find((i) => i.index !== me.island)!, errors };
}

const aimAt = async (page: Page, t: V) => {
  await page.evaluate((v) => { (window as unknown as { __aimT: V }).__aimT = v; }, t);
  await page.waitForTimeout(250);
};
const aim = (page: Page) => dbg<Aim | null>(page, 'buildAim');
const mine = async (page: Page, humanId: number, kind: string) =>
  (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId && p.kind === kind);
const builds = (page: Page) => page.evaluate(() => (window as unknown as { __builds: Logged[] }).__builds);

/** Every placed piece sits exactly where the ghost showed when its request was sent. */
async function expectPlacedAsShown(page: Page, pieces: Piece[]) {
  const log = await builds(page);
  for (const p of pieces) {
    const b = log.find((l) => Math.abs(l.req.pos.x - p.pos.x) < 1e-6 && Math.abs(l.req.pos.z - p.pos.z) < 1e-6 && Math.abs(l.aim.ghost.y - p.pos.y) < 0.01);
    expect(b, `piece ${p.id} at ${JSON.stringify(p.pos)} matches a sent ghost`).toBeTruthy();
    expect(b!.aim.ok).toBe(true);
    expect(d2(b!.aim.ghost, p.pos)).toBeLessThan(1e-6);
    expect(Math.abs(b!.aim.ghost.y - p.pos.y)).toBeLessThan(0.01);
    expect(Math.abs(b!.req.rotY - p.rotY)).toBeLessThan(1e-6);
  }
}

test('drag-build: holding click lays a straight, flush wall line of 5 exactly where the ghost shows', async ({ page }) => {
  const { humanId, home, errors } = await start(page);
  const fy = home.bunker.facingYaw, F = fwd(fy), R = rgt(fy);
  const C = { ...home.center, y: home.groundY };
  await dbg(page, 'give', { pieces: { wood: 5 } });
  await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(C, F, -3.5, R, 0)));
  await page.keyboard.press('Digit1');
  await aimAt(page, at(C, F, 0, R, 0, C.y + 0.3));
  await expect.poll(async () => (await aim(page))?.ok).toBe(true);
  await page.screenshot({ path: 'test-results/build-wall-ghost.png' });
  await page.mouse.down();
  for (let i = 1; i < 5; i++) {
    await expect.poll(async () => (await mine(page, humanId, 'wood')).length, { timeout: 10_000 }).toBe(i);
    // Walk along the line (teleport) and keep aiming at the ground where the next wall goes.
    const last = (await mine(page, humanId, 'wood')).sort((a, b) => b.id - a.id)[0];
    const next = at(last.pos, F, 0, R, 2);
    await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(next, F, -3.5, R, 0)));
    await aimAt(page, { ...next, y: C.y + 0.3 });
    if (i === 2) await page.screenshot({ path: 'test-results/build-wall-drag.png' });
  }
  await expect.poll(async () => (await mine(page, humanId, 'wood')).length, { timeout: 10_000 }).toBe(5);
  await page.mouse.up();

  const walls = (await mine(page, humanId, 'wood')).sort((a, b) => a.id - b.id);
  // The line runs along the first wall (its rotation is the view yaw snapped to 15°).
  const L = rgt(walls[0].rotY), N = fwd(walls[0].rotY);
  const along = (p: V) => Math.abs((p.x - walls[0].pos.x) * L.x + (p.z - walls[0].pos.z) * L.z);
  const across = (p: V) => (p.x - walls[0].pos.x) * N.x + (p.z - walls[0].pos.z) * N.z;
  walls.forEach((w, i) => {
    expect(Math.abs(Math.sin(w.rotY - walls[0].rotY))).toBeLessThan(1e-6);
    expect(along(w.pos)).toBeCloseTo(2 * i, 3); // flush: 2 m wide walls, centres 2 m apart
    expect(across(w.pos)).toBeCloseTo(0, 3);
  });
  await expectPlacedAsShown(page, walls);
  await page.screenshot({ path: 'test-results/build-wall-line.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('scaffold bridge: 4 segments off the shore, aiming slightly off the line, all level and in line', async ({ page }) => {
  const { humanId, home, errors } = await start(page);
  const fy = home.bunker.facingYaw, F = fwd(fy), R = rgt(fy);
  const yaw = Math.atan2(-R.x, -R.z); // face out along R
  const C = { ...home.center, y: home.groundY };
  await dbg(page, 'give', { pieces: { scaffold: 4 } });
  await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(C, R, home.radius - 2.5, F, 0)));
  await page.keyboard.press('Digit1');
  // Look at the water ~1 m to the side of straight out: the assist offers the first segment off the shore.
  await aimAt(page, at(C, R, home.radius + 2, F, 1, 0));
  await expect.poll(async () => { const a = await aim(page); return a?.ok && a.tag; }).toBe('shore');
  await page.screenshot({ path: 'test-results/build-bridge-shore.png' });
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await mine(page, humanId, 'scaffold')).length, { timeout: 10_000 }).toBe(1);

  for (let n = 2; n <= 4; n++) {
    const last = (await mine(page, humanId, 'scaffold')).sort((a, b) => b.id - a.id)[0];
    const deckAxis = fwd(last.rotY);
    const sign = Math.sign((last.pos.x - C.x) * deckAxis.x + (last.pos.z - C.z) * deckAxis.z) || 1;
    const out = { x: deckAxis.x * sign, z: deckAxis.z * sign };
    // Walk out onto the newest deck (hold W while looking out along the bridge).
    const stand = at(last.pos, out, 1, R, 0);
    await aimAt(page, at(stand, out, 10, R, 0, C.y));
    await page.keyboard.down('KeyW');
    await expect.poll(async () => {
      const p = (await dbg<{ pos: V }>(page, 'predicted')).pos;
      return (p.x - stand.x) * out.x + (p.z - stand.z) * out.z;
    }, { timeout: 8000, intervals: [30] }).toBeGreaterThan(-0.3);
    await page.keyboard.up('KeyW');
    // Aim at the water past the end, 0.9 m off the bridge line.
    const side = { x: -out.z, z: out.x };
    await aimAt(page, at(last.pos, out, 5, side, 0.9, 0));
    await expect.poll(async () => { const a = await aim(page); return a?.ok && a.tag; }, { timeout: 10_000 }).toBe('bridge');
    if (n === 3) await page.screenshot({ path: 'test-results/build-bridge-continue.png' });
    await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!.busyUntil
      <= (await dbg<Snap>(page, 'snapshot')).time).toBe(true);
    await page.mouse.click(640, 360);
    await expect.poll(async () => (await mine(page, humanId, 'scaffold')).length, { timeout: 10_000 }).toBe(n);
  }
  const decks = (await mine(page, humanId, 'scaffold')).sort((a, b) => a.id - b.id);
  const ax = fwd(decks[0].rotY);
  decks.forEach((d, i) => {
    expect(d.pos.y).toBeCloseTo(decks[0].pos.y, 4);
    expect(Math.abs(Math.sin(d.rotY - decks[0].rotY))).toBeLessThan(1e-6);
    if (i) {
      const step = { x: d.pos.x - decks[i - 1].pos.x, z: d.pos.z - decks[i - 1].pos.z };
      expect(Math.abs(step.x * ax.x + step.z * ax.z)).toBeCloseTo(4, 3);
      expect(Math.abs(step.x * ax.z - step.z * ax.x)).toBeLessThan(1e-3);
    }
  });
  await expectPlacedAsShown(page, decks);
  await page.screenshot({ path: 'test-results/build-bridge.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('stacked sandbags, an enemy doorway plug when aiming beside it, and the ghost colour always agrees with the sim', async ({ page }) => {
  const { humanId, home, enemy, errors } = await start(page);
  const fy = home.bunker.facingYaw, F = fwd(fy), R = rgt(fy);
  const C = { ...home.center, y: home.groundY };
  await dbg(page, 'give', { pieces: { sandbags: 4, wood: 1 } });
  await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(C, F, -3.5, R, 0)));
  await page.keyboard.press('Digit1');
  for (let i = 0; i < 3; i++) {
    await aimAt(page, at(C, F, 0, R, 0, C.y + i * 1.0 + 0.02));
    await expect.poll(async () => { const a = await aim(page); return !!a?.ok && (i === 0 || a.tag === 'stack'); }).toBe(true);
    if (i === 2) await page.screenshot({ path: 'test-results/build-stack-ghost.png' });
    await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!.busyUntil
      <= (await dbg<Snap>(page, 'snapshot')).time).toBe(true);
    await page.mouse.click(640, 360);
    await expect.poll(async () => (await mine(page, humanId, 'sandbags')).length, { timeout: 10_000 }).toBe(i + 1);
  }
  const bags = (await mine(page, humanId, 'sandbags')).sort((a, b) => a.id - b.id);
  bags.forEach((b, i) => {
    expect(d2(b.pos, bags[0].pos)).toBeLessThan(1e-6);
    expect(b.pos.y - bags[0].pos.y).toBeCloseTo(i * 1.0, 2);
  });
  await expectPlacedAsShown(page, bags);

  // Scripted sweep: at every aim the local ghost verdict matches the sim's own validation.
  await page.keyboard.press('Digit1');
  let checked = 0;
  for (let a = -1.2; a <= 1.2; a += 0.3)
    for (const dist of [1.5, 3, 4.5, 7]) {
      const t = at(at(C, F, -3.5, R, 0), { x: -Math.sin(fy + a), z: -Math.cos(fy + a) }, dist, R, 0, C.y + 0.1);
      await aimAt(page, t);
      const g = await aim(page);
      if (!g || g.reason === 'none left') continue;
      const req = g.req ?? { kind: g.kind, pos: g.ghost, rotY: g.rotY, free: true };
      const sim = await dbg<{ ok: boolean; pos?: V }>(page, 'serverPreview', req);
      expect(sim.ok, `aim ${a.toFixed(1)}/${dist}: ghost ${g.ok ? 'green' : `red (${g.reason})`} vs sim ${JSON.stringify(sim)}`).toBe(g.ok);
      if (g.ok) expect(d2(sim.pos!, g.ghost)).toBeLessThan(1e-6);
      checked++;
    }
  expect(checked).toBeGreaterThan(20);

  // Enemy bunker: aim a metre beside the doorway — the wall snaps into the doorway.
  const door = enemy.bunker.doorways[0];
  const out = fwd(door.yaw);
  await dbg(page, 'teleport', ...((p) => [p.x, p.z])(at(door.center, out, 3.2, R, 0)));
  await page.keyboard.press('Digit2');
  await aimAt(page, at(door.center, rgt(door.yaw), 1.0, out, 0, enemy.groundY + 0.6));
  await expect.poll(async () => { const a = await aim(page); return a?.ok && a.tag; }, { timeout: 10_000 }).toBe('door');
  await page.screenshot({ path: 'test-results/build-door-ghost.png' });
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await mine(page, humanId, 'wood')).length, { timeout: 10_000 }).toBe(1);
  const plug = (await mine(page, humanId, 'wood'))[0];
  expect(d2(plug.pos, door.center)).toBeLessThan(0.5);
  await expectPlacedAsShown(page, [plug]);
  expect(errors, errors.join('\n')).toEqual([]);
});
