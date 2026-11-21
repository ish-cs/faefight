/**
 * Per-player chat mute, local to this browser: anyone (host or guest) can mute anyone else in their own
 * lobby/game chat. Nothing goes over the network, so a mute can't be abused or bypassed by a modified
 * client, and it needs no protocol. Keyed by display name (the lobby keeps names unique). Lasts for the
 * page session. System lines (from = '') are never muted.
 */
const muted = new Set<string>();

export const isMuted = (from: string) => from !== '' && muted.has(from.toLowerCase());

/** Toggle; returns the new state. */
export function toggleMute(name: string): boolean {
  const k = name.toLowerCase();
  if (muted.delete(k)) { console.info(`[chat] unmuted ${name}`); return false; }
  muted.add(k);
  console.info(`[chat] muted ${name}`);
  return true;
}

export function clearMutes() { muted.clear(); }
