/// <reference types="node" />
/** Worker thread: runs one headless match per message. */
import { parentPort } from 'node:worker_threads';
import { runMatch, type MatchSpec } from './runMatch';

if (!parentPort) throw new Error('train worker: must run as a worker thread');
const port = parentPort;
port.on('message', async (msg: { id: number; spec: MatchSpec }) => {
  try {
    port.postMessage({ id: msg.id, result: await runMatch(msg.spec) });
  } catch (e) {
    port.postMessage({ id: msg.id, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
});
