// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Shared helpers for the markdown-draw browser suites.

import {chromium} from 'playwright-core';
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

export const BASE = process.env.MARKDOWN_DRAW_BASE ?? 'http://127.0.0.1:8765';

// Locate a browser without assuming how it got onto this machine.
export function findChromium() {
  if (process.env.CHROMIUM && existsSync(process.env.CHROMIUM)) return process.env.CHROMIUM;
  try {
    const path = chromium.executablePath();
    if (path && existsSync(path)) return path;
  } catch {
    // playwright-core has no downloaded browsers, keep looking
  }
  // preinstalled browser pools, e.g. PLAYWRIGHT_BROWSERS_PATH images
  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(pool)) {
    for (const entry of readdirSync(pool).sort().reverse()) {
      if (!entry.startsWith('chromium-')) continue;
      const candidate = join(pool, entry, 'chrome-linux', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function launchBrowser() {
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      'no Chromium found. Run "npx playwright install chromium" or set CHROMIUM to a browser binary.',
    );
  }
  return chromium.launch({executablePath});
}

// Page-level failures collected by watchPage, so that finish() can fail on them.
const pageErrors = [];

// A suite is a list of named boolean checks; the runner only needs the tally.
export function createChecks(suiteName) {
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({name, ok});
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`);
  };
  const finish = () => {
    // An uncaught error in the page is a failure even when every check passed:
    // it means something threw where nothing was looking.
    if (pageErrors.length) {
      check(`no uncaught errors in the page (${pageErrors.length})`, false, pageErrors[0]);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`  ${results.length - failed.length}/${results.length} checks passed  (${suiteName})`);
    process.exit(failed.length ? 1 : 0);
  };
  return {check, finish};
}

// Record page-level failures and fail the suite on them at the end; one that
// only printed them let a real bug through with every check passing.
export function watchPage(page) {
  page.on('pageerror', (err) => {
    console.log('  [pageerror]', err.message);
    pageErrors.push(err.message);
  });
  return page;
}

export const SCREENSHOT_DIR = new URL('./screenshots/', import.meta.url).pathname;

export async function screenshot(page, name, options = {}) {
  const {mkdirSync} = await import('node:fs');
  mkdirSync(SCREENSHOT_DIR, {recursive: true});
  await page.screenshot({path: join(SCREENSHOT_DIR, `${name}.png`), ...options});
}

// --- shared page interactions

export async function openBoard(page, {tap = false} = {}) {
  const button = page.locator('.markup-draw-button');
  await (tap ? button.tap() : button.click());
  await page.locator('.markup-draw-overlay .imageEditorContainer').waitFor({timeout: 30000});
  await page.waitForTimeout(600);
}

export async function drawStroke(page, points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

export async function scribbleOnCanvas(page) {
  const box = await page.locator('.markup-draw-overlay canvas').first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const points = [[cx - 120, cy - 60]];
  for (let i = 1; i <= 12; i++) points.push([cx - 120 + i * 20, cy - 60 + Math.sin(i / 2) * 40]);
  await drawStroke(page, points);
  return box;
}

export async function saveBoard(page) {
  await page.locator('.markup-draw-overlay .toolwidget-tag--save .toolbar-button').first().click();
  await page.locator('.markup-draw-overlay').waitFor({state: 'detached', timeout: 15000});
}

export const stripFence = (text) =>
  text.replace(/^[\s\S]*?```js-draw\r?\n/, '').replace(/\r?\n```[\s\S]*$/, '');

// `node lib.mjs --print-chromium` -- used by setup.sh to report what it found
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === '--print-chromium') {
  const path = findChromium();
  if (!path) process.exit(1);
  console.log(path);
}
