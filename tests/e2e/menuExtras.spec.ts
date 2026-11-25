import { devices, expect, test } from '@playwright/test';

const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0';

test.describe('first launch', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // a brand-new player

  test('How to play opens by itself once, then from the menu button', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const card = page.getByTestId('how-to-play');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('loading')).toHaveCount(0); // it opens once the loading screen is gone
    await expect(card.locator('li')).toHaveCount(8);
    await expect(card).toContainText('Seal every enemy bunker');
    await expect(card).toContainText('10 seconds');
    await expect(card.locator('select')).toHaveCount(0);
    await page.screenshot({ path: 'docs/screens/how-to-play.png' });
    await page.getByTestId('how-to-close').click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('faefight.settings.v1')!).onboarding.howToSeen)).toBe(true);

    // Second launch: the menu, no card; the button brings it back and Esc closes it.
    await page.reload();
    await expect(page.getByTestId('play-medium')).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.getByTestId('open-how-to').click();
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('phones get the computer-only card and none of the game', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined } as Parameters<typeof browser.newContext>[0]);
  const page = await ctx.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/');
  const card = page.getByTestId('computer-only');
  await expect(card).toBeVisible();
  await expect(card).toContainText('FAEFight is a computer game — open this link on a laptop or desktop in Chrome.');
  await expect(page.getByTestId('play-medium')).toHaveCount(0);
  await expect(page.getByTestId('loading')).toHaveCount(0);
  await page.waitForTimeout(1000); // a game preload would have started by now
  const game = requests.filter((u) => /three|\/render\.ts|\/hud\.ts|worker\.ts|rapier|characters\//.test(u));
  expect(game, game.join('\n')).toEqual([]);
  await page.screenshot({ path: 'docs/screens/computer-only.png' });
  await ctx.close();
});

test('non-Chromium browsers get a dismissible "Best in Google Chrome" note, Chrome does not', async ({ browser, page }) => {
  await page.goto('/');
  await expect(page.getByTestId('play-medium')).toBeVisible();
  await expect(page.getByTestId('chrome-banner')).toHaveCount(0);

  const ctx = await browser.newContext({ userAgent: FIREFOX_UA, storageState: { cookies: [], origins: [] } });
  const ff = await ctx.newPage();
  await ff.goto('/');
  await ff.getByTestId('how-to-close').click();
  const banner = ff.getByTestId('chrome-banner');
  await expect(banner).toHaveText(/Best in Google Chrome/);
  await expect(ff.getByTestId('play-medium')).toBeEnabled(); // never blocked
  await ff.getByTestId('chrome-banner-close').click();
  await expect(banner).toHaveCount(0);
  await ctx.close();
});
