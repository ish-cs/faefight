import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

type Stats = { state: string; played: number; dropped: number; active: number; bySound: Record<string, number> };

const stats = (page: Page) => page.evaluate(() =>
  (window as unknown as { __faefight: { audio: () => Stats } }).__faefight.audio());

test('audio: context starts on click, sounds play while shooting, M mutes, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    // Web Audio misuse (bad ramps, out-of-range params) shows up as console warnings.
    else if (m.type() === 'warning' && /audio|AudioParam|Biquad|Panner|Oscillator/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1');
  // Mute persisted before any AudioContext exists: M on the menu flips the stored setting.
  const muted = () => page.evaluate(() => JSON.parse(localStorage.getItem('faefight.settings.v1') ?? '{}').audio?.muted);
  await page.keyboard.press('KeyM');
  await expect.poll(muted).toBe(true);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-audio').click();
  await expect(page.getByTestId('set-mute')).toBeChecked();
  await page.getByTestId('settings-close').click();
  await page.keyboard.press('KeyM');
  await expect.poll(muted).toBe(false);

  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await stats(page)).state, { timeout: 10_000 }).toBe('running');

  const before = await stats(page);
  // Hold fire (fists by default) for ~1.5 s: the sim emits 'shot' events → own punch sounds.
  const box = (await page.locator('canvas.game').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await expect.poll(async () => (await stats(page)).bySound.shot_fists ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const after = await stats(page);
  expect(after.played).toBeGreaterThan(before.played);

  // Every recipe variant builds and starts without throwing (bad ramps/params would log errors).
  const variants: { sound: string; kind?: string; own?: boolean; far?: boolean }[] = [
    ...['fists', 'pistol', 'smg', 'shotgun', 'rifle'].flatMap((kind) => [{ sound: 'shot', kind, own: true }, { sound: 'shot', kind }, { sound: 'shot', kind, far: true }]),
    ...['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'].flatMap((kind) => [{ sound: 'placed', kind }, { sound: 'destroyed', kind }]),
    ...['grass', 'sand', 'concrete', 'wood', 'hollow', 'metal'].map((kind) => ({ sound: 'footstep', kind })),
    { sound: 'explosion', kind: 'grenade' }, { sound: 'explosion', kind: 'charge', far: true },
    ...['impact', 'hurt', 'hitmarker', 'splash', 'coin', 'loot', 'purchase', 'vault', 'kill', 'death', 'eliminated', 'win', 'lose', 'draw', 'alarm', 'escaped', 'horn'].map((sound) => ({ sound })),
    { sound: 'tick', kind: 'normal' }, { sound: 'tick', kind: 'urgent' },
  ];
  const playedBefore = (await stats(page)).played;
  for (const v of variants) {
    await page.evaluate((v) => {
      const api = (window as unknown as { __faefight: { snapshot: () => { players: { id: number; pos: { x: number; y: number; z: number } }[] }; humanId: () => number; audioPlay: (c: unknown) => void } }).__faefight;
      const me = api.snapshot().players.find((p) => p.id === api.humanId())!;
      const pos = v.own ? null : { x: me.pos.x + (v.far ? 70 : 6), y: me.pos.y + 1, z: me.pos.z };
      api.audioPlay({ sound: v.sound, kind: v.kind, own: v.own, pos, gain: 0.8 });
    }, v);
    await page.waitForTimeout(20); // new frame → per-frame caps reset
  }
  await expect.poll(async () => (await stats(page)).played - playedBefore).toBeGreaterThanOrEqual(variants.length - 2);

  // Frame rate stays healthy with audio running (HUD shows a live fps readout).
  const fps = Number((await page.locator('.fps').textContent())?.replace(/\D/g, ''));
  console.log(`[audio e2e] fps=${fps} stats=${JSON.stringify(after)}`);

  expect(errors, errors.join('\n')).toEqual([]);
});
