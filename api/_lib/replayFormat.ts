/**
 * Server-side sanity check of an uploaded .faereplay. Self-contained (the function can't import the
 * client's extensionless ESM modules): checks the magic header and format version written by the
 * Recorder; the trainer does the full decode when it consumes the file.
 */
export const REPLAY_MAGIC = 'FAER';
export const REPLAY_VERSIONS = new Set([1]);
const MIN_BYTES = 16;

export function validateReplay(bytes: Uint8Array): string | null {
  if (bytes.byteLength < MIN_BYTES) return 'too short';
  for (let i = 0; i < REPLAY_MAGIC.length; i++) if (bytes[i] !== REPLAY_MAGIC.charCodeAt(i)) return 'bad magic';
  const version = bytes[REPLAY_MAGIC.length];
  if (!REPLAY_VERSIONS.has(version)) return `unsupported version ${version}`;
  return null;
}
