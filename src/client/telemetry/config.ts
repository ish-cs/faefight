/**
 * Data capture is always on in deployed builds (replays + error reports go to /api on the same
 * origin), with no opt-out. Local dev and e2e (localhost) send nothing unless `?telemetry=1` forces it.
 */
export function telemetryEnabled(loc: Pick<Location, 'hostname' | 'search'> = location, prod: boolean = import.meta.env.PROD): boolean {
  if (new URLSearchParams(loc.search).get('telemetry') === '1') return true;
  return prod && loc.hostname !== 'localhost' && loc.hostname !== '127.0.0.1';
}
