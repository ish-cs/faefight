/**
 * Text-to-speech behind a small interface, so a premium voice provider can replace the browser's later
 * without touching the commentator. Today: BrowserTts (window.speechSynthesis), no network, no keys.
 * A future server-side provider (ElevenLabs / OpenAI TTS behind our own endpoint) implements the same
 * Tts interface: see PremiumTtsContract below.
 */

/** Two commentators: play-by-play (calls the action) and colour (analysis, quiet moments). */
export type Persona = 'pbp' | 'colour';

export interface SpeakOpts {
  persona: Persona;
  /** 0..1 importance. Excitement comes from the words and punctuation; this only nudges the pace. */
  intensity: number;
  /** Output volume 0..1 (Settings → Commentary volume). */
  volume: number;
  /** Called once when the line has finished (or was cancelled / failed). */
  onEnd?: () => void;
}

export interface Tts {
  /** True when this provider can make sound here (false: captions only). */
  readonly available: boolean;
  /** True while a line is still being spoken (the commentator never starts another meanwhile). */
  readonly speaking: boolean;
  speak(text: string, opts: SpeakOpts): void;
  /** Stop the current line now (only for a top-priority call). */
  cancel(): void;
}

/**
 * Future premium voice (not implemented; no keys in the client, ever). The client would POST
 * `{ text, persona, voice }` to our own endpoint (e.g. /api/tts, a Vercel function holding the provider
 * key), get back `audio/mpeg`, and play it through the AudioSystem's voice bus. A provider implementing
 * Tts with this contract drops straight into Commentary (constructor's `tts` argument).
 */
export interface PremiumTtsContract {
  endpoint: string;
  /** Provider voice ids per persona (e.g. ElevenLabs voice ids, OpenAI voice names). */
  voices: Record<Persona, string>;
  /** Fetch + decode one line; resolves when the audio is ready to play. */
  synthesize(text: string, persona: Persona): Promise<ArrayBuffer>;
}

/** Captions-only stand-in when no speech is possible (tests, browsers without speechSynthesis). */
export class SilentTts implements Tts {
  readonly available = false;
  readonly speaking = false;
  speak(_text: string, opts: SpeakOpts) { opts.onEnd?.(); }
  cancel() {}
}

type VoiceLike = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>;

/** Good-sounding English voices by name (macOS / iOS / Chrome / Edge), best first within a quality tier. */
const GOOD_NAMES = /\b(ava|zoe|evan|nathan|samantha|allison|susan|tom|noelle|joelle|serena|daniel|oliver|jamie|kate|karen|moira|tessa|aaron|nicky|alex|siri|aria|jenny|guy|davis|andrew|emma|brian|libby|ryan|sonia)\b/i;
/** Novelty / joke voices that must never commentate. */
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;

export const isEnglish = (v: VoiceLike) => /^en([-_]|$)/i.test(v.lang);

/** Rank a voice (lower is better): Premium > Enhanced/Siri/Neural > known good names > the rest. */
export function voiceRank(v: VoiceLike): number {
  if (!isEnglish(v) || NOVELTY.test(v.name)) return 1000;
  const tier = /premium/i.test(v.name) ? 0
    : /enhanced|siri|neural|natural/i.test(v.name) ? 1
    : /online/i.test(v.name) ? 2 // Edge "Microsoft X Online (Natural)" are good too
    : GOOD_NAMES.test(v.name) ? 3
    : /google/i.test(v.name) ? 4
    : 6;
  return tier * 10 + (/^en[-_](us|gb)/i.test(v.lang) ? 0 : 2) + (v.localService ? 0 : 1);
}

/** The voice's base name ("Ava (Premium)" → "ava"): two personas must not share it. */
const baseName = (n: string) => n.replace(/\s*\(.*\)\s*$/, '').replace(/^(microsoft|google|apple)\s+/i, '').split(/\s+/)[0].toLowerCase();

/** Every usable English voice, best first (the Settings picker lists these). */
export function rankedVoices<V extends VoiceLike>(voices: readonly V[]): V[] {
  return voices.filter((v) => voiceRank(v) < 1000).sort((a, b) => voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name));
}

/**
 * Pick the two personas' voices: the user's choice (by name) when installed, else the best English voice,
 * and for colour the best one with a different base name (so the two sound like two people).
 */
export function pickVoices<V extends VoiceLike>(voices: readonly V[], want: Partial<Record<Persona, string>> = {}): { pbp: V | null; colour: V | null } {
  const ranked = rankedVoices(voices);
  const byName = (n?: string) => (n ? voices.find((v) => v.name === n) ?? null : null);
  const pbp = byName(want.pbp) ?? ranked[0] ?? null;
  const colour = byName(want.colour)
    ?? ranked.find((v) => pbp && baseName(v.name) !== baseName(pbp.name))
    ?? pbp;
  return { pbp, colour };
}

/** Delivery per persona: near-natural rate and pitch (sportscaster energy comes from the words, not chipmunk pitch). */
export function delivery(persona: Persona, intensity: number): { rate: number; pitch: number } {
  const k = Math.min(1, Math.max(0, intensity));
  return persona === 'pbp' ? { rate: 1.04 + 0.08 * k, pitch: 1.0 + 0.03 * k } : { rate: 0.98, pitch: 0.97 };
}

const ACRONYMS: Record<string, string> = { SMG: 'S M G', HP: 'health' };

/**
 * Make a caption easy to say: "$152" → "152 dollars", "Mighty.Ana" / "Skipper_Harbor" → spaced names,
 * SHOUTED words → normal case (some voices spell out all-caps), acronyms spoken properly.
 */
export function speakable(text: string): string {
  return text
    .replace(/\$(\d+)/g, '$1 dollars')
    .replace(/\b([A-Za-z]+)[._]([A-Za-z0-9]+)\b/g, '$1 $2')
    .replace(/\b[A-Z]{2,}\b/g, (w) => ACRONYMS[w] ?? (w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()))
    .replace(/\s+/g, ' ')
    .trim();
}

type SynthLike = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'> & {
  readonly speaking?: boolean;
  addEventListener?: (t: 'voiceschanged', fn: () => void) => void;
};
type UtterCtor = new (text: string) => SpeechSynthesisUtterance;

/** Driven by Playwright / WebDriver (tests, screenshot and perf scripts): never make real sound. */
export const automated = () => typeof navigator !== 'undefined' && navigator.webdriver === true;

/**
 * Stand-in speechSynthesis for automated browsers: Chrome speaks through the OS speech service even
 * headless and with --mute-audio, so tests would talk out loud on the machine. This records each line
 * (window.__commentarySpoken) and ends it after its rough speaking time instead.
 */
export class RecordingSynth implements SynthLike {
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly spoken: string[] = [];
  constructor() {
    if (typeof window !== 'undefined') (window as unknown as { __commentarySpoken?: string[] }).__commentarySpoken = this.spoken;
  }
  getVoices(): SpeechSynthesisVoice[] { return []; }
  speak(u: SpeechSynthesisUtterance) {
    this.spoken.push(u.text);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; u.onend?.(new Event('end') as SpeechSynthesisEvent); }, 600 + u.text.split(/\s+/).length * 330);
  }
  cancel() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

const browserSynth = (): SynthLike | null => (automated() ? new RecordingSynth() : typeof speechSynthesis !== 'undefined' ? speechSynthesis : null);
const browserUtter = (): UtterCtor | null => (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null);

export class BrowserTts implements Tts {
  readonly available: boolean;
  private voices: { pbp: SpeechSynthesisVoice | null; colour: SpeechSynthesisVoice | null } = { pbp: null, colour: null };
  private current: SpeechSynthesisUtterance | null = null;
  private want: Partial<Record<Persona, string>> = {};

  constructor(private synth: SynthLike | null = browserSynth(), private Utter: UtterCtor | null = browserUtter()) {
    this.available = !!synth && !!Utter;
    if (!this.available) { console.info('[commentary] speechSynthesis unavailable: captions only'); return; }
    this.loadVoices();
    // Chrome fills the list asynchronously.
    synth!.addEventListener?.('voiceschanged', () => this.loadVoices());
  }

  get speaking(): boolean { return this.current !== null; }

  /** Settings → Commentary voices ('' = automatic). */
  setVoices(want: Partial<Record<Persona, string>>) {
    if (want.pbp === this.want.pbp && want.colour === this.want.colour) return;
    this.want = { ...want };
    this.loadVoices();
  }

  private loadVoices() {
    const all = this.synth!.getVoices();
    if (!all.length) return;
    this.voices = pickVoices(all, this.want);
    const en = rankedVoices(all).map((v) => v.name);
    console.info(`[commentary] voices: play-by-play "${this.voices.pbp?.name ?? 'default'}", colour "${this.voices.colour?.name ?? 'default'}"; English available (best first): ${en.join(', ') || 'none'}`);
  }

  speak(text: string, opts: SpeakOpts) {
    if (!this.available) { opts.onEnd?.(); return; }
    const u = new this.Utter!(speakable(text));
    const v = this.voices[opts.persona];
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    const d = delivery(opts.persona, opts.intensity);
    u.rate = d.rate; u.pitch = d.pitch;
    u.volume = Math.min(1, Math.max(0, opts.volume));
    let done = false;
    const end = () => { if (done) return; done = true; if (this.current === u) this.current = null; opts.onEnd?.(); };
    u.onend = end;
    u.onerror = (e) => {
      // 'interrupted' / 'canceled' are our own cancel(); anything else is worth a line.
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err !== 'interrupted' && err !== 'canceled') console.warn(`[commentary] speech failed: ${err}`);
      end();
    };
    this.current = u;
    this.synth!.speak(u);
  }

  cancel() {
    if (!this.available) return;
    const u = this.current;
    this.current = null;
    this.synth!.cancel();
    // Some engines never fire onend/onerror after cancel: release the caller ourselves.
    u?.onend?.(new Event('end') as SpeechSynthesisEvent);
  }
}

/** Every English voice installed here, best first (for the Settings picker; empty until the browser loads them). */
export function availableVoices(): string[] {
  const s = browserSynth();
  return s ? rankedVoices(s.getVoices()).map((v) => v.name) : [];
}

/** Settings → "Test voice": say a sample line in that persona's voice now. */
export function testVoice(persona: Persona, name: string, volume: number) {
  const s = browserSynth(), U = browserUtter();
  if (!s || !U) { console.info('[commentary] no speechSynthesis: cannot test the voice'); return; }
  const tts = new BrowserTts(s, U);
  tts.setVoices({ [persona]: name || undefined });
  s.cancel();
  tts.speak(persona === 'pbp' ? 'And he takes the shot. What a finish! That is how you win a fight!' : 'Smart play there. He saved his money, and now it pays off.',
    { persona, intensity: 0.8, volume });
}
