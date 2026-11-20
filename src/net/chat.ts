import { CHAT_MAX_LEN } from './protocol';

/**
 * Normalize untrusted chat text. Control chars (incl. newlines) become spaces, whitespace collapses,
 * length is capped at CHAT_MAX_LEN UTF-16 units without splitting a surrogate pair.
 * Markup is NOT escaped here: the UI must render with textContent.
 */
export function cleanChat(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  // Bound work on huge inputs before regex passes (collapsing can only shrink the text further).
  const head = text.length > CHAT_MAX_LEN * 8 ? text.slice(0, CHAT_MAX_LEN * 8) : text;
  let s = head.replace(/\p{Cs}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (s.length > CHAT_MAX_LEN) {
    let out = '';
    for (const ch of s) {
      if (out.length + ch.length > CHAT_MAX_LEN) break;
      out += ch;
    }
    s = out.trimEnd();
  }
  return s.length > 0 ? s : null;
}

const WINDOW_MS = 1000;
const MAX_PER_WINDOW = 2;

/** At most 2 accepted messages per sender in any rolling 1 s window. Rejected attempts don't count. */
export class ChatLimiter {
  private sent = new Map<string, number[]>();

  allow(sender: string, nowMs: number): boolean {
    const recent = (this.sent.get(sender) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    const ok = recent.length < MAX_PER_WINDOW;
    if (ok) recent.push(nowMs);
    if (recent.length > 0) this.sent.set(sender, recent);
    else this.sent.delete(sender);
    return ok;
  }
}
