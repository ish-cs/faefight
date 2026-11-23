/**
 * "Leave match?" guard: while a match is live, closing or reloading the tab asks first (browser prompt).
 * Ctrl+W can't be blocked by a page, so a stray one mid-match (Ctrl aims) gets a prompt instead of a lost game.
 */
let live: (() => boolean) | null = null;
let installed = false;

/** Arm with a "match is live" check, or disarm with null (menu, deliberate leave, reload to rejoin). */
export function setLeaveGuard(fn: (() => boolean) | null) {
  live = fn;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('beforeunload', (e) => {
    if (!live?.()) return;
    e.preventDefault();
    e.returnValue = ''; // older Chrome needs it to show the prompt
  });
}
