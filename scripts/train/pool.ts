/// <reference types="node" />
import { Worker } from 'node:worker_threads';
import type { MatchResult, MatchSpec } from './runMatch';

/** A fixed pool of worker threads, one headless sim each; results come back in spec order. */
export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { id: number; spec: MatchSpec }[] = [];
  private pending = new Map<number, { resolve: (r: MatchResult) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  constructor(size: number) {
    if (size < 1) throw new Error(`Pool: need at least one worker, got ${size}`);
    const url = new URL('./worker.ts', import.meta.url);
    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.on('message', (msg: { id: number; result?: MatchResult; error?: string }) => {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) throw new Error(`Pool: result for unknown job ${msg.id}`);
        if (msg.error) p.reject(new Error(`match job ${msg.id} failed: ${msg.error}`));
        else p.resolve(msg.result!);
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e) => { throw new Error(`Pool: worker crashed: ${e.message}`); });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run = (specs: MatchSpec[]): Promise<MatchResult[]> =>
    Promise.all(specs.map((spec) => new Promise<MatchResult>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, spec });
      this.pump();
    })));

  private pump() {
    while (this.idle.length && this.queue.length) this.idle.pop()!.postMessage(this.queue.shift()!);
  }

  async close() { await Promise.all(this.workers.map((w) => w.terminate())); }
}
