/**
 * Uploads match recordings to /api/replays in the background so the bots can learn from every match
 * (scripts/auto-improve.ts downloads them nightly). Always on in deployed builds, no opt-out; only the
 * machine running the sim (vs-bot player or online host) has a recording, so guests never upload.
 *
 * Privacy: recordings carry player names and gameplay only. Chat never reaches them: the recorder keeps
 * a fixed list of sim events and strips anything chat-like before encoding (withoutChat in
 * src/sim/replay/format.ts), in the sim worker, so this page never has to decode a recording.
 *
 * Never in the way of the game: nothing here decodes or re-encodes (that would be one long main-thread
 * task); each upload waits for an idle moment, uploads run one at a time, and anything over the size
 * cap is dropped instead of sent.
 */
import { defaultDeps, postWithRetry, type UploadDeps } from './upload';

/** Unfinished matches (left early / tab closed) shorter than this aren't worth uploading. */
export const MIN_UNFINISHED_SEC = 60;
/** Same cap as the endpoint (api/_lib/ingest.ts MAX_REPLAY_BYTES). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type RecordingMeta = { id: string; unfinished: boolean; duration: number };

/** Resolve at the next idle moment (or after `timeoutMs` at the latest), so an upload never starts mid-frame-burst. */
export function whenIdle(timeoutMs = 10_000): Promise<void> {
  const ric = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  return new Promise((resolve) => (ric ? ric(() => resolve(), { timeout: timeoutMs }) : setTimeout(resolve, 0)));
}

export class ReplayUploader {
  /** Replay id → uploaded final (true) or partial (false). */
  private sent = new Map<string, boolean>();
  /** Uploads run one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: UploadDeps = defaultDeps(), private url = '/api/replays', private idle: () => Promise<void> = whenIdle) {}

  /** Decide whether a recording should go up now. */
  shouldUpload(meta: RecordingMeta): boolean {
    const prev = this.sent.get(meta.id);
    if (prev === true) return false; // final already uploaded
    if (!meta.unfinished) return true;
    if (prev === false) return false; // one partial per match; the final one may still follow
    return meta.duration >= MIN_UNFINISHED_SEC;
  }

  /** Upload in the background (never throws: a failed upload must not affect the game). */
  share(bytes: Uint8Array, meta: RecordingMeta): Promise<boolean> {
    if (!this.shouldUpload(meta)) return Promise.resolve(false);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      console.warn(`[replays] ${meta.id} too large to upload (${bytes.byteLength} B > ${MAX_UPLOAD_BYTES} B); dropped`);
      return Promise.resolve(false);
    }
    this.sent.set(meta.id, !meta.unfinished);
    const job = this.queue.then(() => this.upload(bytes, meta));
    this.queue = job;
    return job;
  }

  /** Resolves once every queued upload is done, or after `timeoutMs` (leaving a match waits for its recording to go up). */
  settled(timeoutMs = 8000): Promise<void> {
    return Promise.race([this.queue.then(() => {}, () => {}), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  private async upload(bytes: Uint8Array, meta: RecordingMeta): Promise<boolean> {
    try {
      await this.idle();
      const r = await postWithRetry(this.url, new Blob([bytes as Uint8Array<ArrayBuffer>]), 'application/octet-stream', this.deps, { attempts: 5, baseDelayMs: 3000 });
      if (r.ok) console.info(`[replays] uploaded ${meta.id}${meta.unfinished ? ' (unfinished)' : ''} (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
      else if (meta.unfinished) this.sent.delete(meta.id);
      return r.ok;
    } catch (e) {
      console.warn('[replays] upload failed', e);
      return false;
    }
  }
}

/** The page-wide uploader (null when data capture is off, i.e. local dev). */
export let replayUploader: ReplayUploader | null = null;
export function installReplayUploads(): ReplayUploader {
  replayUploader = new ReplayUploader();
  return replayUploader;
}
