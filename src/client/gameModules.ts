/**
 * The heavy, three.js-dependent half of the client, split out of the menu bundle. The menu shows
 * without it; it's preloaded in the background once the menu is up and awaited when a match starts.
 */

const IMPORTS = {
  three: () => import('three/webgpu'),
  render: () => import('./render'),
  camera: () => import('./camera'),
  viewmodel: () => import('./viewmodel'),
  damageFx: () => import('./damageFx'),
  hud: () => import('./hud'),
  warmup: () => import('./warmup'),
  spectator: () => import('./spectator'),
  characters: () => import('./characters/loader'),
};
type Mods = { [K in keyof typeof IMPORTS]: Awaited<ReturnType<(typeof IMPORTS)[K]>> };

const TOTAL = Object.keys(IMPORTS).length;
let done = 0;
let pending: Promise<Mods> | null = null;
const listeners = new Set<(done: number, total: number) => void>();

/** Load (once) every game module. `onProgress(done, total)` fires now and as each chunk lands. */
export function loadGameModules(onProgress?: (done: number, total: number) => void): Promise<Mods> {
  if (onProgress) { listeners.add(onProgress); onProgress(done, TOTAL); }
  pending ??= (async () => {
    const entries = await Promise.all(Object.entries(IMPORTS).map(async ([k, load]) => {
      const m = await load();
      done++;
      for (const fn of listeners) fn(done, TOTAL);
      return [k, m] as const;
    }));
    return Object.fromEntries(entries) as Mods;
  })();
  pending.catch(() => { pending = null; done = 0; }); // let a retry start over
  const p = pending;
  if (onProgress) p.finally(() => listeners.delete(onProgress)).catch(() => {});
  return p;
}

/** Background preload once the menu is idle: game chunks, then the character model download. */
export function preloadGame() {
  const run = () => loadGameModules()
    .then((m) => m.characters.loadCharacters())
    .then(() => console.info('[preload] game modules + character models ready'))
    .catch((err) => console.warn('[preload] background preload failed; will retry when a match starts', err));
  const ric = (window as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(run, { timeout: 1500 }); else setTimeout(run, 300);
}
