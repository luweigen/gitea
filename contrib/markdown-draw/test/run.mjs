// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Runs the markdown-draw browser suites.
//
//   node run.mjs                 all suites
//   node run.mjs colour-picker   one suite (name without the .mjs)

import {spawn} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {startServer} from './server.mjs';
import {findChromium} from './lib.mjs';

const here = new URL('.', import.meta.url).pathname;
const suitesDir = join(here, 'suites');

// declared rather than globbed: the order is meaningful when reading the output
const ALL_SUITES = [
  'combo-editor',
  'alignment',
  'uml-pens',
  'mobile',
  'file-editor',
  'file-editor-layouts',
  'colour-picker',
];

function preflight() {
  const problems = [];
  if (!existsSync(join(here, 'node_modules', 'playwright-core'))) {
    problems.push('playwright-core is missing');
  }
  if (!existsSync(join(here, 'vendor/custom/public/assets/js-draw/bundle.js'))) {
    problems.push('js-draw is missing');
  }
  if (!existsSync(join(here, 'vendor/monaco/min/vs/loader.js'))) {
    problems.push('monaco-editor is missing');
  }
  if (problems.length) {
    console.error(`error: ${problems.join(', ')}. Run ./setup.sh first.`);
    process.exit(2);
  }
  if (!findChromium()) {
    console.error('error: no Chromium found. Run "npx playwright install chromium" or set CHROMIUM.');
    process.exit(2);
  }
}

function runSuite(name, port) {
  return new Promise((resolve) => {
    const file = join(suitesDir, `${name}.mjs`);
    const child = spawn(process.execPath, [file], {
      stdio: 'inherit',
      env: {...process.env, MARKDOWN_DRAW_BASE: `http://127.0.0.1:${port}`},
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

const requested = process.argv.slice(2);
const unknown = requested.filter((n) => !ALL_SUITES.includes(n));
if (unknown.length) {
  const available = readdirSync(suitesDir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4));
  console.error(`error: unknown suite(s): ${unknown.join(', ')}\navailable: ${available.join(', ')}`);
  process.exit(2);
}
const suites = requested.length ? requested : ALL_SUITES;

preflight();
const {server, port} = await startServer();

const failures = [];
for (const name of suites) {
  console.log(`\n=== ${name}`);
  if (!await runSuite(name, port)) failures.push(name);
}

server.close();

console.log(`\n${suites.length - failures.length}/${suites.length} suites passed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
