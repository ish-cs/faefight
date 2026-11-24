/**
 * English text → Kokoro phonemes without eSpeak (nothing GPL): a CMUdict-derived lexicon (BSD-2-Clause,
 * built by scripts/build-lexicon.mjs into misaki's US symbols), compound splitting for gamer names
 * ("JollyKraken8" → jolly kraken eight), and the NRL letter-to-sound rules (Elovitz et al. 1976, NRL
 * Report 7948; rule table as transcribed in HeadTTS, MIT, © Mika Suominen) for anything left over.
 * Output uses only symbols in the Kokoro v1.0 tokenizer vocab.
 */

/** Lexicon: lower-case word → phonemes (misaki US symbols). */
export type Lexicon = Record<string, string>;
/** NRL rules per letter: "LEFT[MATCH]RIGHT=PH PH ..." (ARPAbet, mostly unstressed). */
export type NrlRules = Record<string, string[]>;

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..999,999,999 in words ("1011" → "one thousand eleven"). */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return '';
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  if (n < 1e6) return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
  return `${numberToWords(Math.floor(n / 1e6))} million${n % 1e6 ? ` ${numberToWords(n % 1e6)}` : ''}`;
}

/**
 * Text the lexicon can read: money and numbers spelled out, gamer names split into words
 * (Skipper_Harbor, Mighty.Ana, BigWalrus60, IceTeaOnly), acronyms we say as words.
 */
export function normalize(text: string): string {
  return text
    .replace(/\$(\d+)/g, '$1 dollars')
    .replace(/\bHP\b/g, 'health')
    .replace(/\bSMG\b/g, 'S M G')
    .replace(/([A-Za-z])[._]([A-Za-z0-9])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/(\d+)'s\b/g, (_m, d: string) => ` ${numberToWords(Number(d))}'s `)
    .replace(/\d+/g, (d) => ` ${numberToWords(Number(d))} `)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

const VOWELS = 'AEIOUY';
const CONS = 'BCDFGHJKLMNPQRSTVWXZ';
const NRL_PH: Record<string, string> = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'W', AX: 'ə', AY: 'I', EH: 'ɛ', ER: 'ɜɹ', EY: 'A', IH: 'ɪ', IY: 'i', OW: 'O', OY: 'Y',
  UH: 'ʊ', UW: 'u', B: 'b', CH: 'ʧ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'ʤ', K: 'k', L: 'l', M: 'm', N: 'n', NX: 'ŋ',
  P: 'p', R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', WH: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};
const VOWEL_PH = /[ɑæʌɔWəIɛɜAiOYʊuɪ]/;

type Rule = { left: string; match: string; right: string; out: string[] };

/** Context matching for NRL rules (word padded with spaces). */
function ctxMatch(pat: string, word: string, pos: number, dir: 1 | -1): boolean {
  let i = pos;
  const at = () => word[i] ?? ' ';
  const seq = dir === 1 ? [...pat] : [...pat].reverse();
  for (const c of seq) {
    if (c === ' ') { if (/[A-Z]/.test(at())) return false; i += dir; continue; }
    if (c === '#') { if (!VOWELS.includes(at())) return false; while (VOWELS.includes(at())) i += dir; continue; }
    if (c === ':') { while (CONS.includes(at())) i += dir; continue; }
    if (c === '^') { if (!CONS.includes(at())) return false; i += dir; continue; }
    if (c === '.') { if (!'BDVGJLMNRWZ'.includes(at())) return false; i += dir; continue; }
    if (c === '+') { if (!'EIY'.includes(at())) return false; i += dir; continue; }
    if (c === '%') {
      if (dir !== 1) return false;
      const rest = word.slice(i);
      const suf = ['ING', 'ELY', 'ER', 'ES', 'ED', 'E'].find((s) => rest.startsWith(s));
      if (!suf) return false;
      i += suf.length; continue;
    }
    if (at() !== c) return false;
    i += dir;
  }
  return true;
}

export class G2P {
  private rules = new Map<string, Rule[]>();

  constructor(private lex: Lexicon, nrl: NrlRules = {}) {
    for (const [letter, list] of Object.entries(nrl)) {
      this.rules.set(letter, list.map((r) => {
        const [lhs, rhs] = r.split('=');
        const a = lhs.indexOf('['), b = lhs.indexOf(']');
        return { left: lhs.slice(0, a), match: lhs.slice(a + 1, b), right: lhs.slice(b + 1), out: rhs.trim().split(/\s+/).filter(Boolean) };
      }));
    }
  }

  /** A sentence → phonemes with punctuation kept (the Kokoro tokenizer's own symbols only). */
  phonemize(text: string): string {
    const out: string[] = [];
    for (const tok of normalize(text).match(/[A-Za-z']+|[;:,.!?—…"“”()]/g) ?? []) {
      if (/^[;:,.!?—…"“”()]$/.test(tok)) {
        // Punctuation sticks to the previous word, like misaki: "kˈæt, dˈɑɡ."
        if (out.length) out[out.length - 1] += tok; else out.push(tok);
        continue;
      }
      const ph = this.word(tok);
      if (ph) out.push(ph);
    }
    return out.join(' ');
  }

  /** One word: lexicon, possessive, compound split, then letter-to-sound rules. */
  word(raw: string): string {
    const w = raw.toLowerCase().replace(/^'+|'+$/g, '');
    if (!w) return '';
    const hit = this.lex[w];
    if (hit) return flap(hit);
    if (w.endsWith("'s")) {
      const base = this.word(w.slice(0, -2));
      if (base) return base + (/[sz]$/.test(base) ? 'ᵻz' : /[ptkfθ]$/.test(base) ? 's' : 'z');
    }
    if (w.length === 1) return this.letter(w);
    const parts = this.split(w);
    if (parts) return parts.map((p) => flap(this.lex[p])).join('');
    return this.rulesFor(w);
  }

  /** Spell a single letter ("S M G"). */
  private letter(c: string): string {
    const names: Record<string, string> = { a: 'ˈA', i: 'ˈI', o: 'ˈO', u: 'jˈu', e: 'ˈi', y: 'wˈI', w: 'dˈʌbᵊlju', h: 'ˈAʧ', r: 'ˈɑɹ', s: 'ˈɛs', x: 'ˈɛks', z: 'zˈi', q: 'kjˈu' };
    return names[c] ?? this.lex[c] ?? '';
  }

  /** Split an unknown word into 2-3 known words (fewest pieces, each ≥ 3 letters): "kraken" fails, "iceteaonly" works. */
  private split(w: string): string[] | null {
    const n = w.length;
    const best: (string[] | null)[] = new Array(n + 1).fill(null);
    best[0] = [];
    for (let i = 0; i < n; i++) {
      if (!best[i] || best[i]!.length >= 3) continue;
      for (let j = i + 3; j <= n; j++) {
        const piece = w.slice(i, j);
        if (!this.lex[piece]) continue;
        const cand = [...best[i]!, piece];
        if (!best[j] || cand.length < best[j]!.length) best[j] = cand;
      }
    }
    return best[n] && best[n]!.length >= 2 ? best[n] : null;
  }

  /** NRL letter-to-sound rules; primary stress on the first vowel. */
  private rulesFor(w: string): string {
    const word = ` ${w.toUpperCase().replace(/[^A-Z]/g, '')} `;
    const phones: string[] = [];
    let i = 1;
    while (i < word.length - 1) {
      const list = this.rules.get(word[i]);
      let moved = false;
      for (const r of list ?? []) {
        if (!word.startsWith(r.match, i)) continue;
        if (!ctxMatch(r.left, word, i - 1, -1) || !ctxMatch(r.right, word, i + r.match.length, 1)) continue;
        for (const p of r.out) phones.push(NRL_PH[p.replace(/\d$/, '')] ?? '');
        i += r.match.length;
        moved = true;
        break;
      }
      if (!moved) i++;
    }
    let s = phones.join('');
    const v = s.search(VOWEL_PH);
    if (v >= 0) s = `${s.slice(0, v)}ˈ${s.slice(v)}`;
    return s;
  }
}

/** US flapping, as misaki does: t/d between a vowel and an unstressed vowel → ɾ ("mˈIti" → "mˈIɾi"). */
export function flap(ph: string): string {
  return ph.replace(/([ɑæʌɔWəIɛAiOYʊuɪ]ɹ?)[td](?=[əɪiAIOWYʊuᵊ])/g, '$1ɾ');
}

/** The Kokoro v1.0 tokenizer's symbol set (US English subset we emit, plus punctuation and space). */
export const KOKORO_SYMBOLS = new Set([...`;:,.!?—…"“”() AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ`]);
