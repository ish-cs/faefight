#!/usr/bin/env node
/**
 * Build the commentary voice's English lexicon from CMUdict (BSD-2-Clause, Carnegie Mellon University):
 * ARPAbet pronunciations → the phoneme symbols Kokoro was trained on (misaki's US set: A=eɪ I=aɪ O=oʊ
 * W=aʊ Y=ɔɪ ʤ ʧ ɾ ᵊ, stress marks before the vowel). No eSpeak, nothing GPL.
 *   node scripts/build-lexicon.mjs <cmudict.dict> <out.json>
 * cmudict.dict: https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const ARPA = {
  AA: 'ɑ', AE: 'æ', AO: 'ɔ', AW: 'W', AY: 'I', EH: 'ɛ', EY: 'A', IH: 'ɪ', IY: 'i', OW: 'O', OY: 'Y', UH: 'ʊ', UW: 'u',
  B: 'b', CH: 'ʧ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'ʤ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p',
  R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

/** One ARPAbet pronunciation ("K AE1 T") → misaki-style US phonemes ("kˈæt"). */
export function arpaToMisaki(arpa) {
  let out = '';
  for (const tok of arpa.trim().split(/\s+/)) {
    const m = /^([A-Z]+)([012])?$/.exec(tok);
    if (!m) throw new Error(`bad ARPAbet token ${tok} in "${arpa}"`);
    const [, ph, stress] = m;
    if (ph === 'AH') out += stress === '0' ? 'ə' : `${stress === '1' ? 'ˈ' : 'ˌ'}ʌ`;
    else if (ph === 'ER') out += stress === '0' || stress === undefined ? 'əɹ' : `${stress === '1' ? 'ˈ' : 'ˌ'}ɜɹ`;
    else {
      const sym = ARPA[ph];
      if (!sym) throw new Error(`unknown ARPAbet phoneme ${ph}`);
      out += (stress === '1' ? 'ˈ' : stress === '2' ? 'ˌ' : '') + sym;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) { console.error('usage: build-lexicon.mjs <cmudict.dict> <out.json>'); process.exit(2); }
  const lex = {};
  let n = 0;
  for (const line of readFileSync(src, 'utf8').split('\n')) {
    const t = line.replace(/#.*/, '').trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    const word = t.slice(0, sp);
    if (/\(\d+\)$/.test(word) || !/^[a-z][a-z']*$/.test(word)) continue; // first pronunciation only; plain words
    lex[word] = arpaToMisaki(t.slice(sp + 1));
    n++;
  }
  const out = {
    _license: 'Derived from CMUdict, Copyright (C) 1993-2015 Carnegie Mellon University. All rights reserved. BSD-2-Clause: https://github.com/cmusphinx/cmudict/blob/master/LICENSE',
    words: lex,
  };
  writeFileSync(dst, JSON.stringify(out));
  console.log(`lexicon: ${n} words → ${dst}`);
}
