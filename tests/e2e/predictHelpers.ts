import type { Page } from '@playwright/test';

/**
 * Press W inside the page and count rendered frames until the local (predicted) position moves.
 * Also reports whether the authoritative snapshot position had moved by then (it can't have: the
 * sim hasn't seen the command yet), i.e. the response is prediction, not the server echo.
 */
export async function pressAndMeasure(page: Page, code = 'KeyW') {
  return page.evaluate(async (code) => {
    type Api = { predicted(): { pos: V | null }; snapshot(): { players: { id: number; pos: V }[] } | null; humanId(): number };
    type V = { x: number; y: number; z: number };
    const api = (window as unknown as { __faefight: Api }).__faefight;
    const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
    const serverPos = () => { const s = api.snapshot()!; return { ...s.players.find((p) => p.id === api.humanId())!.pos }; };
    const d = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z);
    await raf();
    const p0 = { ...api.predicted().pos! }, s0 = serverPos();
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: 'w' }));
    for (let frame = 1; frame <= 30; frame++) {
      await raf();
      const p = api.predicted().pos!;
      if (d(p, p0) > 0.001) return { frames: frame, serverMovedFirst: d(serverPos(), s0) > 0.001 };
    }
    return { frames: Infinity, serverMovedFirst: true };
  }, code);
}

export const release = (page: Page, code = 'KeyW') =>
  page.evaluate((code) => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'w' })), code);

