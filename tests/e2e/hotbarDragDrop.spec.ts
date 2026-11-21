import { expect, test, type Page } from '@playwright/test';

// Dragging a hotbar slot out over the game view drops it (the sim's drop action); Shift drops one.
type Snap = { loot: { inv: { pieces: Record<string, number> } }[]; players: { id: number; hotbar: (string | null)[]; inv: { pieces: Record<string, number> } }[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

async function dragOut(page: Page, slot: number, shift = false) {
  const box = (await page.getByTestId(`hotbar-slot-${slot}`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(640, 420, { steps: 6 });
  await page.mouse.move(640, 300, { steps: 6 });
  await expect(page.getByTestId('drag-drop-hint')).toBeVisible();
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test('drag a hotbar slot out over the game view to drop it; Shift drops one; Esc cancels', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
  const humanId = await dbg<number>(page, 'humanId');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const bagsWith = async (k: string) => (await dbg<Snap>(page, 'snapshot')).loot.filter((b) => (b.inv.pieces[k] ?? 0) > 0).map((b) => b.inv.pieces[k]);

  await dbg(page, 'give', { pieces: { sandbags: 3, wood: 4 } });
  await expect(page.getByTestId('hotbar-slot-1')).toHaveAttribute('data-item', 'wood');
  await page.locator('canvas.game').focus();
  await page.keyboard.press('KeyI');
  await expect(page.getByTestId('hotbar')).toHaveClass(/editing/);

  // Slot 2 (Wood ×4) out over the game: the whole stack lands on the ground and the slot empties.
  await dragOut(page, 1);
  await expect.poll(() => bagsWith('wood'), { timeout: 10_000 }).toEqual([4]);
  await expect(page.getByTestId('hotbar-slot-1')).toHaveAttribute('data-item', '');
  expect((await me()).inv.pieces.wood ?? 0).toBe(0);

  // Shift-drag drops one sandbag.
  await dragOut(page, 0, true);
  await expect.poll(() => bagsWith('sandbags'), { timeout: 10_000 }).toEqual([1]);
  await expect(page.locator('[data-testid="hotbar-slot-0"] .hb-count')).toHaveText('2');

  // Esc mid-drag cancels: nothing more is dropped.
  const box = (await page.getByTestId('hotbar-slot-0').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(640, 300, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect(await bagsWith('sandbags')).toEqual([1]);
  expect((await me()).inv.pieces.sandbags).toBe(2);
  expect(errors, errors.join('\n')).toEqual([]);
});
