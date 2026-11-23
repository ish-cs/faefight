import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// Commentary smoke: watch bots for 60 s and record what the sportscaster says (captions + debug log).
// Uses WATCH BOTS (?watch=1, cinematic director) when the build has it; otherwise a vs-bot match handed
// to a bot with /spectate, with Settings → Commentary → While spectating on.

type Line = { text: string; key: string; persona: string; prio: number; at: number };

const dbg = <T>(page: Page, fn: string) =>
  page.evaluate((f) => {
    const api = (window as unknown as { __faefight?: Record<string, () => unknown> }).__faefight;
    return (api?.[f] ? api[f]() : null) as T;
  }, fn);

test('WATCH BOTS: 60 s of commentary, varied lines, captions, no errors', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const k = 'faefight.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    s.audio = { ...(s.audio ?? {}), commentaryOn: true, captions: true, commentarySpectate: true };
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1&watch=1&bots=6&diff=hard');

  const cinematic = () => page.evaluate(() => !!(window as unknown as { __cinematic?: { active: boolean } }).__cinematic?.active);
  // No WATCH BOTS in this build: the menu stays up, so play one bot and hand our player over.
  const menu = page.getByTestId('play-easy');
  // A build with the cinematic director has a WATCH BOTS button and ?watch=1 already starts the match: don't start a second one.
  await page.getByTestId('play-easy').waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  const hasWatch = (await page.getByTestId('watch-bots').count()) > 0;
  if (!hasWatch && await menu.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await menu.click();
    await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
    await page.locator('canvas.game').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('/spectate');
    await page.keyboard.press('Enter');
    await expect.poll(() => dbg<number>(page, 'humanId'), { timeout: 15_000 }).toBe(0);
  } else {
    await expect.poll(cinematic, { timeout: 60_000 }).toBe(true);
  }

  await expect.poll(async () => (await dbg<Line[]>(page, 'commentary'))?.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  const t0 = Date.now();
  const seen: string[] = [];
  while (Date.now() - t0 < 60_000) {
    const cap = page.getByTestId('commentary-caption');
    if (await cap.isVisible().catch(() => false)) {
      const txt = (await cap.textContent())?.trim() ?? '';
      if (txt && seen.at(-1) !== txt) seen.push(txt);
    }
    await page.waitForTimeout(400);
  }
  const log = (await dbg<Line[]>(page, 'commentary')) ?? [];
  console.log(`[commentary e2e] ${log.length} lines (${seen.length} captions seen), mode ${(await cinematic()) ? 'cinematic' : 'spectate'}`);
  for (const l of log) console.log(`[line] ${l.persona.padEnd(6)} p${l.prio} ${l.key.padEnd(15)} ${l.text}`);

  expect(errors, errors.join('\n')).toEqual([]);
  // A reasonable rate: talks at least every ~10 s, never more than about one line every 1.5 s.
  const span = Math.max(1, log.at(-1)!.at - log[0].at);
  expect(log.length).toBeGreaterThanOrEqual(6);
  expect(log.length / span).toBeLessThan(0.7);
  expect(log.every((l) => l.text && !/[{}]/.test(l.text))).toBe(true);
  // Variety: no template repeated in the run.
  expect(new Set(log.map((l) => l.text)).size).toBe(log.length);
  expect(seen.length).toBeGreaterThan(0);
  // Automated browsers never really speak: the game swaps in a recording stand-in for speechSynthesis.
  const spoken = await page.evaluate(() => (window as unknown as { __commentarySpoken?: string[] }).__commentarySpoken ?? null);
  expect(spoken, "speech went to the real OS voice").not.toBeNull();
  expect(spoken!.length).toBeGreaterThan(0);
});
