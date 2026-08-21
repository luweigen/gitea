// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// The six UML relationship pens: that they are offered, that each one draws
// the notation it claims to, and above all that an arrow is a single element.
//
// Checks go through the saved SVG rather than through the editor's internals,
// so what is asserted is what ends up in the markdown -- and, because the
// markdown is the only place a drawing lives, what the board has to be able to
// read back.

import {BASE, createChecks, drawStroke, launchBrowser, openBoard, saveBoard, screenshot, stripFence, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('uml-pens');

const PENS = [
  {id: 'uml-generalization', label: 'Generalization', hollow: true, dashed: false},
  {id: 'uml-realization', label: 'Realization', hollow: true, dashed: true},
  {id: 'uml-composition', label: 'Composition', hollow: false, dashed: false},
  {id: 'uml-aggregation', label: 'Aggregation', hollow: true, dashed: false},
  {id: 'uml-association', label: 'Association', hollow: false, dashed: false},
  {id: 'uml-dependency', label: 'Dependency', hollow: false, dashed: true},
];

// js-draw names a pen type on the <label> of its radio button, which is also
// what a screen reader reads out.
const penOption = (page, label) =>
  page.locator(`.markup-draw-overlay .toolbar-dropdown label[title="${label}"]`).first();

// The pen tool's button toggles its dropdown, and whether it starts open
// depends on what the previous interaction left behind -- click until it is.
async function openPenDropdown(page) {
  const button = page.locator('.markup-draw-overlay .toolbar-internalWidgetId--pen .toolbar-button')
    .first();
  for (let i = 0; i < 3; i++) {
    if (await penOption(page, 'Arrow').isVisible().catch(() => false)) return;
    await button.click();
    await page.waitForTimeout(400);
  }
}

async function choosePen(page, label) {
  await openPenDropdown(page);
  await penOption(page, label).click();
  await page.waitForTimeout(200);
  // the dropdown covers the middle of the canvas; put it away before drawing
  await page.locator('.markup-draw-overlay .toolbar-internalWidgetId--pen .toolbar-button')
    .first().click();
  await page.waitForTimeout(300);
}

// Every path in the saved drawing except js-draw's background.
const drawnPaths = (svg) => [...svg.matchAll(/<path[^>]*\sd="([^"]*)"[^>]*>/g)]
  .filter((match) => !match[0].includes('js-draw-image-background'))
  .map((match) => match[1]);

async function savedPaths(page) {
  const svg = stripFence(await page.locator('textarea.markdown-text-editor').inputValue());
  return {svg, paths: drawnPaths(svg)};
}

// A subpath is one moveTo; js-draw writes the first as `M` and the rest as `m`.
const subpathCount = (d) => (d.match(/[Mm]/g) ?? []).length;

const browser = await launchBrowser();

// --- all six are offered, and each draws exactly one element

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);

  const debug = await page.evaluate(() => window.giteaDrawDebug());
  check('the pens are configured on', debug.umlPens.length === 6, debug.umlPens.join(', '));

  await openBoard(page);

  await openPenDropdown(page);
  const labels = await page.locator('.markup-draw-overlay .toolbar-dropdown label[title]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('title')));
  for (const pen of PENS) {
    check(`[${pen.id}] is offered in the pen dropdown`, labels.includes(pen.label));
  }

  // Draw all six, well apart, so one save carries the lot.  Each is a straight
  // drag: these are shape pens, so only the two endpoints matter.
  const shapes = [];
  for (const [index, pen] of PENS.entries()) {
    await choosePen(page, pen.label);
    const y = 220 + index * 90;
    await drawStroke(page, [[260, y], [760, y]]);
    shapes.push(pen);
  }
  await screenshot(page, 'uml-pens');
  await saveBoard(page);

  const {paths} = await savedPaths(page);
  check('six arrows are six elements', paths.length === 6, `got ${paths.length}`);
  check('no arrow has a broken coordinate', !paths.some((d) => d.includes('NaN')));

  for (const [index, pen] of shapes.entries()) {
    const d = paths[index];
    if (!d) continue;
    // a hollow head is a band: the outline, then the same outline inset and
    // wound backwards, so it is one subpath more than the filled version
    const subpaths = subpathCount(d);
    if (pen.hollow) {
      check(`[${pen.id}] the head is hollow`, subpaths >= 3, `${subpaths} subpaths`);
    }
    if (pen.dashed) {
      // a dash is its own quad, and the shaft is much longer than one dash
      check(`[${pen.id}] the line is dashed`, subpaths >= 6, `${subpaths} subpaths`);
    } else {
      check(`[${pen.id}] the line is solid`, subpaths <= 3, `${subpaths} subpaths`);
    }
  }

  await page.close();
}

// --- the round trip: an arrow has to come back as the single element it was
//
// This is the property the whole design rests on.  The SVG renderer starts a
// new <path> wherever the style changes and the loader makes one component per
// <path>, so an arrow built out of two styles would look right here and split
// in two the next time someone opened the drawing.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await choosePen(page, 'Composition');
  await drawStroke(page, [[300, 300], [800, 300]]);
  await saveBoard(page);

  const before = await savedPaths(page);
  check('one arrow saves as one path', before.paths.length === 1, `got ${before.paths.length}`);

  // reopen the drawing and save it again, unchanged
  await openBoard(page);
  await saveBoard(page);

  const after = await savedPaths(page);
  check('it is still one path after a reload', after.paths.length === 1, `got ${after.paths.length}`);
  check('and its geometry is unchanged', after.paths[0] === before.paths[0]);

  await page.close();
}

// --- an arrow shorter than its own head
//
// The head is scaled down to fit rather than eating the whole shaft; without
// that the shaft is zero-length and normalizing it writes NaN into the path.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await choosePen(page, 'Generalization');
  await drawStroke(page, [[400, 300], [406, 300]]);
  await saveBoard(page);

  const {paths} = await savedPaths(page);
  check('a very short arrow still saves', paths.length === 1, `got ${paths.length}`);
  check('a very short arrow has no broken coordinate',
    !paths.some((d) => d.includes('NaN')), paths[0] ?? '');

  await page.close();
}

// --- recorded and replayed like anything else
//
// The recorder stores what a command serializes to, not the pen that produced
// it, so a UML arrow is a Stroke like any other and should need nothing of its
// own. That is worth asserting rather than assuming: a pen that built its shape
// out of something js-draw cannot serialize would break the log for the whole
// drawing, not just for itself.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await choosePen(page, 'Aggregation');
  await drawStroke(page, [[300, 300], [800, 300]]);

  const history = await page.waitForFunction(() => {
    const report = window.giteaDrawDebug();
    return report.history && typeof report.history === 'object' ? report.history : null;
  }, null, {timeout: 20000}).then((handle) => handle.jsonValue());
  check('drawing an arrow is recorded', history.problem === null && history.rejected === null,
    history.problem ?? '');
  // the starting canvas is the log's first command, the arrow the second
  check('the arrow is one recorded command', history.commands === 2,
    `${history.commands} commands`);

  await saveBoard(page);
  const source = await page.locator('textarea.markdown-text-editor').inputValue();
  check('the arrow reaches the markdown with a history', source.includes('gitea-draw-history'));

  // reopening replays the log; if the arrow could not be replayed the recorder
  // would refuse the stored log rather than come up clean
  await openBoard(page);
  const replayed = await page.waitForFunction(() => {
    const report = window.giteaDrawDebug();
    return report.history && typeof report.history === 'object' ? report.history : null;
  }, null, {timeout: 20000}).then((handle) => handle.jsonValue());
  check('the log survives being replayed', replayed.rejected === null, replayed.rejected ?? '');
  await saveBoard(page);

  const {paths} = await savedPaths(page);
  check('and the arrow is still one path afterwards', paths.length === 1, `got ${paths.length}`);

  await page.close();
}

await browser.close();
finish();
