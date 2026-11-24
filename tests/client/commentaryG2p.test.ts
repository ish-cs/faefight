import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flap, G2P, KOKORO_SYMBOLS, normalize, numberToWords } from '../../src/client/cinematic/commentary/g2p';
import { KEY_VARS, LINES, type LineKey } from '../../src/client/cinematic/commentary/lines';
import { NRL_RULES } from '../../src/client/cinematic/commentary/nrlRules';
// @ts-expect-error plain .mjs build script
import { arpaToMisaki } from '../../scripts/build-lexicon.mjs';

const lex = JSON.parse(readFileSync('public/commentary/lexicon-en.json', 'utf8')) as { _license: string; words: Record<string, string> };
const g = new G2P(lex.words, NRL_RULES);
const bad = (s: string) => [...s].filter((c) => !KOKORO_SYMBOLS.has(c));

describe('GPL-free G2P for the neural commentary voice', () => {
  it('lexicon is CMUdict-derived, attributed, and in Kokoro symbols', () => {
    expect(lex._license).toMatch(/Carnegie Mellon University.*BSD-2-Clause/);
    expect(Object.keys(lex.words).length).toBeGreaterThan(100_000);
    expect(lex.words.cat).toBe('kˈæt');
    expect(arpaToMisaki('K AE1 T')).toBe('kˈæt');
    expect(arpaToMisaki('S EH1 V AH0 N T IY0 N')).toBe('sˈɛvəntin');
    expect(arpaToMisaki('B ER1 D')).toBe('bˈɜɹd');
    expect(arpaToMisaki('F AY1 N D ER0')).toBe('fˈIndəɹ');
  });

  it('numbers, money and gamer names become words', () => {
    expect(numberToWords(1011)).toBe('one thousand eleven');
    expect(numberToWords(70)).toBe('seventy');
    expect(normalize('$152 for BigWalrus60, Mighty.Ana and Skipper_Harbor (SMG, 12 HP)'))
      .toBe('one hundred fifty two dollars for Big Walrus sixty, Mighty Ana and Skipper Harbor (S M G, twelve health)');
  });

  it('phonemizes lines with punctuation kept and only tokenizer symbols', () => {
    expect(g.phonemize('What a play!')).toBe('wˈʌt ə plˈA!');
    const p = g.phonemize("HUGE seal on BigWalrus60's bunker by JollyKraken8!");
    expect(p).toBe('hjˈuʤ sˈil ˈɑn bˈɪɡ wˈɔlɹəs sˈɪkstiz bˈʌŋkəɹ bˈI ʤˈɑli kɹˈAkɛn ˈAt!');
    expect(bad(p)).toEqual([]);
  });

  it('compound names split into known words; unknown words fall back to the NRL rules', () => {
    expect(g.word('IceTeaOnly'.toLowerCase())).toBe('ˈIstˈiˈOnli');
    expect(g.word('kraken')).toMatch(/^kɹˈ/);
    expect(g.word('zzqx')).not.toBe('');
  });

  it('US flapping like misaki', () => {
    expect(flap('mˈIti')).toBe('mˈIɾi');
    expect(flap('kˈæt')).toBe('kˈæt');
  });

  it('every commentary template phonemizes to valid symbols (with sample names)', () => {
    const vars = { a: 'Captain_Walrus', b: 'IceTeaOnly', w: 'the rifle', d: 42, n: 7, g: 3 };
    for (const k of Object.keys(LINES) as LineKey[]) {
      for (const tpl of LINES[k]) {
        const text = tpl.replace(/\{([a-z])\}/g, (_m, v: string) => (KEY_VARS[k].includes(v as never) ? String(vars[v as keyof typeof vars]) : ''));
        const p = g.phonemize(text);
        expect(p.length, text).toBeGreaterThan(0);
        expect(bad(p), `${text} → ${p}`).toEqual([]);
      }
    }
  });
});
