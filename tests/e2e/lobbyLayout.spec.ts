import { expect, test } from '@playwright/test';

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
