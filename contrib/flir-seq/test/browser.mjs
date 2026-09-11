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
//   FLIR_SEQ_LANG=fi-FI node browser.mjs                  -- run the interaction
//       suite in another language (every language is checked either way)

import {chromium} from 'playwright-core';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {startServer, SAMPLE_GEOMETRY, sampleBytes} from './server.mjs';
import {loadFlirSeq, referenceTemp} from './load.mjs';
import {toArrayBuffer} from './fixture.mjs';

const flir = loadFlirSeq();

// The harness turns ?lang= into <html lang="...">, the way Gitea renders
// ctx.Locale.Lang. The interaction suite runs in English; every shipped
// language is then checked for the strings it actually puts on screen.
const SUITE_LANG = process.env.FLIR_SEQ_LANG || 'en';
const t = flir.makeTranslator(SUITE_LANG);

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
  await page.goto(url + '?lang=' + SUITE_LANG, {waitUntil: 'load'});
  await page.waitForSelector('.flir-seq-canvas', {timeout: 15000});
  check('viewer replaced the raw-file prompt', await page.locator('.file-view-raw-prompt').count() === 0);
  check('status line is quiet', (await page.locator('.flir-seq-status').textContent()).trim() === '');
  check('metadata lists the camera',
    (await page.locator('.flir-seq-meta').textContent()).includes(parsed.frames[0].info.cameraModel),
    parsed.frames[0].info.cameraModel);

  // the viewer opens on the scale the camera recorded, the way Thermal Studio does
  const opening = await page.evaluate(() => {
    const v = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
    return {mode: v.rangeMode, select: v.rangeSelect.value, camera: v.cameraScale(),
      lo: v.rangeLo, hi: v.rangeHi};
  });
  const expectedCamera = flir.cameraScale(parsed.frames[0].info, converter);
  check('it opens on the scale recorded in the file',
    opening.mode === 'camera' && opening.select === 'camera' &&
    Math.abs(opening.lo - expectedCamera.lo) < 1e-9 && Math.abs(opening.hi - expectedCamera.hi) < 1e-9,
    opening.mode + ' ' + opening.lo.toFixed(2) + ' .. ' + opening.hi.toFixed(2));

  // the canvas must actually have colour in it, not stay blank
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('.flir-seq-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
    return seen.size;
  });
  check('image is painted with a gradient', painted > 20, painted + ' distinct colours sampled');

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

  // the measurement panel has to be populated before anything is touched
  await page.locator('details.flir-seq-panel').nth(1).evaluate((d) => (d.open = true));
  const initialFields = await page.locator('.flir-seq-form input').evaluateAll(
    (els) => els.map((e) => e.value));
  const paramCount = await page.evaluate(() =>
    Object.keys(document.querySelector('.flir-seq-mount').giteaFlirSeqViewer.paramInputs).length);
  check('every parameter field is filled on load',
    initialFields.length === paramCount && initialFields.every((v) => v !== ''),
    initialFields.length + ' of ' + paramCount + ': ' + JSON.stringify(initialFields));
  check('the parameter fields hold the camera settings',
    Math.abs(parseFloat(initialFields[0]) - params.emissivity) < 0.005 &&
    Math.abs(parseFloat(initialFields[2]) - params.objectDistance) < 0.005,
    initialFields.slice(0, 3).join(', '));
  check('the Planck constants are shown on load',
    (await page.locator('.flir-seq-planck-note').textContent()).includes(String(params.planckO)),
    await page.locator('.flir-seq-planck-note').textContent());

  // lowering the emissivity must move a reading hotter than ambient upwards
  const before = parseFloat((await page.locator('.flir-seq-temp').first().textContent()));
  const emissivity = page.locator('.flir-seq-form input').first();
  await emissivity.fill('0.5');
  await emissivity.dispatchEvent('change');
  const after = parseFloat((await page.locator('.flir-seq-temp').first().textContent()));
  check('emissivity change re-reads the spot', Number.isFinite(after) && after !== before,
    before.toFixed(1) + ' -> ' + after.toFixed(1));
  await emissivity.fill(String(params.emissivity));
  await emissivity.dispatchEvent('change');

  // the radiometric model is selectable, and the default is the one that
  // reproduces FLIR Thermal Studio
  const modelSelect = page.locator('.flir-seq-form select');
  check('the model picker defaults to FLIR', (await modelSelect.inputValue()) === flir.MODEL_FLIR,
    await modelSelect.inputValue());
  // The two conventions can differ by less than the one decimal the spot table
  // shows, so the reading is taken from the converter the page is actually
  // using rather than from the rounded label.
  const reading = (raw) => page.evaluate((r) => {
    const viewer = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
    return {model: viewer.converter.model, tau: viewer.converter.tau, temp: viewer.converter.toTemp(r)};
  }, raw);
  const asFlir = await reading(probeRaw);
  check('the default is the FLIR convention', asFlir.model === flir.MODEL_FLIR, asFlir.model);
  check('it matches the converter computed here',
    Math.abs(asFlir.temp - converter.toTemp(probeRaw)) < 1e-9);

  await modelSelect.selectOption(flir.MODEL_THERMIMAGE);
  const asThermimage = await reading(probeRaw);
  const expected = flir.makeConverter(params, flir.MODEL_THERMIMAGE);
  check('switching the picker switches the convention', asThermimage.model === flir.MODEL_THERMIMAGE,
    asThermimage.model);
  check('the Thermimage convention is reproduced exactly',
    Math.abs(asThermimage.temp - expected.toTemp(probeRaw)) < 1e-9 &&
    Math.abs(asThermimage.tau - expected.tau) < 1e-12,
    asThermimage.temp.toFixed(4) + ' vs ' + expected.toTemp(probeRaw).toFixed(4));
  check('it reads colder than the FLIR convention', asThermimage.temp < asFlir.temp,
    asThermimage.temp.toFixed(4) + ' < ' + asFlir.temp.toFixed(4));
  check('the spot table follows the model',
    (await page.locator('.flir-seq-temp').first().textContent()).trim() ===
      expected.toTemp(probeRaw).toFixed(1) + ' °C',
    await page.locator('.flir-seq-temp').first().textContent());

  await modelSelect.selectOption(flir.MODEL_FLIR);
  const backToFlir = await reading(probeRaw);
  check('switching back restores the FLIR reading',
    backToFlir.model === flir.MODEL_FLIR && Math.abs(backToFlir.temp - asFlir.temp) < 1e-12);

  // the transmission note must say where the value in use came from, and a
  // hand-entered transmission must actually replace the estimate
  const tauNote = () => page.locator('.flir-seq-tau-note').textContent();
  check('the transmission is reported as estimated',
    (await tauNote()) === t('tauNote', [converter.tau.toFixed(4), t('tauEstimated')]), await tauNote());
  const transmission = page.locator('.flir-seq-form input').nth(4);
  await transmission.fill('0.8');
  await transmission.dispatchEvent('change');
  check('a hand-entered transmission is used and labelled',
    (await tauNote()) === t('tauNote', ['0.8000', t('tauManual')]), await tauNote());
  await transmission.fill('0');
  await transmission.dispatchEvent('change');
  check('clearing it returns to the estimate',
    (await tauNote()) === t('tauNote', [converter.tau.toFixed(4), t('tauEstimated')]), await tauNote());
  check('the scale survives a parameter round trip',
    await page.evaluate((c) => {
      const v = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
      return Math.abs(v.rangeLo - c.lo) < 1e-9 && Math.abs(v.rangeHi - c.hi) < 1e-9;
    }, expectedCamera));

  // frame navigation
  if (geometry.frames > 1) {
    await page.locator('.flir-seq-slider').evaluate((el, n) => {
      el.value = String(n);
      el.dispatchEvent(new Event('input', {bubbles: true}));
    }, geometry.frames - 1);
    const label = await page.locator('.flir-seq-frame-label').textContent();
    check('frame slider moves to the last frame',
      label.includes(t('frameLabel', [geometry.frames, geometry.frames])), label.trim());
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

  // --- the colour bar's limit handles ---------------------------------
  //
  // The contract is exact: a pixel is drawn if and only if its temperature is
  // inside the window, so the test compares the canvas alpha channel against
  // the temperatures rather than eyeballing a pixel count.
  const audit = await page.evaluate(() => {
    const viewer = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
    const canvas = viewer.imgCanvas;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = viewer.pixelCache.pixels;
    const bounds = viewer.filter;
    let opaque = 0, transparent = 0, violations = 0;
    for (let i = 0; i < pixels.length; i++) {
      const drawn = data[i * 4 + 3] > 0;
      const v = viewer.value(pixels[i]);
      const inside = !bounds || (v >= bounds.lo && v <= bounds.hi);
      if (drawn) opaque++; else transparent++;
      if (drawn !== inside) violations++;
    }
    return {opaque, transparent, violations, filter: bounds};
  });
  // --- the left-hand scale bar ------------------------------------------
  //
  // It sets where the palette starts and stops; everything outside is painted
  // with the end colours, which is the contract asserted below.
  check('the scale bar is to the left of the image',
    await page.evaluate(() => {
      const kids = Array.from(document.querySelector('.flir-seq-stage').children);
      return kids.length === 2 &&
        kids.indexOf(document.querySelector('.flir-seq-scalebar')) <
        kids.indexOf(document.querySelector('.flir-seq-canvas-wrap'));
    }));
  // rangeLo/rangeHi are only updated by the repaint, which is coalesced into an
  // animation frame, so state has to be read after one has run
  const nextFrame = () => page.evaluate(() => new Promise(requestAnimationFrame));
  const scaleState = () => page.evaluate(() => {
    const v = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
    return {mode: v.rangeMode, lo: v.rangeLo, hi: v.rangeHi, domain: v.scaleDomain(),
      hiLabel: v.scaleHandleHi.label.textContent, loLabel: v.scaleHandleLo.label.textContent};
  });
  const scaleStart = await scaleState();
  check('its handles are labelled with the scale',
    scaleStart.hiLabel === scaleStart.hi.toFixed(1) + '°C' && scaleStart.loLabel === scaleStart.lo.toFixed(1) + '°C',
    scaleStart.loLabel + ' .. ' + scaleStart.hiLabel);
  check('its domain covers the frame', scaleStart.domain.lo < scaleStart.lo + 1e-9 &&
    scaleStart.domain.hi > scaleStart.hi - 1e-9, JSON.stringify(scaleStart.domain));

  const scaleTrack = await page.locator('.flir-seq-colorbar-track').boundingBox();
  const scaleGrab = await page.locator('.flir-seq-scale-handle-hi').boundingBox();
  await page.mouse.move(scaleGrab.x + scaleGrab.width / 2, scaleGrab.y + scaleGrab.height / 2);
  await page.mouse.down();
  // aim well above the current bottom: the top handle cannot be pushed past it
  const span = scaleStart.domain.hi - scaleStart.domain.lo;
  const expectedTop = scaleStart.lo + 0.6 * (scaleStart.domain.hi - scaleStart.lo);
  const dropAt = (scaleStart.domain.hi - expectedTop) / span;
  await page.mouse.move(scaleTrack.x + scaleTrack.width / 2,
    scaleTrack.y + scaleTrack.height * dropAt, {steps: 6});
  await page.mouse.up();
  await nextFrame();
  const scaleMoved = await scaleState();
  check('dragging the scale switches to manual', scaleMoved.mode === 'manual', scaleMoved.mode);
  check('the scale top lands where the handle was dropped',
    Math.abs(scaleMoved.hi - expectedTop) < 0.02 * span,
    scaleMoved.hi.toFixed(2) + ' vs ' + expectedTop.toFixed(2));
  check('the scale widened', scaleMoved.hi > scaleStart.hi,
    scaleStart.hi.toFixed(2) + ' -> ' + scaleMoved.hi.toFixed(2));
  check('the scale bottom is untouched', Math.abs(scaleMoved.lo - scaleStart.lo) < 1e-9);
  check('the manual inputs follow the handle',
    Math.abs(parseFloat(await page.locator('.flir-seq-manual input').last().inputValue()) - scaleMoved.hi) <= 0.05,
    await page.locator('.flir-seq-manual input').last().inputValue());

  // everything above the new top has to be painted with the topmost colour
  const clamped = await page.evaluate((bounds) => {
    const viewer = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
    const canvas = viewer.imgCanvas;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = viewer.pixelCache.pixels;
    const top = [viewer.palette[765], viewer.palette[766], viewer.palette[767]];
    const bottom = [viewer.palette[0], viewer.palette[1], viewer.palette[2]];
    let above = 0, aboveWrong = 0, below = 0, belowWrong = 0;
    for (let i = 0; i < pixels.length; i++) {
      const v = viewer.value(pixels[i]);
      const rgb = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
      if (v > bounds.hi) {
        above++;
        if (rgb.join() !== top.join()) aboveWrong++;
      } else if (v < bounds.lo) {
        below++;
        if (rgb.join() !== bottom.join()) belowWrong++;
      }
    }
    return {above, aboveWrong, below, belowWrong, top, bottom};
  }, {lo: scaleMoved.lo, hi: scaleMoved.hi});
  check('pixels above the scale exist and are all the top colour',
    clamped.above > 0 && clamped.aboveWrong === 0,
    clamped.above + ' pixels, ' + clamped.aboveWrong + ' wrong, top = ' + clamped.top.join(','));
  check('pixels below the scale are all the bottom colour', clamped.belowWrong === 0,
    clamped.below + ' pixels, ' + clamped.belowWrong + ' wrong');

  // keyboard, and putting the scale back
  await page.locator('.flir-seq-scale-handle-lo').focus();
  await page.keyboard.press('ArrowUp');
  await nextFrame();
  const keyed = await scaleState();
  check('arrow keys move the scale bottom', keyed.lo > scaleMoved.lo,
    scaleMoved.lo.toFixed(2) + ' -> ' + keyed.lo.toFixed(2));
  // the two shortcuts above the bar, which have to be the same size
  const buttons = await page.locator('.flir-seq-scale-buttons .flir-seq-btn').evaluateAll(
    (els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return {w: Math.round(r.width), h: Math.round(r.height), text: e.textContent, title: e.title};
    }));
  check('there are two scale shortcuts, stacked and the same size',
    buttons.length === 2 && buttons[0].w === buttons[1].w && buttons[0].h === buttons[1].h,
    JSON.stringify(buttons));
  check('they sit above the scale',
    await page.evaluate(() => document.querySelector('.flir-seq-scalebar').firstElementChild
      .classList.contains('flir-seq-scale-buttons')));

  await page.locator('.flir-seq-scale-frame').click();
  const full = await scaleState();
  const extremes = await page.evaluate(() => {
    const v = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
    return {lo: v.value(v.pixelCache.stats.min), hi: v.value(v.pixelCache.stats.max)};
  });
  check('the full-range shortcut spans the whole frame',
    full.mode === 'frame' && Math.abs(full.lo - extremes.lo) < 1e-9 &&
    Math.abs(full.hi - extremes.hi) < 1e-9,
    full.lo.toFixed(2) + ' .. ' + full.hi.toFixed(2));
  check('the full-range shortcut disables itself',
    await page.locator('.flir-seq-scale-frame').isDisabled());

  await page.locator('.flir-seq-scale-camera').click();
  const back = await scaleState();
  check('the other shortcut returns to the scale in the file',
    back.mode === 'camera' && Math.abs(back.lo - expectedCamera.lo) < 1e-9 &&
    Math.abs(back.hi - expectedCamera.hi) < 1e-9,
    back.mode + ' ' + back.lo.toFixed(2) + ' .. ' + back.hi.toFixed(2));
  check('it disables itself in turn',
    (await page.locator('.flir-seq-scale-camera').isDisabled()) &&
    !(await page.locator('.flir-seq-scale-frame').isDisabled()));

  // where the hover hint sits is a deliberate choice, so it is asserted rather
  // than left to drift back: it explains the spot meters, not the picture
  check('the hover hint follows the frame controls',
    await page.evaluate(() => {
      const kids = Array.from(document.querySelector('.flir-seq').children);
      return kids.indexOf(document.querySelector('.flir-seq-readout')) >
        kids.indexOf(document.querySelector('.flir-seq-frames')) &&
        kids.indexOf(document.querySelector('.flir-seq-readout')) <
        kids.indexOf(document.querySelector('.flir-seq-panels'));
    }));
  check('there is no second bar to the right of the image',
    (await page.locator('.flir-seq-filterbar').count()) === 0 &&
    (await page.locator('.flir-seq-colorbar').count()) === 1);

  // exports
  for (const [label, selector, suffix] of [['PNG', 'text=' + t('exportPng'), '.png'], ['CSV', 'text=' + t('exportCsv'), '.csv']]) {
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

  // --- every shipped language must reach the screen ----------------------
  for (const lang of Object.keys(flir.LANGUAGES)) {
    const tl = flir.makeTranslator(lang);
    const localised = await browser.newPage({viewport: {width: 1100, height: 900}});
    const localisedErrors = [];
    localised.on('pageerror', (e) => localisedErrors.push(String(e)));
    try {
      await localised.goto(url + '?lang=' + lang, {waitUntil: 'load'});
      await localised.waitForSelector('.flir-seq-canvas', {timeout: 15000});
      // innerText skips collapsed <details>, and two panels start closed
      await localised.locator('details.flir-seq-panel').evaluateAll((ds) => ds.forEach((d) => (d.open = true)));
      const text = await localised.locator('.flir-seq').innerText();
      // one string from each area of the UI, so a key missed in one panel shows
      const expected = ['palette', 'scale', 'extremes', 'spots', 'spotsHint', 'noSpots',
        'colRaw', 'colTemp', 'clearAll', 'params', 'atmTransmission', 'fileInfo',
        'exportPng', 'exportCsv', 'readoutHint', 'play',
        'model', 'modelFlir', 'modelNote'];
      const missing = expected.filter((key) => !text.includes(tl(key)));
      check(lang + ': every panel is translated', missing.length === 0,
        missing.map((key) => key + '=' + tl(key)).join(' | '));
      // the scale shortcuts are glyphs, so their words live on the tooltip and
      // the accessible name; both still have to be in the right language
      const shortcuts = await localised.evaluate(() => Array.from(
        document.querySelectorAll('.flir-seq-scale-buttons .flir-seq-btn')).map((b) => ({
        title: b.title, label: b.getAttribute('aria-label'),
        width: Math.round(b.getBoundingClientRect().width),
      })));
      check(lang + ': the scale shortcuts are named in this language',
        shortcuts.length === 2 &&
        shortcuts[0].title === tl('scaleFrame') && shortcuts[0].label === tl('scaleFrame') &&
        shortcuts[1].title === tl('scaleCamera') && shortcuts[1].label === tl('scaleCamera'),
        shortcuts.map((b) => b.title).join(' / '));
      check(lang + ': they stay narrow', shortcuts.every((b) => b.width <= 32),
        shortcuts.map((b) => b.width + 'px').join(' '));
      const frameLabel = (await localised.locator('.flir-seq-frame-label').textContent()).trim();
      check(lang + ': the frame label is formatted',
        frameLabel.startsWith(tl('frameLabel', [1, geometry.frames])), frameLabel);
      // the readout is assembled from three separate keys, so check it live
      const point = await localised.evaluate((p) => {
        const viewer = document.querySelector('.flir-seq-mount').giteaFlirSeqViewer;
        const v = viewer.toView(p.x + 0.5, p.y + 0.5);
        const rect = document.querySelector('.flir-seq-canvas').getBoundingClientRect();
        return {x: rect.left + v.x, y: rect.top + v.y};
      }, probe);
      await localised.mouse.move(point.x, point.y);
      const readout = (await localised.locator('.flir-seq-readout').textContent()).trim();
      check(lang + ': the readout is translated',
        readout === tl('readout', [probe.x, probe.y, probeTemp + ' °C', tl('readoutRaw', [probeRaw])]),
        readout);
      check(lang + ': no page errors', localisedErrors.length === 0, localisedErrors.join(' | '));
    } finally {
      await localised.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
