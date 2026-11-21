import { normalizeCode } from '../../net/code';

/**
 * Join-by-link: `https://faefight.vercel.app/?join=CODE` (origin + path from where the game is served).
 * Dev/e2e flags (`net=local`, `debug=1`) are carried over so a local link joins the same transport.
 */
export function inviteLink(code: string, loc: Pick<Location, 'origin' | 'pathname' | 'search'> = location): string {
  const keep = new URLSearchParams();
  const cur = new URLSearchParams(loc.search);
  for (const k of ['net', 'debug']) { const v = cur.get(k); if (v) keep.set(k, v); }
  keep.set('join', code);
  return `${loc.origin}${loc.pathname}?${keep.toString()}`;
}

/** The invite code in `?join=` (normalized), or null if absent/invalid. */
export function joinCodeFrom(search: string): string | null {
  const raw = new URLSearchParams(search).get('join');
  return raw ? normalizeCode(raw) : null;
}

/** "Copy invite link" button for the lobby (next to the code). */
export function inviteButton(code: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn small';
  b.textContent = 'Copy invite link';
  b.dataset.testid = 'copy-invite';
  const link = inviteLink(code);
  b.title = link;
  b.onclick = () => {
    const done = (t: string) => { b.textContent = t; setTimeout(() => (b.textContent = 'Copy invite link'), 1500); };
    if (!navigator.clipboard) { done('Copy failed'); console.warn('[invite] clipboard unavailable; link:', link); return; }
    navigator.clipboard.writeText(link).then(() => done('Link copied'), (err) => { console.warn('[invite] copy failed', err); done('Copy failed'); });
  };
  return b;
}

/** Put the invite button into a lobby screen (beside the code). Idempotent. */
export function addInviteButton(lobbyRoot: HTMLElement, code: string) {
  if (!code || lobbyRoot.querySelector('[data-testid="copy-invite"]')) return;
  const codeEl = lobbyRoot.querySelector('[data-testid="lobby-code"]');
  const row = codeEl?.parentElement;
  if (!row) { console.warn('[invite] lobby code row not found; invite link button not shown'); return; }
  row.append(inviteButton(code));
}
