// Serves the project root statically, renders concept/index.html in headless Chromium,
// screenshots it to docs/screens/concept-v1.png. Server lives only for this process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.OUT || path.join(root, 'docs/screens/concept-v1.png');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(5288, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: process.env.CHROME || (process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:5288/concept/index.html' + (process.env.Q || ''));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.screenshot({ path: out });
  console.log('saved', out, await page.evaluate(() => window.__gl));
} finally {
  await browser.close();
  server.close();
}
