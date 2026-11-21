import { expect, test } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // the shader warm-up makes a software-GL match load exceed 30 s

test('shop item details show in the info bar, fully inside the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect.poll(() => page.evaluate(() => (window as any).__faefight?.snapshot()?.players.length ?? 0), { timeout: 30_000 }).toBe(2);
  await page.evaluate(() => {
    const f = (window as any).__faefight; const id = f.humanId(); const map = f.map();
    const me = f.snapshot().players.find((p: any) => p.id === id); const isl = map[me.island];
    f.give({ cash: 2000 });
    f.teleport(isl.shop.x + 1.2, isl.shop.z);
  });
  await page.waitForTimeout(800);
  await page.keyboard.press('e');
  const card = page.getByTestId('buy-genUpgrade');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.hover();
  const info = page.getByTestId('shop-info');
  await expect(info).toContainText('Generator');
  const panel = await page.locator('.shop-grid').locator('..').boundingBox();
  const box = await info.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(panel!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
  await page.screenshot({ path: 'test-results/shop-info.png' });
});
