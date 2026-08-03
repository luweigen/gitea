// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Static server for the test harness.
//
// /js/ and /css/ are served straight out of the customization, NOT from a copy,
// so the suites always exercise the files that actually ship.

import {createServer} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';

const here = new URL('.', import.meta.url).pathname;

const MOUNTS = [
  ['/js/', join(here, '../custom/public/assets/js')],
  ['/css/', join(here, '../custom/public/assets/css')],
  ['/js-draw/', join(here, 'vendor/custom/public/assets/js-draw')],
  ['/monaco/', join(here, 'vendor/monaco')],
  ['/', join(here, 'harness')],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function resolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0]));
  if (clean.includes('..')) return null;
  for (const [prefix, dir] of MOUNTS) {
    if (!clean.startsWith(prefix)) continue;
    const rest = clean.slice(prefix.length) || 'index.html';
    const file = join(dir, rest);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

export function startServer(port = Number(process.env.MARKDOWN_DRAW_PORT ?? 8765)) {
  const server = createServer((req, res) => {
    const file = resolve(req.url);
    if (!file) {
      res.writeHead(404, {'content-type': 'text/plain'});
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store', // a cached harness would hide the very bugs we look for
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve_({server, port}));
  });
}

// `node server.mjs` -- serve until interrupted, handy for poking at the harness
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const {port} = await startServer();
  console.log(`harness on http://127.0.0.1:${port}/ (Ctrl+C to stop)`);
}
