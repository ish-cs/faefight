import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

// Spike traps end to end (vs an easy bot): hold one, look at the ground in front, click: the trap is set where the
// ghost showed; the bot put on it takes the hit and the owner (me) never does. TRAP_SHOTS=1 saves screenshots to docs/screens.

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Player = { id: number; island: number; hp: number; shield: number; alive: boolean; pos: V; hotbar: (string | null)[]; inv: { traps: number } };
type Trap = { id: number; owner: number; pos: V; wall: boolean; fired: number };
type Snap = { players: Player[]; traps?: Trap[] };

const SHOTS = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TRAP_SHOTS;
const shot = (page: Page, name: string) => page.screenshot({ path: SHOTS ? `docs/screens/trap-${name}.png` : `test-results/trap-${name}.png` });

test('place a spike trap on the ground; an enemy on it gets hurt, I never do', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const def = await dbg<{ islands: { center: V }[] }>(page, 'mapDef');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const island = (await me()).island;
  const c = def.islands[island].center;

  await dbg(page, 'give', { traps: 1 });
  await expect.poll(async () => (await me()).inv.traps).toBe(1);
  const slot = (await me()).hotbar.indexOf('trap');
  expect(slot).toBeGreaterThanOrEqual(0);
  await page.locator('canvas.game').click();
  await page.keyboard.press(`Digit${slot + 1}`);
  // Open ground on my island, looking down at a spot ~2.5 m ahead (toward +X).
  await dbg(page, 'teleport', c.x - 4, c.z + 3);
  await page.evaluate(() => {
    const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
    input.yaw = -Math.PI / 2; // looking toward +X
    input.pitch = -0.75;
  });
  await page.waitForTimeout(1200);
  await shot(page, 'ghost');
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await snap()).traps?.filter((t) => t.owner === humanId).length ?? 0, { timeout: 5000 }).toBe(1);
  const trap = (await snap()).traps!.find((t) => t.owner === humanId)!;
  expect(trap.wall).toBe(false);
  expect((await me()).inv.traps).toBe(0);

  // Standing on my own trap: nothing.
  const hp0 = (await me()).hp;
  await dbg(page, 'teleport', trap.pos.x, trap.pos.z);
  await page.waitForTimeout(2000);
  expect((await me()).hp).toBe(hp0);

  // Watch from 3.5 m off, looking at it.
  const lookAtTrap = () => page.evaluate((t) => {
    const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
    input.yaw = -Math.PI / 2; input.pitch = -0.45;
  }, trap.pos);
  await dbg(page, 'teleport', trap.pos.x - 3.5, trap.pos.z + 0.6);
  await lookAtTrap();
  await page.waitForTimeout(500);
  await shot(page, 'placed');
  // The bot on it (out of spawn protection): springs, it takes the hit.
  const bot = (await snap()).players.find((p) => p.id !== humanId)!;
  const botHp = bot.hp + bot.shield;
  await page.waitForTimeout(3200);
  let fired = false;
  for (let i = 0; i < 20 && !fired; i++) {
    await dbg(page, 'teleport', trap.pos.x, trap.pos.z, bot.id);
    await page.waitForTimeout(150);
    fired = ((await snap()).traps?.find((t) => t.id === trap.id)?.fired ?? -1) >= 0;
  }
  expect(fired).toBe(true);
  await page.waitForTimeout(120);
  await shot(page, 'sprung');
  const after = (await snap()).players.find((p) => p.id === bot.id)!;
  expect(after.hp + after.shield < botHp || !after.alive).toBe(true);
  expect(errors).toEqual([]);
});
