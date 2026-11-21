// Screenshots of every UI screen → docs/screens/ui-<prefix>-<name>.png (headless).
//   pnpm vite --port 5331 --strictPort &   node tests/visual/uiShots.mjs http://localhost:5331 after [only,comma,list]
// "storm" shots darken the canvas to check HUD legibility in dark scenes; "day" ones look at bright sand/sky.
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5331';
const prefix = process.argv[3] ?? 'after';
const only = process.argv[4] ? new Set(process.argv[4].split(',')) : null;
const out = 'docs/screens';
mkdirSync(out, { recursive: true });
const want = (n) => !only || only.has(n);
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu'] });
const seen = { v: 2, onboarding: { howToSeen: true } };
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((s) => { if (!localStorage.getItem('faefight.settings.v1')) localStorage.setItem('faefight.settings.v1', s); }, JSON.stringify(seen));
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)));
const shot = async (name, p = page) => { await p.screenshot({ path: `${out}/ui-${prefix}-${name}.png` }); console.log('shot', name); };
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const menuReady = async () => {
  await page.getByTestId('play-medium').waitFor();
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 30_000 });
  await page.waitForTimeout(700);
};

// ---- menus ----
await page.goto(`${base}/?debug=1`);
await menuReady();
if (want('menu')) await shot('menu');
if (want('howto')) {
  await page.getByTestId('open-how-to').click(); await page.waitForTimeout(450); await shot('howto');
  await page.getByTestId('how-to-close').click(); await page.waitForTimeout(300);
}
if (want('settings')) {
  await page.getByTestId('open-settings').first().click(); await page.waitForTimeout(450); await shot('settings');
  await page.getByTestId('settings-tab-controls').click().catch(() => {}); await page.waitForTimeout(250); await shot('settings-controls');
  await page.getByTestId('settings-tab-video').click().catch(() => {}); await page.waitForTimeout(250); await shot('settings-video');
  await page.getByTestId('settings-close').click(); await page.waitForTimeout(300);
}
if (want('loading')) {
  await page.evaluate(() => {
    const l = window.__faefightLoading.screen;
    l.show('match', { code: 15, gpu: 10, characters: 25, map: 15, shaders: 30, frames: 5 });
    l.progress('code', 1); l.progress('gpu', 1); l.progress('characters', 1); l.progress('map', 1);
    l.progress('shaders', 0.45, 'Compiling shaders');
  });
  await page.waitForTimeout(1500);
  await shot('loading');
  await page.goto(`${base}/?debug=1`);
  await menuReady();
}
if (want('toast')) {
  await page.evaluate(() => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = 'Could not reach the host. Check the invite code and try again.'; document.body.append(t); });
  await page.waitForTimeout(400);
  await shot('toast');
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}
if (want('lobby')) {
  try {
    await page.getByTestId('name-input').fill('Captain');
    await page.getByTestId('host-game').click();
    await page.getByTestId('lobby-code').waitFor({ timeout: 20_000 });
    await page.getByTestId('add-seat').click().catch(() => {});
    await page.getByTestId('add-seat').click().catch(() => {});
    await page.waitForTimeout(300);
    await page.getByTestId('seat-slider-2').locator('.stop').nth(3).click().catch(() => {});
    await page.waitForTimeout(500);
    await shot('lobby');
  } catch (e) { console.error('lobby skipped:', String(e).slice(0, 120)); }
  await page.goto(`${base}/?debug=1`);
  await menuReady();
}

// ---- phone block ----
if (want('phone')) {
  const pctx = await browser.newContext({ ...devices['iPhone 13'] });
  const pp = await pctx.newPage();
  await pp.goto(`${base}/`);
  await pp.getByTestId('computer-only').waitFor({ timeout: 20_000 });
  await pp.waitForTimeout(900);
  await shot('phone', pp);
  await pctx.close();
}

// ---- in game ----
const needGame = ['hud-day', 'hud-storm', 'shop', 'pause', 'scoreboard', 'recap', 'end', 'spectate', 'fx'].some(want);
if (needGame) {
  await page.getByTestId('bots-3').click();
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.()?.players?.length > 1, null, { timeout: 60_000 });
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const me = await dbg('humanId');
  await dbg('give', { cash: 1250, weapons: { pistol: { mag: 9, spare: 36 }, smg: { mag: 30, spare: 90 } }, pieces: { wood: 6, sandbags: 4 }, grenades: 2, medkits: 1 });
  await page.waitForTimeout(400);
  await page.locator('canvas.game').click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Digit1');
  await page.evaluate(() => { window.__faefight.input.pitch = -0.35; });
  // Sample kill feed + damage numbers so their styling is visible.
  const stage = () => page.evaluate(() => {
    const kf = document.querySelector('.hud .killfeed');
    if (kf && !kf.children.length) {
      for (const [t, a] of [['Rook  ✕  Marlin', false], ["Coral's bunker SEALED", true]]) { const d = document.createElement('div'); d.className = `feed-item${a ? ' alert' : ''}`; d.textContent = t; kf.append(d); }
    }
    const fx = document.querySelector('.damage-fx') ?? document.body;
    if (!document.querySelector('.dmg-number.staged')) {
      for (const [x, y, n, c] of [[820, 380, '24', ''], [870, 330, '68', 'big'], [760, 420, '12', 'shield']]) {
        const d = document.createElement('div'); d.className = `dmg-number staged ${c}`; d.textContent = n; d.style.transform = `translate(${x}px, ${y}px)`; fx.append(d);
      }
    }
  });
  if (want('hud-day')) { await stage(); await page.waitForTimeout(300); await shot('hud-day'); }
  if (want('hud-storm')) {
    await stage();
    await page.addStyleTag({ content: 'canvas.game { filter: brightness(0.32) saturate(0.6) hue-rotate(10deg); } .storm-off canvas.game { filter: none; }' });
    await page.waitForTimeout(300); await shot('hud-storm');
    await page.evaluate(() => document.body.classList.add('storm-off'));
  }
  if (want('hud-sky')) { await page.evaluate(() => { window.__faefight.input.pitch = 0.5; }); await page.waitForTimeout(400); await shot('hud-sky'); await page.evaluate(() => { window.__faefight.input.pitch = -0.35; }); }
  if (want('scoreboard')) {
    await page.keyboard.down('Tab'); await page.waitForTimeout(400); await shot('scoreboard'); await page.keyboard.up('Tab');
  }
  if (want('pause')) {
    await page.evaluate(() => document.exitPointerLock());
    await page.getByTestId('pause').waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot('pause');
    await page.getByTestId('pause').locator('[data-testid="open-settings"]').hover().catch(() => {});
    await page.waitForTimeout(250);
    await shot('pause-hover');
    await page.getByTestId('resume').click().catch(() => {});
    await page.waitForTimeout(300);
  }
  if (want('shop')) {
    await page.evaluate(() => {
      const f = window.__faefight; const id = f.humanId(); const map = f.map();
      const me = f.snapshot().players.find((p) => p.id === id); const isl = map[me.island];
      f.teleport(isl.shop.x + 1.2, isl.shop.z);
    });
    await page.waitForTimeout(900);
    await page.keyboard.press('e');
    await page.getByTestId('buy-genUpgrade').waitFor({ timeout: 10_000 }).catch(() => {});
    await page.getByTestId('buy-smg').hover().catch(() => {});
    await page.waitForTimeout(300);
    await shot('shop');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  if (want('recap')) {
    await dbg('teleport', 0, 0);
    await page.getByTestId('death-recap').waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot('recap');
    await page.waitForFunction((id) => window.__faefight.snapshot().players.find((p) => p.id === id)?.alive, me, { timeout: 15_000 }).catch(() => {});
  }
  if (want('end') || want('spectate')) {
    await dbg('eliminate', me);
    await page.getByTestId('end-screen').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    if (want('end')) await shot('end');
    if (want('spectate')) {
      await page.getByTestId('spectate').click().catch(() => {});
      await page.waitForTimeout(800);
      await shot('spectate');
    }
  }
}
await browser.close();
console.log('done');
