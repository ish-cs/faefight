/**
 * Minimal reliable, ordered message pipe between two browsers. Implementations:
 * PeerJS (real internet play), BroadcastChannel (same-browser tabs, for dev/e2e), loopback (unit tests).
 */
export interface Link {
  readonly peerId: string;
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface HostRoom {
  /** Short invite code friends type in, e.g. "K7Q2MX". */
  readonly code: string;
  onJoin(cb: (link: Link) => void): void;
  close(): void;
}

export interface Transport {
  host(): Promise<HostRoom>;
  join(code: string): Promise<Link>;
}
