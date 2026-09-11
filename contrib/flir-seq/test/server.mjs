// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Static server for the browser harness. It serves the customization's assets
// unchanged, the harness page, and a synthetic .seq at /raw/sample.seq (or the
// real file named by FLIR_SEQ_SAMPLE).

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join, normalize} from 'node:path';
import {assetDir} from './load.mjs';
import {buildFixture} from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export const SAMPLE_GEOMETRY = {width: 320, height: 240, frames: 3};

export async function sampleBytes() {
  const real = process.env.FLIR_SEQ_SAMPLE;
  return real ? await readFile(real) : buildFixture(SAMPLE_GEOMETRY);
}

export async function startServer(port = 0) {
  const sample = await sampleBytes();
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    try {
      if (path === '/favicon.ico') {
        res.writeHead(204).end(); // keeps the browser test's error log clean
        return;
      }
      if (path === '/raw/sample.seq') {
        res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': sample.length});
        res.end(req.method === 'HEAD' ? undefined : sample);
        return;
      }
      const file = path.startsWith('/assets/')
        ? join(assetDir, path.slice('/assets/'.length))
        : join(here, 'harness', path === '/' ? 'index.html' : path);
      if (!file.startsWith(assetDir) && !file.startsWith(join(here, 'harness'))) throw new Error('forbidden');
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, {'content-type': TYPES[ext] || 'application/octet-stream'});
      res.end(body);
    } catch (e) {
      res.writeHead(404, {'content-type': 'text/plain'});
      res.end(String(e.message));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {server, url: 'http://127.0.0.1:' + server.address().port + '/'};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {url} = await startServer(Number(process.env.PORT) || 8123);
  console.log('harness on ' + url);
}
