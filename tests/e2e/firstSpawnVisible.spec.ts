import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

const SHOTS = process.env.FSV_SHOTS ?? 'test-results';

type Api = Record<string, (...x: unknown[]) => unknown>;
const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Api }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type Sample = { t: number; shown: boolean; meshes: number; group: boolean };
type LoadEvent = { kind: string; t: number };

/**
 * The own avatar on the first spawn, in third person (the default): the loading warm-up shows every hidden
 * mesh for a few frames and hides them again, and a body LOD switch during those frames (the first frame
 * picked the far LOD) left the local player's body hidden for good — "invisible in third person".
 */
test('own avatar is drawn in third person from the first second, after a respawn, and every other avatar too', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  // Every animation frame from page start: is the local body drawn (avatar shown and one body LOD mesh visible)?
  await page.addInitScript(() => {
    const w = window as unknown as { __self: Sample[]; __faefight?: Api };
    w.__self = [];
    const f = () => {
      const api = w.__faefight;
      const id = api?.snapshot?.() ? (api.humanId() as number) : -1;
      const a = id >= 0 ? (api!.renderer as unknown as { characters: { avatars: Map<number, { group: { visible: boolean }; body: { lods: { visible: boolean }[] } | null }> } })
        .characters.avatars.get(id) : undefined;
      if (a?.body) {
        const meshes = a.body.lods.filter((m) => m.visible).length;
        w.__self.push({ t: performance.now(), shown: a.group.visible && meshes === 1, meshes, group: a.group.visible });
      }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 45_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 30_000 });
  expect(await dbg<string>(page, 'cameraMode')).toBe('third');
  await page.waitForTimeout(2000);

  // Shown from within the first second after the reveal, and on every frame after that.
  const ev = await page.evaluate(() => (window as unknown as { __faefightLoading: { events(): LoadEvent[] } }).__faefightLoading.events());
  const hideAt = ev.filter((e) => e.kind === 'hide').at(-1)!.t;
  const after = (await page.evaluate(() => (window as unknown as { __self: Sample[] }).__self)).filter((s) => s.t >= hideAt);
  expect(after.length).toBeGreaterThan(30);
  const firstShown = after.find((s) => s.shown);
  expect(firstShown, `never drawn after the reveal: ${JSON.stringify(after.slice(-3))}`).toBeTruthy();
  expect(firstShown!.t - hideAt).toBeLessThan(1000);
  const hidden = after.filter((s) => s.t > hideAt + 1000 && !s.shown);
  expect(hidden, `own avatar hidden on ${hidden.length} frames: ${JSON.stringify(hidden.slice(0, 3))}`).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/first-spawn-third-person.png` });
  expect(await selfPixels(page), 'own avatar not on screen (pixel check)').toBeGreaterThan(400);

  // Everyone else's avatar as this client draws it: one body LOD mesh each (the same warm-up path).
  const others = await page.evaluate(() => {
    const api = (window as unknown as { __faefight: Api }).__faefight;
    const avs = (api.renderer as unknown as { characters: { avatars: Map<number, { group: { visible: boolean }; body: { lods: { visible: boolean }[] } | null }> } }).characters.avatars;
    return [...avs.entries()].filter(([, a]) => a.group.visible && a.body).map(([id, a]) => ({ id, meshes: a.body!.lods.filter((m) => m.visible).length }));
  });
  expect(others.length).toBeGreaterThan(1);
  for (const o of others) expect(o.meshes, `player ${o.id}`).toBe(1);

  // Respawn: drawn again (spawn protection blinks the model, the body mesh stays on), still on screen.
  const me = await dbg<number>(page, 'humanId');
  await dbg(page, 'kill', me, me);
  await expect.poll(async () => (await dbg<{ players: { id: number; alive: boolean }[] }>(page, 'snapshot')).players.find((p) => p.id === me)!.alive,
    { timeout: 20_000 }).toBe(false);
  await expect.poll(async () => (await dbg<{ players: { id: number; alive: boolean }[] }>(page, 'snapshot')).players.find((p) => p.id === me)!.alive,
    { timeout: 20_000 }).toBe(true);
  const back = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1500);
  const resp = (await page.evaluate(() => (window as unknown as { __self: Sample[] }).__self)).filter((s) => s.t >= back);
  const r1 = resp.find((s) => s.shown);
  expect(r1, 'never drawn after the respawn').toBeTruthy();
  expect(r1!.t - back).toBeLessThan(1000);
  expect(resp.filter((s) => s.t > back + 1000 && !s.shown)).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/respawn-third-person.png` });
  expect(await selfPixels(page), 'own avatar not on screen after the respawn (pixel check)').toBeGreaterThan(400);
  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * Pixels the own body changes on screen: screenshot as drawn vs with its body meshes hidden for a few frames,
 * diffed inside the avatar's projected box. Spawn protection blinks the model, so a few tries; best one wins.
 */
async function selfPixels(page: Page): Promise<number> {
  let best = 0;
  for (let i = 0; i < 4 && best <= 400; i++) {
    const box = await page.evaluate(() => {
      const api = (window as unknown as { __faefight: Api }).__faefight;
      const r = api.renderer as unknown as { camera: { updateMatrixWorld(): void }; characters: { avatars: Map<number, { group: { position: { clone(): { y: number; project(c: unknown): { x: number; y: number } } } } }> } };
      const a = r.characters.avatars.get(api.humanId() as number)!;
      r.camera.updateMatrixWorld();
      const pts = [0.1, 0.9, 1.7].map((h) => { const p = a.group.position.clone(); p.y += h; return p.project(r.camera); });
      const xs = pts.map((p) => (p.x + 1) / 2 * innerWidth), ys = pts.map((p) => (1 - p.y) / 2 * innerHeight);
      const pad = 60;
      return { x0: Math.max(0, Math.min(...xs) - pad), x1: Math.min(innerWidth, Math.max(...xs) + pad), y0: Math.max(0, Math.min(...ys) - pad / 2), y1: Math.min(innerHeight, Math.max(...ys) + pad / 2) };
    });
    const shown = (await page.screenshot()).toString('base64');
    await setBody(page, false);
    await page.waitForTimeout(150);
    const gone = (await page.screenshot()).toString('base64');
    await setBody(page, true);
    best = Math.max(best, await page.evaluate(async ([a, b, bx]) => {
      const load = async (s: string) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height);
      };
      const [p, q] = [await load(a), await load(b)];
      const { x0, x1, y0, y1 } = bx as { x0: number; x1: number; y0: number; y1: number };
      let n = 0;
      for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) {
        const k = (y * p.width + x) * 4;
        if (Math.abs(p.data[k] - q.data[k]) + Math.abs(p.data[k + 1] - q.data[k + 1]) + Math.abs(p.data[k + 2] - q.data[k + 2]) > 60) n++;
      }
      return n;
    }, [shown, gone, box] as const));
  }
  return best;
}

/** Hide / re-show the own body meshes (the LOD cache re-applies the right one on the next frame). */
const setBody = (page: Page, on: boolean) => page.evaluate((show) => {
  const api = (window as unknown as { __faefight: Api }).__faefight;
  const ch = (api.renderer as unknown as { characters: { relod(): void; avatars: Map<number, { body: { lods: { visible: boolean }[] } }> } }).characters;
  if (show) ch.relod();
  else for (const m of ch.avatars.get(api.humanId() as number)!.body.lods) m.visible = false;
}, on);
