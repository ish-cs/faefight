import type { MatchEvent, Snapshot } from '../sim/types';

type Named = { id: number; name: string };

/** Headline for a bunker-sealed event, from the viewer's point of view. Null for anything else. */
export function sealAnnouncement(e: MatchEvent, me: number, players: Named[]): string | null {
  if (e.type !== 'sealed') return null;
  const name = (id: unknown) => players.find((p) => p.id === id)?.name ?? 'Someone';
  const owner = e.data.owner, by = e.data.by;
  if (by == null) return owner === me ? 'YOUR bunker is sealed' : `${name(owner)}'s bunker is sealed`;
  if (by === me && owner === me) return 'You sealed your own bunker!';
  if (by === me) return `You sealed ${name(owner)}'s bunker`;
  if (owner === me) return `${name(by)} sealed YOUR bunker`;
  return `${name(by)} sealed ${name(owner)}'s bunker`;
}

const SHOW_MS = 3200;

/** Big centre-screen headline + screen shake when any bunker gets sealed. */
export class SealAnnouncer {
  private el = document.createElement('div');
  private hideTimer = 0;

  constructor(parent: HTMLElement, private shake: (strength: number) => void) {
    this.el.className = 'seal-announce';
    parent.append(this.el);
  }

  onSnapshot(snap: Snapshot, me: number) {
    for (const e of snap.events) {
      const text = sealAnnouncement(e, me, snap.players);
      if (!text) continue;
      this.el.textContent = text;
      this.el.classList.toggle('mine', e.data.owner === me);
      this.el.classList.remove('show');
      void this.el.offsetWidth; // restart the CSS animation
      this.el.classList.add('show');
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.el.classList.remove('show'), SHOW_MS);
      this.shake(e.data.owner === me ? 1 : 0.6);
    }
  }
}
