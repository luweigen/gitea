// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Drives the viewer in a real browser against the harness page, so that the
// canvas, the hover/click readouts and the exports are exercised the way a
// user meets them. Run ./setup.sh once, then ./run.sh.
//
//   FLIR_SEQ_SAMPLE=/path/to/real.seq node browser.mjs   -- use a real file
//   FLIR_SEQ_SCREENSHOT=/tmp/shot.png node browser.mjs   -- keep a screenshot
//   CHROMIUM=/path/to/chrome node browser.mjs             -- use a browser that
//       playwright-core did not download itself

import {chromium} from 'playwright-core';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {startServer, SAMPLE_GEOMETRY, sampleBytes} from './server.mjs';
import {loadFlirSeq, referenceTemp} from './load.mjs';
import {toArrayBuffer} from './fixture.mjs';

const flir = loadFlirSeq();

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail));
  if (!ok) failures++;
}

// what the temperatures should be, computed outside the browser
const sample = toArrayBuffer(await sampleBytes());
const parsed = flir.parseSeq(sample);
const params = flir.paramsFromInfo(parsed.frames[0].info);
const converter = flir.makeConverter(params);
const geometry = process.env.FLIR_SEQ_SAMPLE
  ? {width: parsed.frames[0].raw.width, height: parsed.frames[0].raw.height, frames: parsed.frames.length}
  : SAMPLE_GEOMETRY;
const probe = {x: Math.round(geometry.width * 0.7), y: Math.round(geometry.height * 0.35)};
const probeRaw = flir.readFramePixels(sample, parsed.frames[0])[probe.y * geometry.width + probe.x];
const probeTemp = referenceTemp(probeRaw, params).toFixed(1);

const {server, url} = await startServer();
/** playwright-core ships no browser, so find one it or the host already has. */
function resolveChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch {
    // playwright-core has no download of its own, fall through to the scan
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright')];
  const leaves = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux', 'headless_shell'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win', 'chrome.exe'],
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse()) {
      for (const leaf of leaves) {
        const path = join(root, dir, ...leaf);
        if (existsSync(path)) return path;
      }
    }
  }
  return null; // let playwright report what it is missing
}

const executablePath = resolveChromium();
const browser = await chromium.launch(executablePath ? {executablePath} : {});
const page = await browser.newPage({viewport: {width: 1100, height: 900}});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  await page.goto(url, {waitUntil: 'load'});
  await page.waitForSelector('.flir-seq-canvas', {timeout: 15000});
  check('viewer replaced the raw-file prompt', await page.locator('.file-view-raw-prompt').count() === 0);
  check('status line is quiet', (await page.locator('.flir-seq-status').textContent()).trim() === '');
  check('metadata lists the camera',
    (await page.locator('.flir-seq-meta').textContent()).includes(parsed.frames[0].info.cameraModel),
    parsed.frames[0].info.cameraModel);

  // the canvas must actually have colour in it, not stay blank
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('.flir-seq-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
    return seen.size;
  });
  check('image is painted with a gradient', painted > 20, painted + ' distinct colours sampled');

  // the colour bar must span the frame's own extremes in "per frame" mode
  const frameTemps = (() => {
    const px = flir.readFramePixels(sample, parsed.frames[0]);
    let min = 0xffff, max = 0;
    for (let i = 0; i < px.length; i++) {
      if (px[i] < min) min = px[i];
      if (px[i] > max) max = px[i];
    }
    return {lo: converter.toTemp(min).toFixed(1), hi: converter.toTemp(max).toFixed(1)};
  })();
  const colorbarLabels = async () => (await page.locator('.flir-seq-colorbar-label').allTextContents()).join(' / ');
  check('colour bar spans the frame extremes',
    (await colorbarLabels()) === frameTemps.hi + '°C / ' + frameTemps.lo + '°C',
    await colorbarLabels());

  // hover the hot spot: the readout must name the pixel and its temperature
  const point = await page.evaluate((p) => {
    const mount = document.querySelector('.flir-seq-mount');
    const viewer = mount.giteaFlirSeqViewer;
    const v = viewer.toView(p.x + 0.5, p.y + 0.5);
    const rect = document.querySelector('.flir-seq-canvas').getBoundingClientRect();
    return {x: rect.left + v.x, y: rect.top + v.y};
  }, probe);
  await page.mouse.move(point.x, point.y);
  const readout = (await page.locator('.flir-seq-readout').textContent()).trim();
  check('hover reports the picked pixel', readout.includes('(' + probe.x + ', ' + probe.y + ')'), readout);
  check('hover reports the expected temperature', readout.includes(probeTemp + ' °C'),
    readout + ' (expected ' + probeTemp + ' °C)');
  check('hover reports the raw count', readout.includes(String(probeRaw)));

  // clicking the same place must record a spot with the same temperature
  await page.mouse.click(point.x, point.y);
  const row = (await page.locator('.flir-seq-table tbody tr').first().textContent()).replace(/\s+/g, ' ');
  check('click adds a spot', (await page.locator('.flir-seq-table tbody tr').count()) === 1, row);
  check('spot shows the same temperature', row.includes(probeTemp + ' °C'), row);
  check('spot shows its coordinates', row.includes(String(probe.x)) && row.includes(String(probe.y)), row);

  // lowering the emissivity must move a reading hotter than ambient upwards
  const before = parseFloat((await page.locator('.flir-seq-temp').first().textContent()));
  await page.locator('details.flir-seq-panel').nth(1).evaluate((d) => (d.open = true));
  const emissivity = page.locator('.flir-seq-form input').first();
  await emissivity.fill('0.5');
  await emissivity.dispatchEvent('change');
  const after = parseFloat((await page.locator('.flir-seq-temp').first().textContent()));
  check('emissivity change re-reads the spot', Number.isFinite(after) && after !== before,
    before.toFixed(1) + ' -> ' + after.toFixed(1));
  await emissivity.fill(String(params.emissivity));
  await emissivity.dispatchEvent('change');
  check('colour bar survives a parameter round trip',
    (await colorbarLabels()) === frameTemps.hi + '°C / ' + frameTemps.lo + '°C',
    await colorbarLabels());

  // frame navigation
  if (geometry.frames > 1) {
    await page.locator('.flir-seq-slider').evaluate((el, n) => {
      el.value = String(n);
      el.dispatchEvent(new Event('input', {bubbles: true}));
    }, geometry.frames - 1);
    const label = await page.locator('.flir-seq-frame-label').textContent();
    check('frame slider moves to the last frame', label.includes(String(geometry.frames) + ' 帧'), label.trim());
    await page.locator('.flir-seq-slider').evaluate((el) => {
      el.value = '0';
      el.dispatchEvent(new Event('input', {bubbles: true}));
    });
  }

  // palette switch must change the painted colours
  const ironPixel = await page.evaluate(() => Array.from(
    document.querySelector('.flir-seq-canvas').getContext('2d').getImageData(200, 100, 1, 1).data));
  await page.locator('.flir-seq-toolbar select').first().selectOption('rainbow');
  const rainbowPixel = await page.evaluate(() => Array.from(
    document.querySelector('.flir-seq-canvas').getContext('2d').getImageData(200, 100, 1, 1).data));
  check('palette switch repaints', ironPixel.join() !== rainbowPixel.join(),
    ironPixel.join() + ' -> ' + rainbowPixel.join());
  await page.locator('.flir-seq-toolbar select').first().selectOption('iron');

  // zoom must change the mapping from screen to image coordinates
  const scaleBefore = await page.evaluate(() => document.querySelector('.flir-seq-mount').giteaFlirSeqViewer.view.scale);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -240);
  const scaleAfter = await page.evaluate(() => document.querySelector('.flir-seq-mount').giteaFlirSeqViewer.view.scale);
  check('wheel zooms in', scaleAfter > scaleBefore, scaleBefore.toFixed(3) + ' -> ' + scaleAfter.toFixed(3));
  await page.locator('.flir-seq-zoom button').nth(2).click();
  const scaleReset = await page.evaluate(() => document.querySelector('.flir-seq-mount').giteaFlirSeqViewer.view.scale);
  check('fit button restores the fit scale', Math.abs(scaleReset - scaleBefore) < 1e-6);

  // exports
  for (const [label, selector, suffix] of [['PNG', 'text=导出 PNG', '.png'], ['CSV', 'text=导出温度 CSV', '.csv']]) {
    const [download] = await Promise.all([
      page.waitForEvent('download', {timeout: 15000}),
      page.locator(selector).click(),
    ]);
    check(label + ' export downloads a file', download.suggestedFilename().endsWith(suffix),
      download.suggestedFilename());
  }

  if (process.env.FLIR_SEQ_SCREENSHOT) {
    await page.locator('.flir-seq').screenshot({path: process.env.FLIR_SEQ_SCREENSHOT});
    console.log('  screenshot: ' + process.env.FLIR_SEQ_SCREENSHOT);
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
