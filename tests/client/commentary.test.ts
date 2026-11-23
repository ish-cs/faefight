import { describe, expect, it, vi } from 'vitest';
import { Commentator, REPEAT_SEC, STALE_LOW, type Prio } from '../../src/client/cinematic/commentary/commentator';
import { fill, KEY_VARS, LINES, type LineKey } from '../../src/client/cinematic/commentary/lines';
import { BrowserTts, delivery, pickVoices, RecordingSynth, type SpeakOpts, type Tts } from '../../src/client/cinematic/commentary/tts';
import { defaultSettings, sanitizeSettings, SETTINGS_KEY, SettingsStore } from '../../src/client/settings/store';
import type { MatchEvent, MatchEventType, PlayerState, Snapshot } from '../../src/sim/types';

const NAMES = ['Ava', 'Bruno', 'Cleo', 'Dax'];

function player(id: number, over: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: NAMES[id - 1] ?? `P${id}`, isBot: true, island: id - 1, pos: { x: id * 10, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, hp: 100, shield: 0, alive: true, eliminated: false, kills: 0, deaths: 0, breakoutUntil: null,
    lastDamagedAt: -1, drinking: null, inv: { cash: 0 },
    ...over,
  } as unknown as PlayerState;
}

function snap(t: number, events: MatchEvent[] = [], players: PlayerState[] = NAMES.map((_, i) => player(i + 1)), over: Partial<Snapshot> = {}): Snapshot {
  return {
    time: t, tick: Math.round(t * 30), players, pieces: [], loot: [], generators: [], genLevels: players.map(() => 1),
    sealed: players.map(() => false), waterY: 0, suddenDeath: false, winner: null, events, ...over,
  } as Snapshot;
}

const ev = (type: MatchEventType, data: Record<string, unknown>, t = 1): MatchEvent => ({ t, type, data });

/** Fake TTS: records lines; `hold` keeps each line "speaking" until finished by hand. */
class FakeTts implements Tts {
  available = true;
  said: { text: string; opts: SpeakOpts }[] = [];
  cancels = 0;
  constructor(private hold = false) {}
  speak(text: string, opts: SpeakOpts) { this.said.push({ text, opts }); if (!this.hold) opts.onEnd?.(); }
  cancel() { this.cancels++; const l = this.said.at(-1); l?.opts.onEnd?.(); }
  end() { this.said.at(-1)?.opts.onEnd?.(); }
}

function rig(hold = false) {
  let t = 100;
  const tts = new FakeTts(hold);
  const caps: (string | null)[] = [];
  const ducks: boolean[] = [];
  let seed = 1;
  const c = new Commentator({
    tts, now: () => t, rng: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    onCaption: (x) => caps.push(x ? x.text : null), duck: (on) => ducks.push(on),
  });
  c.setActive(true);
  return { c, tts, caps, ducks, adv: (s: number) => { t += s; c.update(); }, get t() { return t; } };
}

/** Feed snapshots and let the queue drain: returns the keys spoken. */
function drain(r: ReturnType<typeof rig>, steps = 40) {
  for (let i = 0; i < steps; i++) r.adv(0.5);
  return r.c.log.map((l) => l.key);
}

describe('commentary line bank', () => {
  it('hundreds of lines, every key has variety, no duplicate templates', () => {
    const all = Object.values(LINES).flat();
    expect(all.length).toBeGreaterThanOrEqual(250);
    expect(new Set(all).size).toBe(all.length);
    for (const [k, lines] of Object.entries(LINES)) expect(lines.length, k).toBeGreaterThanOrEqual(5);
  });

  it('every template only uses the placeholders its key provides', () => {
    for (const k of Object.keys(LINES) as LineKey[]) {
      const allowed = new Set<string>(KEY_VARS[k]);
      for (const tpl of LINES[k]) for (const m of tpl.matchAll(/\{([a-z])\}/g)) expect(allowed.has(m[1]), `${k}: ${tpl}`).toBe(true);
      const vars = Object.fromEntries(KEY_VARS[k].map((v) => [v, 'X']));
      for (const tpl of LINES[k]) expect(fill(tpl, vars)).not.toMatch(/[{}]/);
    }
  });

  it('fill throws on a missing placeholder', () => {
    expect(() => fill('{a} wins', {})).toThrow(/needs \{a\}/);
  });
});

describe('Commentator', () => {
  it('opens with a match-start line, then calls a kill with both names substituted', () => {
    const r = rig();
    r.c.onSnapshot(snap(1));
    r.adv(0.5);
    r.c.onSnapshot(snap(2, [ev('hit', { target: 2, by: 1, amount: 30, weapon: 'smg', pos: { x: 15, y: 0, z: 0 } }), ev('kill', { victim: 2, killer: 1, inWater: false })]));
    drain(r);
    expect(r.c.log[0].key).toBe('start');
    const kill = r.c.log.find((l) => l.key === 'firstBlood')!;
    expect(kill.text).toMatch(/Ava|Bruno/);
    expect(r.c.log.every((l) => !/[{}]/.test(l.text))).toBe(true);
  });

  it('covers every commentated event type', () => {
    const r = rig();
    const ps = NAMES.map((_, i) => player(i + 1, { inv: { cash: 900 } as never }));
    r.c.onSnapshot(snap(1, [], ps, { pieces: Array.from({ length: 12 }, (_, i) => ({ id: i, kind: 'wall', owner: 3, pos: { x: 0, y: 0, z: 0 }, rotY: 0, hp: 1 })) as never, genLevels: [3, 1, 1, 1] }));
    const steps: [MatchEvent[], LineKey][] = [
      [[ev('hit', { target: 2, by: 1, amount: 30, weapon: 'smg' }), ev('kill', { victim: 2, killer: 1, inWater: false })], 'firstBlood'],
      [[ev('hit', { target: 3, by: 4, amount: 30, weapon: 'rifle', part: 'head' }), ev('kill', { victim: 3, killer: 4, inWater: false })], 'killHead'],
      [[ev('hit', { target: 1, by: 3, amount: 90, weapon: 'rocket' }), ev('kill', { victim: 1, killer: 3, inWater: false })], 'killRocket'],
      [[ev('hit', { target: 4, by: 2, amount: 30, weapon: 'rifle', pos: { x: 80, y: 0, z: 0 } }), ev('kill', { victim: 4, killer: 2, inWater: false })], 'killLong'],
      [[ev('hit', { target: 2, by: 1, amount: 30, weapon: 'shotgun' }), ev('kill', { victim: 2, killer: 1, inWater: false })], 'killClose'],
      [[ev('hit', { target: 1, by: 4, amount: 30, weapon: 'grenade' }), ev('kill', { victim: 1, killer: 4, inWater: false })], 'killExplosive'],
      [[ev('hit', { target: 2, by: 3, amount: 10, weapon: 'fists' }), ev('kill', { victim: 2, killer: 3, inWater: false })], 'killFists'],
      [[ev('kill', { victim: 3, killer: 4, inWater: true })], 'killWater'],
      [[ev('kill', { victim: 1, killer: 2, inWater: false, via: 'barrel' })], 'killVia'],
      [[ev('kill', { victim: 1, killer: null, inWater: false, cause: 'storm' })], 'killEnv'],
      [[ev('sealed', { island: 1, owner: 2, by: 1 })], 'sealed'],
      [[ev('unsealed', { island: 1, owner: 2, by: null })], 'unsealed'],
      [[ev('trapped', { player: 2, until: 30 })], 'trapped'],
      [[ev('escaped', { player: 2 })], 'escaped'],
      [[ev('suddenDeath', {})], 'suddenDeath'],
      [[ev('lightning', { pos: { x: 0, y: 0, z: 0 } })], 'storm'],
      [[ev('centerCollect', { by: 3, station: 'gold', cash: 120 })], 'gold'],
      [[ev('hit', { target: 4, by: 1, amount: 50, weapon: 'rocket' })], 'rocketHit'],
    ];
    let t = 2;
    for (const [events, key] of steps) {
      r.c.onSnapshot(snap(t++, events, ps));
      drain(r, 30);
      expect(r.c.log.at(-1)?.key === key || r.c.log.some((l) => l.key === key), key).toBe(true);
    }
    // Revenge: Ava was last killed by Bruno (the barrel); Ava now gets him back.
    r.adv(20);
    r.c.onSnapshot(snap(t++, [ev('kill', { victim: 2, killer: 1, inWater: false })], ps));
    expect(drain(r, 30)).toContain('killRevenge');
    // Multi-kill: Dax twice within 10 s.
    r.adv(30);
    r.c.onSnapshot(snap(t++, [ev('kill', { victim: 1, killer: 4, inWater: false })], ps));
    r.c.onSnapshot(snap(t++, [ev('kill', { victim: 2, killer: 4, inWater: false })], ps));
    expect(drain(r, 30)).toContain('killMulti2');
    // Clutch: killer on low hp.
    r.adv(30);
    const low = ps.map((p) => (p.id === 2 ? { ...p, hp: 12 } : p));
    r.c.onSnapshot(snap(t++, [ev('kill', { victim: 1, killer: 2, inWater: false })], low));
    expect(drain(r, 30)).toContain('killClutch');
    // Heal mid-fight: hurt, low, starts drinking.
    r.c.onSnapshot(snap(t++, [ev('hit', { target: 3, by: 1, amount: 60, weapon: 'smg' })], ps.map((p) => (p.id === 3 ? { ...p, hp: 20 } : p))));
    r.c.onSnapshot(snap(t++, [], ps.map((p) => (p.id === 3 ? { ...p, hp: 20, drinking: { kind: 'healPotion', doneAt: 99 } } : p))));
    expect(drain(r, 30)).toContain('heal');
    // Leader: someone reaches 3 kills alone at the top.
    r.c.onSnapshot(snap(t++, [], ps.map((p) => (p.id === 4 ? { ...p, kills: 5 } : p))));
    expect(drain(r, 30)).toContain('leader');
    // Elimination (with and without a kill), final two, all sealed, win + recap.
    const elim1 = ps.map((p) => (p.id === 1 ? { ...p, eliminated: true, alive: false } : p));
    r.c.onSnapshot(snap(t++, [ev('eliminated', { player: 1 })], elim1));
    expect(drain(r, 30)).toContain('eliminated');
    r.c.onSnapshot(snap(t++, [], elim1, { sealed: [true, true, true, true] }));
    expect(drain(r, 30)).toContain('allSealed');
    const elim2 = elim1.map((p) => (p.id === 2 ? { ...p, eliminated: true, alive: false } : p));
    r.c.onSnapshot(snap(t++, [ev('kill', { victim: 2, killer: 3, inWater: false }), ev('eliminated', { player: 2 })], elim2));
    expect(drain(r, 30)).toContain('finalTwo');
    r.c.onSnapshot(snap(t++, [ev('win', { winner: 3 })], elim2, { winner: 3 }));
    const keys = drain(r, 40);
    expect(keys).toContain('win');
    expect(keys).toContain('recap');
    // Director shots and quiet-moment colour.
    r.adv(30);
    r.c.onShot({ playerId: 3, otherId: 4, reason: 'duel', kind: 'shoulder', score: 1, t: 50 });
    r.c.onShot({ playerId: 4, reason: 'parkour', kind: 'orbit', score: 1, t: 50 });
    const k2 = drain(r, 60);
    expect(k2).toContain('shotDuel');
    expect(k2).toContain('shotParkour');
    expect(k2.some((k) => k.startsWith('colour'))).toBe(true);
  });

  it('a kill that ends a life calls the elimination in one line', () => {
    const r = rig();
    const ps = NAMES.map((_, i) => player(i + 1, { eliminated: i === 1 }));
    r.c.onSnapshot(snap(1, [ev('kill', { victim: 2, killer: 1, inWater: false }), ev('eliminated', { player: 2 })], ps));
    const keys = drain(r);
    expect(keys).toContain('killElim');
    expect(keys).not.toContain('eliminated');
  });

  it('never repeats a template within REPEAT_SEC', () => {
    const r = rig();
    const texts: string[] = [];
    const n = LINES.escaped.length;
    for (let i = 0; i < n; i++) {
      r.c.say('escaped', { a: 'Ava' }, 3);
      r.adv(5);
      texts.push(r.c.log.at(-1)!.text);
    }
    expect(new Set(texts).size).toBe(n);
    expect(n * 5).toBeLessThan(REPEAT_SEC);
    // Exhausted: falls back to the least recently used, never crashes.
    r.c.say('escaped', { a: 'Ava' }, 3);
    r.adv(5);
    expect(r.c.log.at(-1)!.text).toBe(texts[0]);
  });

  it('urgent calls interrupt colour; nothing talks over a big call; stale low-priority lines drop', () => {
    const r = rig(true);
    r.c.say('colourIdle', {}, 0);
    r.adv(0.5);
    expect(r.tts.said).toHaveLength(1);
    r.c.say('escaped', { a: 'Ava' }, 3);
    r.adv(0.1);
    expect(r.tts.cancels).toBe(1);
    expect(r.c.log.at(-1)!.key).toBe('escaped');
    // A major call is speaking: another urgent one waits its turn (no cancel).
    r.c.say('suddenDeath', {}, 3);
    r.adv(0.1);
    expect(r.tts.cancels).toBe(1);
    expect(r.c.log.at(-1)!.key).toBe('escaped');
    // A low-priority line queued now goes stale before the floor frees.
    r.c.say('react', {}, 1 as Prio);
    r.adv(STALE_LOW + 0.5);
    r.tts.end();
    for (let i = 0; i < 4; i++) r.adv(0.4);
    const keys = r.c.log.map((l) => l.key);
    expect(keys).toContain('suddenDeath');
    expect(keys).not.toContain('react');
  });

  it('ducks the game mix while speaking and clears captions afterwards', () => {
    const r = rig(true);
    r.c.say('trapped', { a: 'Bruno' }, 2);
    r.adv(0.1);
    expect(r.ducks).toEqual([true]);
    expect(r.caps.at(-1)).toMatch(/Bruno/);
    r.tts.end();
    r.adv(2);
    expect(r.ducks).toEqual([true, false]);
    expect(r.caps.at(-1)).toBeNull();
  });

  it('says nothing while inactive', () => {
    const r = rig();
    r.c.setActive(false);
    r.c.onSnapshot(snap(1, [ev('suddenDeath', {})]));
    drain(r);
    expect(r.c.log).toHaveLength(0);
  });

  it('silent TTS (no speechSynthesis) still paces captions by the line length', () => {
    let t = 0;
    const c = new Commentator({ tts: { available: false, speak: (_x, o) => o.onEnd?.(), cancel() {} }, now: () => t });
    c.setActive(true);
    c.say('suddenDeath', {}, 3);
    c.say('trapped', { a: 'Cleo' }, 2);
    c.update();
    expect(c.log).toHaveLength(1);
    t += 0.5; c.update();
    expect(c.log).toHaveLength(1);
    t += 5; c.update(); t += 0.5; c.update();
    expect(c.log).toHaveLength(2);
  });
});

describe('BrowserTts', () => {
  const voice = (name: string, lang = 'en-US', localService = true) => ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;

  it('prefers enhanced English voices and skips novelty / non-English ones', () => {
    const v = pickVoices([voice('Albert'), voice('Thomas', 'fr-FR'), voice('Samantha'), voice('Evan (Enhanced)'), voice('Bad News')]);
    expect(v.pbp?.name).toBe('Evan (Enhanced)');
    expect(v.colour?.name).toBe('Samantha');
    expect(pickVoices([voice('Amelie', 'fr-FR')])).toEqual({ pbp: null, colour: null });
  });

  it('speaks through speechSynthesis with sportscaster delivery, and cancel releases the caller', () => {
    const spoken: SpeechSynthesisUtterance[] = [];
    const synth = { speak: vi.fn((u: SpeechSynthesisUtterance) => spoken.push(u)), cancel: vi.fn(), getVoices: () => [voice('Evan (Enhanced)'), voice('Samantha')], addEventListener: vi.fn() };
    class U { voice: unknown = null; lang = ''; rate = 1; pitch = 1; volume = 1; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null; constructor(public text: string) {} }
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const tts = new BrowserTts(synth as never, U as never);
    info.mockRestore();
    expect(tts.available).toBe(true);
    const onEnd = vi.fn();
    tts.speak('What a play!', { persona: 'pbp', intensity: 1, volume: 0.5, onEnd });
    const u = spoken[0] as unknown as U;
    expect(u.text).toBe('What a play!');
    expect((u.voice as SpeechSynthesisVoice).name).toBe('Evan (Enhanced)');
    expect(u.rate).toBeCloseTo(delivery('pbp', 1).rate);
    expect(u.pitch).toBeGreaterThan(1);
    expect(u.volume).toBe(0.5);
    tts.cancel();
    expect(synth.cancel).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    u.onend?.(); // a late real end event doesn't double-fire
    expect(onEnd).toHaveBeenCalledTimes(1);
    tts.speak('Calm line', { persona: 'colour', intensity: 0, volume: 1, onEnd });
    expect(((spoken[1] as unknown as U).voice as SpeechSynthesisVoice).name).toBe('Samantha');
  });

  it('without speechSynthesis it is unavailable and ends lines at once', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const tts = new BrowserTts(null, null);
    info.mockRestore();
    const onEnd = vi.fn();
    tts.speak('hi', { persona: 'pbp', intensity: 0, volume: 1, onEnd });
    expect(tts.available).toBe(false);
    expect(onEnd).toHaveBeenCalled();
  });
});

describe('commentary settings', () => {
  it('defaults on with captions, off while spectating; values sanitize and persist', () => {
    expect(defaultSettings().audio).toMatchObject({ commentaryOn: true, commentary: 0.9, captions: true, commentarySpectate: false });
    expect(sanitizeSettings({ audio: { commentary: 4, commentaryOn: 'x', captions: false } }).audio).toMatchObject({ commentary: 1, commentaryOn: true, captions: false });
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const store = new SettingsStore(kv);
    store.update((d) => { d.audio.commentary = 0.3; d.audio.commentaryOn = false; d.audio.commentarySpectate = true; });
    expect(JSON.parse(m.get(SETTINGS_KEY)!).audio).toMatchObject({ commentary: 0.3, commentaryOn: false, commentarySpectate: true });
    expect(new SettingsStore(kv).get().audio).toMatchObject({ commentary: 0.3, commentaryOn: false, commentarySpectate: true, captions: true });
  });
});

describe('automated browsers stay silent', () => {
  it('RecordingSynth records lines and ends them on its own, never touching the OS voice', () => {
    vi.useFakeTimers();
    const synth = new RecordingSynth();
    class U { voice: unknown = null; lang = ''; rate = 1; pitch = 1; volume = 1; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null; constructor(public text: string) {} }
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const tts = new BrowserTts(synth, U as never);
    info.mockRestore();
    const onEnd = vi.fn();
    tts.speak('Down goes Bruno!', { persona: 'pbp', intensity: 1, volume: 1, onEnd });
    expect(synth.spoken).toEqual(['Down goes Bruno!']);
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
