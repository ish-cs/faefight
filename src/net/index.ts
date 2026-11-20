import { BroadcastTransport } from './broadcast';
import { conditionsFrom, withConditions } from './netSim';
import { PeerTransport } from './peer';
import type { Transport } from './transport';

/**
 * `?net=local` → same-browser BroadcastChannel (dev/e2e); otherwise PeerJS over the internet.
 * `&rtt=120&jitter=20&loss=0.02` adds simulated network conditions (netSim.ts) on this tab's links.
 */
export function pickTransport(search: string): Transport {
  const t = new URLSearchParams(search).get('net') === 'local' ? new BroadcastTransport() : new PeerTransport();
  const c = conditionsFrom(search);
  return c ? withConditions(t, c) : t;
}
