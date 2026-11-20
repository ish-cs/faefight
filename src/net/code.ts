/** No I, L, O, 0, 1: easy to read aloud and type. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;

export function newInviteCode(rng: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    const k = Math.min(CODE_ALPHABET.length - 1, Math.floor(rng() * CODE_ALPHABET.length));
    s += CODE_ALPHABET[k];
  }
  return s;
}

/** Uppercase, strip spaces/dashes, validate. Null if not a well-formed code. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, '');
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}
