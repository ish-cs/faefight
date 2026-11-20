import type { ReplayMeta } from '../../sim/replay/format';
import { replayStore } from './store';

/** Recordings still being encoded/written: leaving the page waits for them (bounded). */
const pending = new Set<Promise<unknown>>();

export function trackSave(p: Promise<unknown>): void {
  const q = p.catch(() => {}).finally(() => pending.delete(q));
  pending.add(q);
}

/** Store a finished recording (errors are logged, never thrown: a failed save must not break the game). */
export function saveReplay(bytes: Uint8Array, meta: ReplayMeta): void {
  trackSave(replayStore()
    .then((s) => s.put(meta, bytes))
    .then(() => console.info(`[replays] saved ${meta.id} (${(bytes.length / 1024).toFixed(0)} KB)`))
    .catch((err) => console.error('[replays] could not save the recording', err)));
}

/** Resolves once every pending save is done, or after `timeoutMs`. */
export function savesSettled(timeoutMs = 4000): Promise<void> {
  return Promise.race([
    Promise.all([...pending]).then(() => {}),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Code version stamped into recordings (vite define; 'dev' when unset). */
declare const __FAE_BUILD__: string | undefined;
export const BUILD = typeof __FAE_BUILD__ === 'string' ? __FAE_BUILD__ : 'dev';
