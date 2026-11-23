import { expect, test, type Page } from '@playwright/test';

test('adding seats does not move the lobby buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?net=local');
  await page.getByTestId('name-input').fill('Alice');
  await page.getByTestId('host-game').click();
  await expect(page.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const add = page.getByTestId('add-seat');
  const y0 = (await add.boundingBox())!.y;
  for (let i = 0; i < 6; i++) {
    await add.click();
    expect(Math.abs((await add.boundingBox())!.y - y0)).toBeLessThan(1);
  }
  await page.getByTestId('remove-seat-2').click();
  expect(Math.abs((await page.getByTestId('add-seat').boundingBox())!.y - y0)).toBeLessThan(1);
});

// Set LAYOUT_SHOTS=<dir> to also save a screenshot per size and role.
const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LAYOUT_SHOTS;
const SIZES = [{ width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }];

/**
 * Layout problems in the lobby, measured in the page: controls sticking out of their card, labels
 * wrapping onto a second line, names cut off with an ellipsis though there is room, uneven segments.
 */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const name = (e: Element) => (e as HTMLElement).dataset.testid ?? `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
    const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    // Lines taken by the longest-wrapping text run inside e (each text node measured on its own).
    const lines = (e: Element) => {
      let most = 0;
      const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        const tops = new Set([...r.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
        most = Math.max(most, tops.size);
      }
      return most;
    };
    // Every visible control stays inside its card (1 px tolerance).
    const cards = [...document.querySelectorAll('.lobby-card, .game-settings, .seat, .lobby-side')].filter(visible);
    for (const card of cards) {
      const c = card.getBoundingClientRect();
      for (const k of card.querySelectorAll('button, input, .map-picker, .seat-slider, .gs-row, .swatches, .nick, .tagpill, .label, .gs-value')) {
        if (!visible(k)) continue;
        const r = k.getBoundingClientRect();
        if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) {
          out.push(`${name(k)} overflows ${name(card)} (${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(c.left)}..${Math.round(c.right)})`);
        }
      }
    }
    // One line per label.
    for (const k of document.querySelectorAll('.map-opt, .seat-slider .stop, .gs-name, .gs-value, .tagpill, .lobby-card .label, .lobby-card .btn, .seat-name')) {
      if (visible(k) && lines(k) > 1) out.push(`${name(k)} "${k.textContent}" wraps onto ${lines(k)} lines`);
    }
    // Segmented controls: every segment the same height, nothing clipped inside a segment.
    for (const seg of document.querySelectorAll('.lobby-card .map-picker')) {
      if (!visible(seg)) continue;
      const hs = [...seg.querySelectorAll('.map-opt')].map((b) => Math.round(b.getBoundingClientRect().height));
      if (new Set(hs).size > 1) out.push(`${name(seg)} segments have uneven heights ${hs.join('/')}`);
      for (const b of seg.querySelectorAll<HTMLElement>('.map-opt')) if (b.scrollWidth > b.clientWidth + 1) out.push(`${name(b)} text is clipped`);
    }
    // Names are not cut off.
    for (const n of document.querySelectorAll<HTMLElement>('.seat .nick')) if (n.scrollWidth > n.clientWidth + 1) out.push(`seat name "${n.textContent}" is truncated`);
    // Game-settings rows: the controls line up in one column.
    const rows = [...document.querySelectorAll('.lobby-card .game-settings .gs-row')].filter(visible);
    const lefts = new Set(rows.map((r) => Math.round(r.children[1].getBoundingClientRect().left)));
    if (lefts.size > 1) out.push(`game-settings controls start at different x: ${[...lefts].join('/')}`);
    const valueRights = new Set(rows.flatMap((r) => [...r.querySelectorAll('.gs-value')].map((v) => Math.round(v.getBoundingClientRect().right))));
    if (valueRights.size > 1) out.push(`game-settings values end at different x: ${[...valueRights].join('/')}`);
    // The page itself never scrolls sideways.
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    return out;
  });
}

async function hostWithBots(page: Page) {
  await page.goto('/?net=local');
  await page.getByTestId('name-input').fill('Alice');
  await page.getByTestId('host-game').click();
  const code = (await page.getByTestId('lobby-code').textContent())!;
  for (let i = 0; i < 2; i++) await page.getByTestId('add-seat').click();
  // Seats 1-3: Easy, Hard, PRO bots (seat 1 is a bot by default or open; set it explicitly).
  for (const [seat, key] of [[1, 'Home'], [2, 'End'], [3, 'End']] as const) {
    const s = page.getByTestId(`seat-slider-${seat}`);
    await s.focus();
    await page.keyboard.press(key);
    if (seat === 1) await page.keyboard.press('ArrowRight'); // Easy
    if (seat === 2) await page.keyboard.press('ArrowLeft'); // Hard
  }
  await expect(page.getByTestId('seat-3')).toContainText('bot');
  await page.waitForTimeout(400); // slider thumbs finish sliding (screenshots)
  return code;
}

for (const size of SIZES) {
  test(`lobby layout at ${size.width}×${size.height}: nothing overflows, labels stay on one line (host and guest)`, async ({ context }) => {
    const host = await context.newPage();
    await host.setViewportSize(size);
    const code = await hostWithBots(host);
    if (SHOTS) await host.screenshot({ path: `${SHOTS}/lobby-host-${size.width}x${size.height}.png` });
    for (const mode of [0, 1]) { // free-for-all, then 2v2v2v2 (team pills on the seats)
      await host.getByTestId(`lobby-settings-teamMode-${mode}`).click();
      await expect(host.getByTestId(`lobby-settings-teamMode-${mode}`)).toHaveClass(/selected/);
      if (SHOTS && mode === 1) await host.screenshot({ path: `${SHOTS}/lobby-host-teams-${size.width}x${size.height}.png` });
      expect(await layoutProblems(host), `host, mode ${mode}`).toEqual([]);
    }
    await host.getByTestId('lobby-settings-teamMode-0').click();

    // Guest: takes the last seat once the host opens it.
    await host.getByTestId('seat-slider-3').focus();
    await host.keyboard.press('Home');
    await expect(host.getByTestId('seat-3')).toContainText('Open');
    const guest = await context.newPage();
    await guest.setViewportSize(size);
    await guest.goto('/?net=local');
    await guest.getByTestId('name-input').fill('Bob_Longername');
    await guest.getByTestId('code-input').fill(code);
    await guest.getByTestId('join-game').click();
    await expect(host.getByTestId('seat-3')).toContainText('Bob_Longername');
    await expect(guest.getByTestId('lobby-settings')).toBeVisible();
    if (SHOTS) await guest.screenshot({ path: `${SHOTS}/lobby-guest-${size.width}x${size.height}.png` });
    expect(await layoutProblems(guest), 'guest').toEqual([]);
    expect(await layoutProblems(host), 'host with a guest').toEqual([]);
  });
}

test('How to play: every step is one line, at 1280×720 and 1440×900', async ({ page }) => {
  for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByTestId('open-how-to').click();
    const card = page.getByTestId('how-to-play');
    await expect(card.locator('li')).toHaveCount(8);
    const wrapped = await card.evaluate((c) => [...c.querySelectorAll('.howto-step-text')].flatMap((t) => {
      const lh = parseFloat(getComputedStyle(t).lineHeight);
      return t.getBoundingClientRect().height > lh * 1.5 ? [t.textContent!] : [];
    }));
    expect(wrapped, `${size.width}×${size.height}`).toEqual([]);
    // The card fits the window.
    const box = (await card.locator('.howto').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/how-to-play-${size.width}x${size.height}.png` });
    await page.getByTestId('how-to-close').click();
  }
});
