// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// The edit history: recording what Ctrl+Z can take back, carrying it in the
// fence, and replaying it into a later board so the undo stack outlives the tab.

import {deflateRawSync, inflateRawSync} from 'node:zlib';
import {
  BASE, createChecks, drawStroke, launchBrowser, openBoard, saveBoard, scribbleOnCanvas,
  screenshot, stripFence, watchPage,
} from '../lib.mjs';

const {check, finish} = createChecks('history');

const HISTORY_RE = /<!--gitea-draw-history:(\d+):([a-z]):([A-Za-z0-9+/=]*)-->/;
const OP_SESSION = 0, OP_DO = 1, OP_UNDO = 2;

const readJournal = (fence) => {
  const match = HISTORY_RE.exec(fence);
  if (!match) return null;
  const bytes = Buffer.from(match[3], 'base64');
  return JSON.parse((match[2] === 'z' ? inflateRawSync(bytes) : bytes).toString('utf8'));
};

const makeFence = (svg, journal) => {
  const packed = deflateRawSync(Buffer.from(JSON.stringify(journal), 'utf8')).toString('base64');
  const comment = `<!--gitea-draw-history:1:z:${packed}-->`;
  const close = svg.lastIndexOf('</svg>');
  return `\`\`\`js-draw\n${svg.slice(0, close)}${comment}${svg.slice(close)}\n\`\`\`\n`;
};

const countPaths = (fence) => (fence.match(/<path/g) ?? []).length;

// The canvas frame: where the drawing sits and whether it grows with its
// content. loadFromSVG takes both from the SVG -- the viewBox and a class on the
// root -- so a replay that only reinstates components has to put them back too.
const frameOf = (fence) => {
  const svg = stripFence(fence).replace(HISTORY_RE, '');
  return {
    viewBox: /viewBox="([^"]*)"/.exec(svg)?.[1] ?? null,
    autoresize: svg.includes('js-draw--autoresize'),
  };
};

const source = (page) => page.locator('textarea.markdown-text-editor').inputValue();

const setSource = (page, text, caret = 20) =>
  page.locator('textarea.markdown-text-editor').evaluate((el, [value, pos]) => {
    el.value = value;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [text, caret]);

// giteaDrawDebug().history is a string until the recorder is up; the board is
// open before that happens, so every read has to wait for the object.
const historyOf = (page, field = 'history') => page.waitForFunction((key) => {
  const report = window.giteaDrawDebug();
  // the recorder is up last, so waiting for it means the board is fully open
  return report.history && typeof report.history === 'object' ? report[key] : null;
}, field, {timeout: 20000}).then((handle) => handle.jsonValue());

const clickUndo = (page) =>
  page.locator('.markup-draw-overlay .toolwidget-tag--undo .toolbar-button').first().click();

const browser = await launchBrowser();
const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await page.goto(BASE);

// --- session one: a drawing made from scratch

await openBoard(page);
// what an empty board looks like, to tell "the drawing is off screen" apart
// from "the drawing is there" further down
const blankBoard = await page.locator('.markup-draw-overlay canvas').first().screenshot();
const fresh = await historyOf(page);
check('a new drawing starts recording', fresh.problem === null && fresh.rejected === null);
check('the starting canvas is adopted as the log\'s first command', fresh.commands === 1);

await scribbleOnCanvas(page);
const box = await page.locator('.markup-draw-overlay canvas').first().boundingBox();
await drawStroke(page, [
  [box.x + box.width / 2 - 80, box.y + box.height / 2 + 80],
  [box.x + box.width / 2 + 80, box.y + box.height / 2 + 100],
]);
const drawn = await historyOf(page);
check('each stroke is recorded', drawn.commands === 3, `${drawn.commands} commands`);
check('the strokes are on the undo stack', drawn.undoStack === 3);
const drawnBoard = await page.locator('.markup-draw-overlay canvas').first().screenshot();
await saveBoard(page);

const fence1 = await source(page);
const journal1 = readJournal(fence1);
check('the saved fence carries a history comment', Boolean(journal1));
check('the payload is compressed', HISTORY_RE.exec(fence1)[2] === 'z');
check('the log is a script from an empty canvas',
  journal1.e.filter((e) => e[0] === OP_DO).length === 3);
check('the log fingerprints the SVG it describes', typeof journal1.h === 'string');
check('an adopted starting canvas has no time of its own',
  journal1.e[0][0] === OP_SESSION && journal1.e[0][1] === null);
check('the editing session carries an absolute anchor',
  journal1.e.some((e) => e[0] === OP_SESSION && typeof e[1] === 'number'));
check('gaps within a session are recorded',
  journal1.e.some((e) => e[0] === OP_DO && e[1] > 0));

const svg1 = stripFence(fence1).replace(HISTORY_RE, '');
check('the history rides inside the SVG, not beside it',
  !stripFence(fence1).startsWith('<!--') && svg1.endsWith('</svg>'));
check('one fence still holds one drawing', (fence1.match(/```js-draw/g) ?? []).length === 1);

const overhead = (stripFence(fence1).length - svg1.length) / svg1.length;
check('the history is a fraction of the drawing', overhead < 1.5,
  `svg ${svg1.length} chars, history +${Math.round(overhead * 100)}%`);

// --- it still renders, and the log is not mistaken for picture

await page.evaluate((text) => window.renderFence('standalone', text), stripFence(fence1));
const img = page.locator('#standalone img.markup-draw-image');
await img.waitFor({timeout: 10000});
check('a drawing with a history still renders', await img.evaluate((el) => el.complete && el.naturalWidth > 0));
check('rendering it reports no error', await page.locator('#standalone .markup-block-error').count() === 0);

// --- session two: the stack comes back

await setSource(page, fence1);
await openBoard(page);
const reopened = await historyOf(page);
check('reopening replays the log rather than loading the SVG',
  reopened.rejected === null && reopened.commands === 3);
check('the undo stack is restored across the session boundary', reopened.undoStack === 3);
check('the log knows which session each command came from', reopened.sessions === 3);

// A replay reinstates the strokes; the canvas they sit on comes from the SVG.
// Without that the board opens on js-draw's default region somewhere else
// entirely, so the drawing is off to one side of the view -- which is the whole
// symptom: a board zoomed into one corner with a stray grey box beside it.
const frame = await historyOf(page, 'boardCanvas');
const inView = (rect, view) =>
  rect.x + rect.w / 2 >= view.x && rect.x + rect.w / 2 <= view.x + view.w &&
  rect.y + rect.h / 2 >= view.y && rect.y + rect.h / 2 <= view.y + view.h;
check('a replayed drawing is inside the view, not off beside it',
  inView(frame.drawing, frame.visible),
  `drawing at ${JSON.stringify(frame.drawing)}, looking at ${JSON.stringify(frame.visible)}`);
check('the board shows something rather than empty canvas',
  Buffer.compare(await page.locator('.markup-draw-overlay canvas').first().screenshot(), blankBoard) !== 0);
await screenshot(page, 'history-reopened-board');

// Saving straight back out, with nothing touched in between, must reproduce the
// same canvas. It gets its own open/save cycle because the undo tests below
// empty the drawing, and an emptied autoresizing canvas legitimately shrinks.
await saveBoard(page);
const resaved = await source(page);
check('a replayed drawing saves back onto the same canvas',
  frameOf(resaved).viewBox === frameOf(fence1).viewBox,
  `${frameOf(fence1).viewBox} -> ${frameOf(resaved).viewBox}`);
check('and keeps whether that canvas grows with its content',
  frameOf(resaved).autoresize === frameOf(fence1).autoresize,
  `${frameOf(fence1).autoresize} -> ${frameOf(resaved).autoresize}`);
check('a round trip does not multiply the drawing',
  countPaths(resaved) === countPaths(fence1), `${countPaths(fence1)} -> ${countPaths(resaved)} paths`);

await setSource(page, fence1);
await openBoard(page);

// --- undoing back past the start of this session asks first

await clickUndo(page);
const elConfirm = page.locator('.markup-draw-confirm');
await elConfirm.waitFor({timeout: 5000});
check('undoing into an earlier session asks first', await elConfirm.count() === 1);
check('the question says when that work was done',
  /\d{1,4}[/:.\-\s]/.test(await elConfirm.textContent()));
await screenshot(page, 'history-undo-confirm');

await page.locator('.markup-draw-confirm-actions button').first().click();
await elConfirm.waitFor({state: 'detached', timeout: 5000});
check('declining leaves the work alone', (await historyOf(page)).undoStack === 3);

await clickUndo(page);
await elConfirm.waitFor({timeout: 5000});
await page.locator('.markup-draw-confirm-go').click();
await elConfirm.waitFor({state: 'detached', timeout: 5000});
check('accepting undoes it', (await historyOf(page)).undoStack === 2);

await clickUndo(page);
await page.waitForTimeout(400);
check('it does not ask again for a session already agreed to',
  await elConfirm.count() === 0 && (await historyOf(page)).undoStack === 1);

// the one below belongs to the adopted starting canvas, a different session
await clickUndo(page);
await elConfirm.waitFor({timeout: 5000});
check('it asks again when the next undo reaches a different session', await elConfirm.count() === 1);
check('a session with no recorded time says so, rather than inventing one',
  !/\d{4}/.test(await elConfirm.textContent()));
await page.locator('.markup-draw-confirm-actions button').first().click();
await elConfirm.waitFor({state: 'detached', timeout: 5000});

await saveBoard(page);
const fence2 = await source(page);
const journal2 = readJournal(fence2);
check('undoing is recorded too', journal2.e.filter((e) => e[0] === OP_UNDO).length === 2);
check('the saved SVG is the undone drawing', countPaths(fence2) === countPaths(fence1) - 2,
  `${countPaths(fence1)} -> ${countPaths(fence2)} paths`);

// --- session three: what was undone can still be redone

await setSource(page, fence2);
await openBoard(page);
const third = await historyOf(page);
check('a reopened board restores the undone state, not the drawn one',
  third.rejected === null && third.undoStack === 1);
await page.locator('.markup-draw-overlay .toolwidget-tag--redo .toolbar-button').first().click();
await page.waitForTimeout(300);
check('and can redo across the session boundary', (await historyOf(page)).undoStack === 2);
await saveBoard(page);
check('redoing brings the stroke back',
  countPaths(await source(page)) === countPaths(fence2) + 1);

// --- an SVG changed outside the board wins over the log

// a stroke taken out of the SVG by hand, the way someone resolving a merge or
// trimming a drawing in a text editor would
const tampered = fence1.replace(/<path(?![\s\S]*<path)[^>]*>/, '');
check('the tamper case really does change the drawing',
  countPaths(tampered) === countPaths(fence1) - 1);
await setSource(page, tampered);
await openBoard(page);
const tamperedInfo = await historyOf(page);
check('a hand-edited SVG is loaded, not replayed over',
  /edited outside the board/.test(tamperedInfo.rejected ?? ''), tamperedInfo.rejected ?? 'not rejected');
check('and recording starts again from what is actually there',
  tamperedInfo.problem === null && tamperedInfo.commands === 1);
await saveBoard(page);
check('so the hand edit survives instead of being undone by the log',
  countPaths(await source(page)) === countPaths(fence1) - 1,
  `${countPaths(fence1)} -> ${countPaths(await source(page))} paths`);

// --- a recorded command may not fetch a URL of its author's choosing
//
// The JSON way into js-draw is guarded less than the SVG way:
// ImageComponent.deserializeFromJSON assigns `src` straight through. Without
// the sanitiser, opening this drawing would call home for whoever wrote it.

const probeUrl = `${BASE}/should-never-be-fetched.png`;
const requested = [];
page.on('request', (req) => {
  if (req.url().includes('should-never-be-fetched')) requested.push(req.url());
});
await setSource(page, makeFence(
  '<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg"></svg>',
  {
    v: 1,
    e: [[OP_SESSION, null], [OP_DO, 0, {
      commandType: 'add-element',
      data: {
        elemData: {
          name: 'image-component',
          zIndex: 1,
          id: 'probe',
          data: {src: probeUrl, label: 'probe', width: 8, height: 8, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1]},
        },
      },
    }]],
  },
));
await openBoard(page);
const hostile = await historyOf(page);
await page.waitForTimeout(800);
check('a recorded remote image is neutralised, not fetched', requested.length === 0,
  requested.join(', '));
check('and the drawing still replays around it',
  hostile.rejected === null && hostile.blockedImages === 1,
  `blocked ${hostile.blockedImages}`);
await saveBoard(page);
check('the cleaned command is what gets written back',
  !readJournal(await source(page))?.e.some((e) => JSON.stringify(e).includes('should-never-be-fetched')));

// --- a log that parses but cannot replay must not leave half a drawing

await setSource(page, makeFence(
  '<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg"></svg>',
  {v: 1, e: [[OP_SESSION, null], [OP_DO, 0, {commandType: 'no-such-command', data: {}}]]},
));
await openBoard(page);
const broken = await historyOf(page);
check('an unreplayable log falls back to the SVG',
  /could not be replayed/.test(broken.rejected ?? ''), broken.rejected ?? 'not rejected');
check('and the board is usable rather than half-built', broken.problem === null);

// --- the switch, and the size limit the history must not eat into
//
// The limit is set between the drawing on its own and the drawing plus its log,
// so it can only pass if the log is excluded from the measurement.

const limit = svg1.length + 50;
const off = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await off.addInitScript((maxSourceChars) => {
  window.__cfgOverride = {history: false, maxSourceChars};
}, limit);
await off.goto(BASE);
await openBoard(off);
await scribbleOnCanvas(off);
await saveBoard(off);
check('history: false writes no comment', !HISTORY_RE.test(await source(off)));

await off.evaluate((text) => window.renderFence('standalone', text), stripFence(fence1));
await off.waitForTimeout(500);
check('a history does not count towards the drawing size limit',
  stripFence(fence1).length > limit && await off.locator('#standalone .markup-block-error').count() === 0,
  `drawing ${svg1.length}, with history ${stripFence(fence1).length}, limit ${limit}`);

// --- what it costs on a drawing with some work in it
//
// The overhead is fixed-cost heavy, so a two-stroke sketch is the worst case and
// says nothing useful. This is the number the README quotes.

const big = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await big.goto(BASE);
await openBoard(big);
const canvas = await big.locator('.markup-draw-overlay canvas').first().boundingBox();
for (let n = 0; n < 12; n++) {
  const y = canvas.y + 80 + n * 20;
  const points = [[canvas.x + 60, y]];
  for (let i = 1; i <= 14; i++) points.push([canvas.x + 60 + i * 30, y + Math.sin(i / 2 + n) * 18]);
  await drawStroke(big, points);
}
await saveBoard(big);
const fenceBig = stripFence(await source(big));
const svgBig = fenceBig.replace(HISTORY_RE, '');
// A log is a compressed second copy of the drawing -- js-draw serializes a
// stroke's path as the same "d" string the SVG carries -- so costing less than
// the drawing itself is the real bar. Storing anything per-component that is not
// needed (loadSaveData was the one) shows up here immediately.
const cost = (fenceBig.length - svgBig.length) / svgBig.length;
check('the history costs less than the drawing it describes', cost < 1,
  `svg ${svgBig.length} chars, history +${Math.round(cost * 100)}%`);
check('a busier drawing records every stroke',
  readJournal(await source(big)).e.filter((e) => e[0] === OP_DO).length === 13);

// --- playing a recorded history back
//
// A fresh page, because the first thing to check is that a rendered drawing does
// not deserialize anybody's recorded commands until somebody asks it to.

const viewer = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await viewer.addInitScript(() => {
  window.__cfgOverride = {playbackMinStep: 500, playbackMaxGap: 500, playbackSessionGap: 500};
});
await viewer.goto(BASE);
await viewer.evaluate((text) => window.renderFence('standalone', text), stripFence(fence1));
await viewer.locator('#standalone img.markup-draw-image').waitFor({timeout: 10000});
await viewer.waitForTimeout(400);

check('a drawing with a history offers a play button',
  await viewer.locator('#standalone .markup-draw-play').count() === 1);
check('rendering one does not load js-draw, let alone replay it',
  await viewer.evaluate(() => performance.getEntriesByType('resource')
    .every((r) => !r.name.includes('js-draw/bundle.js'))));

await viewer.evaluate(() => window.renderFence('standalone',
  '<svg viewBox="0 0 40 40" width="40" height="40" xmlns="http://www.w3.org/2000/svg"></svg>'));
await viewer.waitForTimeout(300);
check('a drawing without one does not', await viewer.locator('#standalone .markup-draw-play').count() === 1);

await viewer.locator('#standalone .markup-draw-play').first().click();
const player = viewer.locator('.markup-draw-player');
await player.waitFor({timeout: 30000});
await viewer.locator('.markup-draw-player canvas').first().waitFor({timeout: 30000});
check('the play button opens a player', await player.count() === 1);

const fill = () => viewer.locator('.markup-draw-player-fill').evaluate((el) => el.style.width);
await viewer.waitForTimeout(700);
await viewer.locator('.markup-draw-player-play').click(); // pause
const early = await fill();
const midway = await viewer.locator('.markup-draw-player-host').screenshot();
await viewer.waitForTimeout(1200);
check('pausing stops it where it was', await fill() === early, `stuck at ${early}`);

await viewer.locator('.markup-draw-player-play').click(); // resume
await viewer.waitForFunction(
  () => document.querySelector('.markup-draw-player-fill')?.style.width === '100%',
  null, {timeout: 30000},
);
check('it plays to the end', await fill() === '100%');
await viewer.locator('.markup-draw-player-caption')
  .filter({hasText: 'End of the recorded history'}).waitFor({timeout: 5000});
check('and says so', true);
check('a finished playback stops offering to pause itself',
  await viewer.locator('.markup-draw-player-play').isDisabled());
await viewer.locator('.markup-draw-player-restart').click();
await viewer.waitForTimeout(300);
check('restarting begins again from an empty canvas',
  await fill() !== '100%' && !await viewer.locator('.markup-draw-player-play').isDisabled(),
  `fill ${await fill()}`);
const ended = await viewer.locator('.markup-draw-player-host').screenshot();
check('the drawing appears as it goes, rather than all at once at the end',
  Buffer.compare(midway, ended) !== 0);
await screenshot(viewer, 'history-playback');

await viewer.locator('.markup-draw-player-close').click();
await player.waitFor({state: 'detached', timeout: 5000});
check('closing the player puts the page back', await viewer.locator('.markup-draw-player').count() === 0);

// --- a history that cannot be played says so instead of showing nothing

await viewer.evaluate(() => window.renderFence('standalone',
  '<svg viewBox="0 0 40 40" width="40" height="40" xmlns="http://www.w3.org/2000/svg">' +
  '<!--gitea-draw-history:1:z:bm90IGRlZmxhdGVkIGF0IGFsbA==--></svg>'));
await viewer.waitForTimeout(300);
await viewer.locator('#standalone .markup-draw-play').last().click();
await viewer.locator('.markup-draw-player').waitFor({timeout: 15000});
await viewer.waitForTimeout(800);
check('an unreadable history reports itself rather than hanging',
  /could not be played back/.test(await viewer.locator('.markup-draw-player-host').textContent()));
check('and only the close button is left to press',
  await viewer.locator('.markup-draw-player-play').isVisible() === false);

await browser.close();
finish();
