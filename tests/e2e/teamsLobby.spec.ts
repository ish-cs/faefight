import { expect, test } from '@playwright/test';

// Lobby only (no match): runs on CI too.
test('teams lobby: host picks 4v4, the lobby grows to 8 seats, a guest picks a team, open seats can start', async ({ context }) => {
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [tag, p] of [['A', a], ['B', b]] as const) {
    await p.setViewportSize({ width: 1280, height: 1100 });
    p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  }
  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;

  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code);
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');

  await a.getByTestId('lobby-settings-teamMode-3').click();
  await expect(a.getByTestId('seat-7')).toBeVisible();
  await expect(b.getByTestId('lobby-settings-teamMode-3')).toHaveClass(/selected/);
  await expect(b.getByTestId('team-picker')).toBeVisible();
  // Auto-balance: Alice team 1, Bob team 2.
  await expect(a.getByTestId('seat-0')).toContainText('team 1');
  await expect(a.getByTestId('seat-1')).toContainText('team 2');
  await b.getByTestId('team-0').click();
  await expect(a.getByTestId('seat-1')).toContainText('team 1');
  await expect(a.getByTestId('start-match')).toBeEnabled();
  await expect(a.getByText(/bots fill them at start/)).toBeVisible();
  expect(errors).toEqual([]);
});
