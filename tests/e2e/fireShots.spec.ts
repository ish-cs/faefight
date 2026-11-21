import { expect, test, type Page } from '@playwright/test';

/**
 * Screenshots for docs/screens (not a regression test): SHOT_DIR=docs/screens SHOT_TAG=after pnpm e2e fireShots.
 * The impact half uses only long-standing debug hooks, so the same file run on an older build gives the "before".
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DIR = env.SHOT_DIR;
const TAG = env.SHOT_TAG ?? 'after';
test.skip(!DIR, 'set SHOT_DIR to take screenshots');

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);
const fps = (page: Page) => page.evaluate(() => new Promise<number>((res) => {
  let n = 0; const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res((n * 1000) / (performance.now() - t0)); };
  requestAnimationFrame(f);
}));
const gpu = async (page: Page) => {
  await dbg(page, 'resetFrames');
  await page.waitForTimeout(3000);
  const g = await dbg<{ n: number; avg: number; p95: number }>(page, 'gpuMs');
  return `gpu avg ${g.avg.toFixed(2)} ms p95 ${g.p95.toFixed(2)} ms (n ${g.n})`;
};
const yawTo = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
const aim = (page: Page, yaw: number, pitch: number) => page.evaluate(([y, p]) => {
  const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
  input.yaw = y; input.pitch = p;
}, [yaw, pitch] as const);

type Isl = { center: { x: number; z: number }; bunker: { facingYaw: number; center: { x: number; z: number } } };

test('impact and fire screenshots', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => localStorage.setItem('faefight.map', 'harbor'));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1&gputime=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);
  const humanId = await dbg<number>(page, 'humanId');
  const island = (await dbg<{ players: { id: number; island: number }[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!.island;
  const home = (await dbg<Isl[]>(page, 'map'))[island];
  const yaw = home.bunker.facingYaw;
  const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }, r = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const from = (c: { x: number; z: number }, d: number, side: number) => ({ x: c.x + f.x * d + r.x * side, z: c.z + f.z * d + r.z * side });
  const shoot = async (yw: number, p: number) => { await aim(page, yw, p); await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up(); await page.waitForTimeout(150); };

  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 200 } } });
  await page.locator('canvas.game').click();
  const slot = async () => (await dbg<{ players: { id: number; hotbar: (string | null)[] }[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!.hotbar.indexOf('rifle');
  await expect.poll(slot, { timeout: 5000 }).toBeGreaterThanOrEqual(0);
  await page.keyboard.press(`Digit${(await slot()) + 1}`);
  await page.keyboard.press('KeyV'); // first person
  await page.waitForTimeout(500);

  // 1. The bunker's back wall (concrete), from 5 m.
  const s1 = from(home.bunker.center, -5.4, 0.5);
  await dbg(page, 'teleport', s1.x, s1.z);
  await aim(page, yaw, 0.05);
  await page.waitForTimeout(800);
  const fps0 = await fps(page);
  const gpu0 = await gpu(page);
  for (let i = 0; i < 26; i++) await shoot(yaw + (((i * 7) % 13) - 6) * 0.045, -0.08 + ((i * 5) % 9) * 0.03);
  await aim(page, yaw, 0.05);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/impact-walls-${TAG}.png` });
  const fps1 = await fps(page);
  console.log(`[shots:${TAG}] same view, clean: ${fps0.toFixed(1)} fps, ${gpu0}; after 26 hits: ${fps1.toFixed(1)} fps, ${await gpu(page)}`);

  // 2. The ground: concrete slab, gravel path and sand bed toward the island middle.
  const s2 = from(home.center, 1.5, -2);
  await dbg(page, 'teleport', s2.x, s2.z);
  await page.waitForTimeout(300);
  for (let i = 0; i < 26; i++) await shoot(yaw + Math.PI + (((i * 7) % 13) - 6) * 0.07, -0.32 - ((i * 5) % 9) * 0.03);
  await aim(page, yaw + Math.PI, -0.42);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/impact-ground-${TAG}.png` });

  if (TAG !== 'after') return;
  // 3. Scorch + crater on the slab, and on the bunker wall.
  const c = from(home.center, -4, 6);
  await dbg(page, 'explode', 'rocket', c.x, c.z, 0.1);
  const bw = from(home.bunker.center, -3.2, -1.2);
  await dbg(page, 'explode', 'grenade', bw.x, bw.z, 0.9);
  const s3 = from(home.center, -4 + 5, 6 + 2.5);
  await dbg(page, 'teleport', s3.x, s3.z);
  await page.waitForTimeout(3500);
  await aim(page, yawTo(s3, c), -0.42);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${DIR}/impact-crater.png` });

  // 4. A wooden fort hit by a rocket: burning, then burnt down.
  const fc = from(home.center, 8, 6);
  const wy = yaw;
  for (const [d, side, rot] of [[1.1, 0, 0], [1.1, 2, 0], [1.1, -2, 0], [0, 3.1, Math.PI / 2], [0, -3.1, Math.PI / 2], [-1.1, 2, 0]] as const) {
    const p = from(fc, d, side);
    await dbg(page, 'place', 'wood', p.x, p.z, wy + rot);
  }
  const deck = from(fc, 0, -1);
  await dbg(page, 'place', 'scaffold', deck.x, deck.z, wy + Math.PI / 2, 2);
  const look = from(fc, -9, 4);
  await dbg(page, 'teleport', look.x, look.z);
  await aim(page, Math.atan2(-(fc.x - look.x), -(fc.z - look.z)), -0.05);
  await page.waitForTimeout(600);
  const blast = from(fc, 4.6, 0);
  await dbg(page, 'explode', 'grenade', blast.x, blast.z, 0.3);
  const fpsIdle = await fps(page);
  const gpuIdle = await gpu(page);
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${DIR}/fire-fort.png` });
  const fpsFire = await fps(page);
  const burning = (await dbg<{ pieces: { burning?: boolean }[] }>(page, 'snapshot')).pieces.filter((p) => p.burning).length;
  console.log(`[shots] fort view: before blast ${fpsIdle.toFixed(1)} fps, ${gpuIdle}; ${burning} pieces burning ${fpsFire.toFixed(1)} fps, ${await gpu(page)}`);
  await page.keyboard.press('KeyV'); // third person: the fort and the player
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${DIR}/fire-fort-late.png` });

  // 5. Grass fire on a bed (harbor local (-12.8, 9.6)).
  const gx = home.center.x + (-12.8) * Math.cos(yaw) + 9.6 * Math.sin(yaw), gz = home.center.z - (-12.8) * Math.sin(yaw) + 9.6 * Math.cos(yaw);
  await dbg(page, 'explode', 'grenade', gx, gz, 0.1);
  const gl = { x: gx + f.x * 7, z: gz + f.z * 7 };
  await dbg(page, 'teleport', gl.x, gl.z);
  await aim(page, Math.atan2(-(gx - gl.x), -(gz - gl.z)), -0.2);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${DIR}/fire-grass.png` });
});
