import type { AudioSystem } from './engine';

/** "Volume" slider row (same look as the sensitivity row); shows "Muted" while M-muted. */
export function volumeControl(audio: AudioSystem): HTMLElement {
  const row = document.createElement('label');
  row.className = 'sens';
  const range = document.createElement('input');
  range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '0.05';
  range.value = String(audio.volume);
  range.dataset.testid = 'volume';
  const val = document.createElement('span');
  const show = () => { val.textContent = audio.muted ? 'Muted' : `${Math.round(audio.volume * 100)}%`; };
  range.oninput = () => {
    audio.setVolume(Number(range.value));
    if (audio.muted) audio.setMuted(false);
    show();
  };
  // Menu/pause rows come and go; drop the subscription once the row has left the page.
  const off = audio.onChange(() => (row.isConnected || !row.dataset.mounted ? show() : off()));
  queueMicrotask(() => { row.dataset.mounted = '1'; });
  show();
  row.append('Volume (M mute)', range, val);
  return row;
}
