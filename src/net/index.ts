import { BroadcastTransport } from './broadcast';
import { PeerTransport } from './peer';
import type { Transport } from './transport';

/** `?net=local` → same-browser BroadcastChannel (dev/e2e); otherwise PeerJS over the internet. */
export function pickTransport(search: string): Transport {
  return new URLSearchParams(search).get('net') === 'local' ? new BroadcastTransport() : new PeerTransport();
}
