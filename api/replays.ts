/**
 * POST /api/replays            upload one .faereplay (binary, ≤ 4 MB), stored privately in Vercel Blob
 * GET  /api/replays?since=ISO   (admin) list uploads newer than `since`
 * GET  /api/replays?path=...    (admin) download one
 * POST /api/replays?action=prune (admin) delete oldest blobs beyond the storage cap
 * Admin = `Authorization: Bearer $REPLAY_ADMIN_KEY`.
 */
import { handleReplays, TokenBucket } from './_lib/ingest.js';
import { validateReplay } from './_lib/replayFormat.js';
import { VercelBlobStore } from './_lib/vercelStore.js';

const store = new VercelBlobStore();
// 12 uploads burst, then one every 2 minutes per IP.
const limiter = new TokenBucket(12, 1 / 120);

async function handle(req: Request): Promise<Response> {
  try {
    return await handleReplays(req, { store, limiter, adminKey: process.env.REPLAY_ADMIN_KEY, pruneEvery: 200 }, validateReplay);
  } catch (e) {
    console.error('[api/replays] failed', e);
    return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}

export const GET = handle;
export const POST = handle;
