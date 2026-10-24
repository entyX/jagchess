/* Loads every lichess module in a real browser and exercises the pure bits.
   Needs no Firebase emulator and no lichess account: the checks are all
   functions of their arguments. Run with: node tests/lichess.browser.test.mjs */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(`http://127.0.0.1:${port}/tests/lichess-load.html`);
await page.waitForFunction(() => window.__done === true, null, { timeout: 30000 });

const out = await page.textContent('#out');
console.log(out);

await browser.close();
server.close();

const failed = out.split('\n').filter((l) => l.startsWith('FAIL'));
/* Firebase's own network chatter shows up as console errors when there is no
   signed-in user, and one board check deliberately asks lichess for a game
   that does not exist. Neither is a failure; only our own are. */
const real = errors.filter((e) =>
  !/firestore|firebase|net::ERR|Failed to load resource|permission/i.test(e) &&
  !/zzzzzzzz/.test(e));

if (failed.length || real.length) {
  console.error('\n' + [...failed, ...real].join('\n'));
  process.exit(1);
}
console.log('\nAll checks passed.');
