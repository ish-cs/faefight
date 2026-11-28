import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

type F = { updateSettings(m: (s: { video: Record<string, unknown>; gameplay: Record<string, unknown> }) => void): void; input: { yaw: number } };

/** Mean luminance (0–255) of the world region (upper middle: above the hands/weapon, below the top HUD). */
async function worldLum(page: Page): Promise<number> {
  const vp = page.viewportSize()!;
  const png = await page.screenshot({ clip: { x: vp.width * 0.15, y: vp.height * 0.12, width: vp.width * 0.5, height: vp.height * 0.4 } });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4);
  }, png.toString('base64'));
}

/**
 * Prod report: the 3D world went black mid-match (HUD and hands fine) once the player moved around, with hundreds of
 * "GPUValidationError: Destroyed texture [ShadowDepthTexture] used in a submit". Live render-state changes mid-match
 * (first/third person, the quality preset, the power saver on/off) must never leave the world black or submit a
 * destroyed texture.
 */
test('mid-match camera / quality / power-saver toggles: the world stays drawn, no WebGPU validation errors', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || /GPUValidationError|Destroyed texture/.test(m.text())) errors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  // power Quality + no dynamic resolution: the frame governor stays off and can't undo the forced shadow scale
  await page.addInitScript(() => {
    const k = 'faefight.settings.v1', s = JSON.parse(localStorage.getItem(k) ?? '{}');
    s.video = { ...(s.video ?? {}), quality: 'high', power: 'quality', dynamicResolution: false };
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.goto('/?debug=1&bots=3');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 120_000 });
  await page.waitForTimeout(2000);
  const base = await worldLum(page);
  /** One live change: a Settings field, or the frame governor's shadow-map scale (what it trims under slow frames). */
  const apply = (k: string, v: string | number) => page.evaluate(([k, v]) => {
    const f = (window as unknown as { __faefight: F & { renderer: { world: { sky: { setGovernor(g: { ao: number; shadowScale: number }): void } } } } }).__faefight;
    if (k === 'shadowScale') f.renderer.world.sky.setGovernor({ ao: 0, shadowScale: v as number });
    else f.updateSettings((s) => { if (k === 'cameraMode') s.gameplay.cameraMode = v; else s.video[k] = v; });
  }, [k, v] as const);
  /** turn for a moment (moving is when the report's world went black), then measure */
  const step = async (label: string) => {
    await page.evaluate(async () => {
      const f = (window as unknown as { __faefight: F }).__faefight, y0 = f.input.yaw, t0 = performance.now();
      await new Promise<void>((res) => { const loop = (t: number) => { f.input.yaw = y0 + 1.2 * (t - t0) / 1000; if (t - t0 < 1500) requestAnimationFrame(loop); else res(); }; requestAnimationFrame(loop); });
    });
    await page.waitForTimeout(1500);
    const l = await worldLum(page);
    await page.screenshot({ path: info.outputPath(`${label}.png`) });
    return [label, Math.round(l)] as const;
  };
  const out: (readonly [string, number])[] = [await step('start')];
  const changes: [string, string, string | number][] = [
    ['shadowHalf', 'shadowScale', 0.5], ['shadowFull', 'shadowScale', 1],
    ['first', 'cameraMode', 'first'], ['third', 'cameraMode', 'third'],
    ['saverOn', 'power', 'performance'], ['saverOff', 'power', 'quality'], ['saverOn2', 'power', 'performance'],
    ['first2', 'cameraMode', 'first'], ['ultra', 'quality', 'ultra'], ['low', 'quality', 'low'],
    ['high', 'quality', 'high'], ['saverOff2', 'power', 'quality'], ['third2', 'cameraMode', 'third'],
  ];
  for (const [label, k, v] of changes) {
    await apply(k, v);
    await page.waitForTimeout(3000); // a preset change recompiles behind a held frame
    out.push(await step(label));
  }
  console.log(`[liveToggles] base ${Math.round(base)} · ${out.map(([l, v]) => `${l} ${v}`).join(' · ')} · errors ${errors.length}\n${[...new Set(errors.map((e) => e.slice(0, 160)))].slice(0, 5).join('\n')}`);
  for (const [, v] of out) expect(v).toBeGreaterThan(base * 0.4);
  expect(errors).toEqual([]);
});
