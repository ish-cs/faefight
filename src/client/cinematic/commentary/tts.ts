/**
 * Text-to-speech behind a small interface, so a premium voice provider can replace the browser's later
 * without touching the commentator. Today: BrowserTts (window.speechSynthesis), no network, no keys.
 */

/** Two commentators: play-by-play (fast, high energy) and colour (a touch lower and calmer). */
export type Persona = 'pbp' | 'colour';

export interface SpeakOpts {
  persona: Persona;
  /** 0..1 importance: louder, faster and higher the bigger the moment. */
  intensity: number;
  /** Output volume 0..1 (Settings → Commentary volume). */
  volume: number;
  /** Called once when the line has finished (or was cancelled / failed). */
  onEnd?: () => void;
}

export interface Tts {
  /** True when this provider can make sound here (false: captions only). */
  readonly available: boolean;
  speak(text: string, opts: SpeakOpts): void;
  /** Stop the current line now (an urgent call interrupting colour). */
  cancel(): void;
}

/** Captions-only stand-in when no speech is possible (tests, browsers without speechSynthesis). */
export class SilentTts implements Tts {
  readonly available = false;
  speak(_text: string, opts: SpeakOpts) { opts.onEnd?.(); }
  cancel() {}
}

/** Name fragments of the best-sounding English voices, best first (macOS enhanced/premium, then Google/MS neural). */
const PREFERRED = [
  /premium/i, /enhanced/i, /siri/i, /neural/i, /natural/i, /online/i,
  /\b(evan|nathan|tom|alex|daniel|aaron|arthur|oliver|reed|zoe|ava|allison|samantha)\b/i,
  /google (us|uk) english/i,
];

/** Rank a voice: English first, then the preferred-name list, then local over remote. Lower is better. */
export function voiceRank(v: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>): number {
  if (!/^en([-_]|$)/i.test(v.lang)) return 1000;
  const i = PREFERRED.findIndex((re) => re.test(v.name));
  const novelty = /(bells|bubbles|cellos|zarvox|whisper|trinoids|organ|bahh|boing|jester|bad news|good news|superstar|wobble|albert|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed \(|rocko|sandy|shelley)/i.test(v.name);
  return (novelty ? 500 : 0) + (i < 0 ? 100 : i * 10) + (/^en[-_](us|gb)/i.test(v.lang) ? 0 : 3) + (v.localService ? 0 : 1);
}

/** Pick the play-by-play and colour voices: the two best-ranked distinct English voices (or the same one twice). */
export function pickVoices<V extends Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>>(voices: readonly V[]): { pbp: V | null; colour: V | null } {
  const en = voices.filter((v) => voiceRank(v) < 1000).sort((a, b) => voiceRank(a) - voiceRank(b));
  return { pbp: en[0] ?? null, colour: en[1] ?? en[0] ?? null };
}

/** Sportscaster delivery per persona: base rate/pitch, plus a lift with intensity. */
export function delivery(persona: Persona, intensity: number): { rate: number; pitch: number } {
  const k = Math.min(1, Math.max(0, intensity));
  return persona === 'pbp'
    ? { rate: 1.08 + 0.17 * k, pitch: 1.05 + 0.2 * k }
    : { rate: 1.0 + 0.08 * k, pitch: 0.92 + 0.08 * k };
}

type SynthLike = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'> & {
  addEventListener?: (t: 'voiceschanged', fn: () => void) => void;
};
type UtterCtor = new (text: string) => SpeechSynthesisUtterance;

export class BrowserTts implements Tts {
  readonly available: boolean;
  private voices: { pbp: SpeechSynthesisVoice | null; colour: SpeechSynthesisVoice | null } = { pbp: null, colour: null };
  private current: SpeechSynthesisUtterance | null = null;

  constructor(
    private synth: SynthLike | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null,
    private Utter: UtterCtor | null = typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null,
  ) {
    this.available = !!synth && !!Utter;
    if (!this.available) { console.info('[commentary] speechSynthesis unavailable: captions only'); return; }
    this.loadVoices();
    // Chrome fills the list asynchronously.
    synth!.addEventListener?.('voiceschanged', () => this.loadVoices());
  }

  private loadVoices() {
    const all = this.synth!.getVoices();
    if (!all.length) return;
    this.voices = pickVoices(all);
    console.info(`[commentary] voices: play-by-play "${this.voices.pbp?.name ?? 'default'}", colour "${this.voices.colour?.name ?? 'default'}" (${all.length} available)`);
  }

  speak(text: string, opts: SpeakOpts) {
    if (!this.available) { opts.onEnd?.(); return; }
    const u = new this.Utter!(text);
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
