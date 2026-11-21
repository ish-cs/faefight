/**
 * POST /api/errors           a batch of client error reports ({"reports":[...]}, ≤ 64 KB) → Vercel Blob
 * GET  /api/errors?since=ISO  (admin) list · GET /api/errors?path=... (admin) download
 */
import { handleErrors, TokenBucket } from './_lib/ingest.js';
import { VercelBlobStore } from './_lib/vercelStore.js';

const store = new VercelBlobStore();
// Clients batch their errors (one post per page session, usually); 6 burst, one per 5 minutes after.
const limiter = new TokenBucket(6, 1 / 300);

async function handle(req: Request): Promise<Response> {
  try {
    return await handleErrors(req, { store, limiter, adminKey: process.env.REPLAY_ADMIN_KEY, pruneEvery: 200 });
  } catch (e) {
    console.error('[api/errors] failed', e);
    return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}

export const GET = handle;
export const POST = handle;
