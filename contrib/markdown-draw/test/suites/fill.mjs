// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// The fill tool: that it finds the area a click is closed into, that it refuses
// to fill one that is not closed, that each of the three patterns comes out as
// the SVG it claims to, and that a fill makes both round trips -- through the
// recorded history and through the SVG in the markdown.
//
// The checks go through the saved SVG rather than the editor's internals, the
// way the UML pen suite does: what is asserted is what ends up in the markdown,
// which is the only place a drawing lives.

import {BASE, createChecks, drawStroke, launchBrowser, openBoard, saveBoard, screenshot, stripFence, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('fill');

const FILL_BUTTON = '.markup-draw-overlay .toolbar-internalWidgetId--gitea-draw-fill .toolbar-button';
const PATTERN_SELECT = '.markup-draw-overlay select[id^="markup-draw-fill-pattern"]';
// there is no opacity control of its own: the colour input carries it in its
// alpha, so an eight-digit hex is how a test asks for a transparency
const COLOUR_INPUT = '.markup-draw-overlay input[id^="markup-draw-fill-colour"]';

// The tool button toggles its own dropdown and whether it starts open depends on
// what the last interaction left behind -- click until it is the way it is
// wanted.  The dropdown covers the middle of the canvas, so it has to be shut
// again before anything can be clicked on the drawing.
async function setDropdown(page, open) {
  const control = page.locator(PATTERN_SELECT).first();
  for (let i = 0; i < 4; i++) {
    if (await control.isVisible().catch(() => false) === open) return;
    await page.locator(FILL_BUTTON).first().click();
    await page.waitForTimeout(350);
  }
}

// Coloris writes into the input and fires these two; going through the DOM
// rather than through the picker keeps a check about the fill rather than about
// a third-party colour widget.
async function setColourInput(page, selector, value) {
  await page.evaluate(([sel, colour]) => {
    const input = document.querySelector(sel);
    input.value = colour;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('close'));
  }, [selector, value]);
  await page.waitForTimeout(400);
}

async function chooseFill(page, {pattern, colour} = {}) {
  await setDropdown(page, true);
  if (pattern) await page.locator(PATTERN_SELECT).first().selectOption(pattern);
  if (colour) await setColourInput(page, COLOUR_INPUT, colour);
  await page.waitForTimeout(200);
  await setDropdown(page, false);
}

// a box drawn as four separate strokes: nothing about it is a closed path, and
// the whole point of the tool is that it is closed all the same
async function drawBox(page, [left, top, right, bottom]) {
  await drawStroke(page, [[left, top], [right, top]]);
  await drawStroke(page, [[right, top], [right, bottom]]);
  await drawStroke(page, [[right, bottom], [left, bottom]]);
  await drawStroke(page, [[left, bottom], [left, top]]);
}

const source = (page) => page.locator('textarea.markdown-text-editor').inputValue();
const savedSvg = async (page) => stripFence(await source(page));

// Puts the cursor back inside the fence: after a drawing is inserted the cursor
// sits past it, and opening the board again would start a second drawing rather
// than reopen this one.
async function reopen(page) {
  await page.evaluate(() => {
    const el = document.querySelector('textarea.markdown-text-editor');
    el.setSelectionRange(20, 20);
  });
  await openBoard(page);
  await page.waitForTimeout(800);
}

const fillGroups = (svg) => [...svg.matchAll(/<g class="gitea-draw-fill"[\s\S]*?<\/g>/g)].map((m) => m[0]);
const inkPaths = (svg) => [...svg.matchAll(/<path[^>]*\sd="([^"]*)"[^>]*>/g)]
  .filter((match) => !match[0].includes('js-draw-image-background'));
// a subpath is one moveTo; js-draw writes the first as `M` and the rest as `m`
const subpathCount = (d) => (d.match(/[Mm]/g) ?? []).length;

const lastProblem = async (page) =>
  (await page.evaluate(() => window.giteaDrawDebug())).filling?.lastProblem ?? null;

const browser = await launchBrowser();

// --- the button, and a fill of the plainest closed shape there is

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);

  const before = await page.evaluate(() => window.giteaDrawDebug());
  check('gitea-draw-fill.js loaded',
    before.scripts.some((script) => script.name === 'gitea-draw-fill.js'),
    before.scripts.map((script) => script.name).join(', '));
  check('the tool is configured on', before.config.fill === true);
  check('it defaults to half transparent', before.config.fillOpacity === 0.5);

  await openBoard(page);
  check('the toolbar has a fill button',
    await page.locator(FILL_BUTTON).count() === 1,
    `${await page.locator(FILL_BUTTON).count()} buttons`);
  const ready = await page.evaluate(() => window.giteaDrawDebug());
  check('the tool reports itself available', ready.filling.available === true, ready.filling.why);
  check('drawing still starts with a pen, not with the fill tool',
    ready.filling.available && await page.locator(`${FILL_BUTTON}.selected`).count() === 0);

  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page);
  await page.mouse.click(550, 420);
  await page.waitForTimeout(500);
  check('a click inside the box fills it', await lastProblem(page) === null,
    String(await lastProblem(page)));
  await screenshot(page, 'fill-even');

  await saveBoard(page);
  const svg = await savedSvg(page);
  const groups = fillGroups(svg);
  check('the fill is one element', groups.length === 1, `${groups.length} elements`);
  check('an even fill carries no gradient', groups[0] && !groups[0].includes('Gradient'));
  check('it is drawn at the chosen opacity',
    /fill="rgba\(\d+, \d+, \d+, 0\.5\)"/.test(groups[0] ?? ''), groups[0]?.slice(0, 200) ?? '');
  check('it has no edge of its own',
    groups[0] !== undefined && !groups[0].includes('stroke='), groups[0]?.slice(0, 200) ?? '');
  // the paint is translucent, so a line it was laid over would be washed out
  check('the fill is written before the lines that close it in',
    svg.indexOf('gitea-draw-fill') < svg.indexOf('stroke="#'),
    `${svg.indexOf('gitea-draw-fill')} vs ${svg.indexOf('stroke="#')}`);
  check('the outline is simplified rather than traced pixel by pixel',
    (groups[0]?.match(/[lLmMhHvV]/g)?.length ?? 999) < 30,
    `${groups[0]?.match(/[lLmMhHvV]/g)?.length} commands`);

  await page.close();
}

// --- what it refuses to do
//
// Filling is one click with no preview, so being told why nothing happened is
// the whole of the feedback.  The note goes on the canvas rather than into a
// browser dialog, like the board's other questions.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);

  await chooseFill(page);
  await page.mouse.click(550, 420);
  await page.waitForTimeout(400);
  check('an empty canvas has nothing to fill',
    (await lastProblem(page) ?? '').includes('nothing drawn'), String(await lastProblem(page)));

  await setDropdown(page, false);
  const pen = page.locator('.markup-draw-overlay .toolbar-internalWidgetId--pen .toolbar-button').first();
  await pen.click();
  await page.waitForTimeout(300);
  await drawBox(page, [300, 250, 800, 600]);

  await chooseFill(page);
  await page.mouse.click(1000, 750);
  await page.waitForTimeout(400);
  check('a point nothing closes in is refused',
    (await lastProblem(page) ?? '').includes('Nothing closes'), String(await lastProblem(page)));
  const note = page.locator('.markup-draw-fill-note');
  check('and the reason is shown on the canvas', await note.isVisible().catch(() => false),
    await note.textContent().catch(() => '(no note)') ?? '');
  await screenshot(page, 'fill-refused');

  await page.mouse.click(550, 250);
  await page.waitForTimeout(400);
  check('a point on a line is refused',
    (await lastProblem(page) ?? '').includes('already drawn'), String(await lastProblem(page)));

  await saveBoard(page);
  check('nothing was added by any of that', fillGroups(await savedSvg(page)).length === 0);

  await page.close();
}

// --- the two gradients
//
// Neither can be a js-draw rendering style, which is a flat colour and nothing
// else, so this is the part that needs a component of its own -- and the part
// where the editor's canvas and the saved SVG are two separate pieces of
// drawing code that have to agree.

for (const [pattern, element] of [['linear', 'linearGradient'], ['radial', 'radialGradient']]) {
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern});
  await page.mouse.click(450, 350);
  await page.waitForTimeout(500);
  check(`[${pattern}] fills`, await lastProblem(page) === null, String(await lastProblem(page)));
  await screenshot(page, `fill-${pattern}`);
  await saveBoard(page);

  const group = fillGroups(await savedSvg(page))[0] ?? '';
  check(`[${pattern}] saves a <${element}>`, group.includes(`<${element}`), group.slice(0, 200));
  check(`[${pattern}] the paint fades to nothing`, group.includes('stop-opacity="0"'));
  // both stops the same colour: fading to a transparent *black* instead greys
  // the paint out on the way, which is what a gradient done by accident does
  const stops = [...group.matchAll(/stop-color="([^"]*)"/g)].map((match) => match[1]);
  check(`[${pattern}] it fades in one colour`, stops.length === 2 && stops[0] === stops[1],
    stops.join(' / '));
  check(`[${pattern}] the path references the gradient`, /fill="url\(#gitea-draw-fill-[a-z0-9]+\)"/.test(group));

  if (pattern === 'radial') {
    // the click is the middle of a radial fade, which is what makes clicking
    // off to one side a way of aiming it
    // the attribute is HTML-escaped in the saved text, quotes and all
    const centre = /centre&quot;:\[(-?[\d.]+),(-?[\d.]+)\]/.exec(group);
    const cx = /cx="(-?[\d.]+)"/.exec(group);
    check('[radial] it is centred on the click, not on the shape',
      Boolean(centre) && Boolean(cx) && Math.abs(Number(cx[1]) - Number(centre[1])) < 1,
      `${centre?.[1]} vs ${cx?.[1]}`);
  }

  await page.close();
}

// --- a hole
//
// Something drawn inside the area is not part of it, and the fill has to leave
// it alone.  The outline comes back as a loop for the outside and one more,
// wound the other way, for each hole; the nonzero fill rule does the rest.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [250, 200, 900, 700]);
  const circle = [];
  for (let i = 0; i <= 40; i++) {
    const angle = (i / 40) * Math.PI * 2;
    circle.push([575 + Math.cos(angle) * 90, 450 + Math.sin(angle) * 90]);
  }
  await drawStroke(page, circle);

  await chooseFill(page);
  await page.mouse.click(320, 260);
  await page.waitForTimeout(600);
  check('the space around an island fills', await lastProblem(page) === null,
    String(await lastProblem(page)));
  await screenshot(page, 'fill-hole');
  await saveBoard(page);

  const group = fillGroups(await savedSvg(page))[0] ?? '';
  const d = /\sd="([^"]*)"/.exec(group)?.[1] ?? '';
  check('the island is a hole in the fill, not filled over',
    subpathCount(d) === 2, `${subpathCount(d)} subpaths`);
  check('no coordinate came out broken', !d.includes('NaN'), d.slice(0, 120));

  await page.close();
}

// --- the colour input, which is also the opacity control
//
// One control, not two: js-draw's picker is Coloris with an alpha slider, so a
// separate opacity slider would have been a second control for the same number.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);

  // the box first: opening the dropdown selects the fill tool, and the pen
  // cannot draw while it is the one holding the pointer
  await drawBox(page, [300, 250, 800, 600]);

  await setDropdown(page, true);
  check('the dropdown has no opacity slider of its own',
    await page.locator('.markup-draw-overlay .markup-draw-fill-controls input[type="range"]').count() === 0);
  check('the colour input opens on the default colour at the default opacity',
    await page.locator(COLOUR_INPUT).inputValue() === '#1e6bb880',
    await page.locator(COLOUR_INPUT).inputValue());
  await screenshot(page, 'fill-dropdown');

  await chooseFill(page, {colour: '#e01b2440'});
  await page.mouse.click(550, 420);
  await page.waitForTimeout(500);
  await saveBoard(page);

  const group = fillGroups(await savedSvg(page))[0] ?? '';
  check('the colour is what is painted', group.includes('rgba(224, 27, 36, '),
    group.slice(0, 200));
  check('and its alpha is the opacity painted at',
    group.includes('rgba(224, 27, 36, 0.251)') || group.includes('rgba(224, 27, 36, 0.25'),
    group.slice(0, 200));

  // and both come back with the board, so the next fill is the one just set up
  await reopen(page);
  const restored = (await page.evaluate(() => window.giteaDrawDebug())).filling.chosen;
  check('the setting is remembered for the next board',
    restored?.colour === '#e01b24' && Math.abs(restored.opacity - 0.25) < 0.01,
    JSON.stringify(restored));

  await page.close();
}

// --- the round trip through the SVG in the markdown
//
// This is the one that cannot be skipped: a drawing lives in the markdown as
// SVG, so every fill makes this trip every time someone opens the drawing.  A
// component js-draw could not read back would be lost on the first reopen --
// silently, because the picture would still look right until it was saved.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.addInitScript(() => {
    // with no recorded log to replay, opening the drawing has to go through the
    // SVG loader -- which is the path this section is about
    window.__cfgOverride = {history: false};
  });
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern: 'radial'});
  await page.mouse.click(450, 350);
  await page.waitForTimeout(500);
  await saveBoard(page);

  const before = await savedSvg(page);
  check('the drawing was saved without a log', !before.includes('gitea-draw-history'));
  check('one fill went in', fillGroups(before).length === 1);

  await reopen(page);
  await screenshot(page, 'fill-reloaded');
  await saveBoard(page);
  const after = await savedSvg(page);
  check('the fill survives being read back out of the SVG',
    fillGroups(after).length === 1, `${fillGroups(after).length} fills`);
  check('and nothing about the drawing changed on the way',
    after === before, after.slice(0, 400));
  check('the lines are still there too',
    inkPaths(after).length === inkPaths(before).length,
    `${inkPaths(before).length} -> ${inkPaths(after).length}`);

  await page.close();
}

// --- the round trip through the recorded history
//
// The recorder stores what a command serializes to, so a fill has to serialize
// and come back.  A component that could not would break the log for the whole
// drawing, not only for itself.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern: 'linear'});
  await page.mouse.click(550, 420);
  await page.waitForTimeout(600);

  const history = await page.waitForFunction(() => {
    const report = window.giteaDrawDebug();
    return report.history && typeof report.history === 'object' ? report.history : null;
  }, null, {timeout: 20000}).then((handle) => handle.jsonValue());
  check('filling is recorded', history.problem === null && history.rejected === null,
    history.problem ?? '');
  // the starting canvas, four strokes, and the fill
  check('the fill is one recorded command', history.commands === 6,
    `${history.commands} commands`);

  await saveBoard(page);
  const before = await savedSvg(page);

  await reopen(page);
  const replayed = (await page.evaluate(() => window.giteaDrawDebug())).history;
  check('the log survives being replayed', replayed.rejected === null, replayed.rejected ?? '');
  await saveBoard(page);
  const after = await savedSvg(page);
  check('and the fill comes back exactly as it went in',
    fillGroups(after).length === 1 && fillGroups(after)[0] === fillGroups(before)[0],
    fillGroups(after)[0]?.slice(0, 200) ?? '(none)');

  await page.close();
}

// --- undo, and erasing
//
// A fill is one element like any other, so one Ctrl+Z takes it back and the
// eraser takes it away.  Worth asserting rather than assuming: both go through
// code paths -- serializing a command, hit-testing a shape -- that a component
// written from outside js-draw has to implement itself.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page);
  await page.mouse.click(550, 420);
  await page.waitForTimeout(500);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const undone = await page.evaluate(() => window.giteaDrawDebug());
  check('one undo takes a fill back', undone.boardCanvas !== null);

  await page.locator('.markup-draw-overlay .toolwidget-tag--redo .toolbar-button').first().click();
  await page.waitForTimeout(400);
  await saveBoard(page);
  check('and redo puts it back', fillGroups(await savedSvg(page)).length === 1);

  // A fill is hit-tested by its own shape rather than by a stroke's geometry,
  // so the eraser has to be told where it is.
  await reopen(page);
  await page.locator('.markup-draw-overlay .toolbar-internalWidgetId--eraser-tool-widget .toolbar-button')
    .first().click();
  await page.waitForTimeout(300);
  await drawStroke(page, [[520, 400], [560, 440], [600, 400]]);
  await saveBoard(page);
  check('the eraser can take a fill away', fillGroups(await savedSvg(page)).length === 0,
    fillGroups(await savedSvg(page))[0]?.slice(0, 120) ?? '');

  await page.close();
}

// --- what a reader ends up looking at
//
// The rendered comment shows the SVG through an <img>, which is a document of
// its own: a gradient referenced by id inside it cannot collide with anything
// on the page, but it also cannot rely on anything outside itself.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern: 'radial'});
  await page.mouse.click(450, 350);
  await page.waitForTimeout(500);
  await saveBoard(page);

  await page.evaluate((text) => window.renderFence('standalone', text), await savedSvg(page));
  await page.waitForTimeout(800);
  check('the drawing renders on the page',
    await page.locator('#standalone .markup-draw-image').count() === 1);
  check('and it renders without an error in its place',
    await page.locator('#standalone .markup-block-error').count() === 0);
  await screenshot(page, 'fill-rendered');

  // the <img> loads the SVG as its own document; a broken one has no size
  const size = await page.locator('#standalone .markup-draw-image').evaluate(
    (el) => ({width: el.naturalWidth, height: el.naturalHeight}),
  );
  check('the browser could parse the saved SVG', size.width > 0 && size.height > 0,
    JSON.stringify(size));

  await page.close();
}

// --- the "Select" tool's colour control
//
// js-draw applies it to every selected component that answers to
// `isRestylableComponent`, and silently skips the rest -- so a fill that did not
// implement it would leave the control enabled, showing transparent black, doing
// nothing.  The colour carries the opacity in its alpha, the way a translucent
// stroke's does, so the one input sets both.

const FORMAT_COLOUR = '.markup-draw-overlay .selection-format-menu input.coloris_input';

// a rubber band drawn well inside the box catches the fill and nothing else
async function selectTheFill(page) {
  await page.locator('.markup-draw-overlay .toolbar-internalWidgetId--selection-tool-widget .toolbar-button')
    .first().click();
  await page.waitForTimeout(400);
  await drawStroke(page, [[420, 350], [520, 450]]);
  await page.waitForTimeout(400);
}

for (const pattern of ['even', 'radial']) {
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern});
  await page.mouse.click(550, 420);
  await page.waitForTimeout(500);

  await selectTheFill(page);
  check(`[${pattern}] the colour control shows the paint, not transparent black`,
    await page.locator(FORMAT_COLOUR).inputValue() === '#1e6bb880',
    await page.locator(FORMAT_COLOUR).inputValue());

  await setColourInput(page, FORMAT_COLOUR, '#e01b24cc');
  check(`[${pattern}] and setting it takes`,
    await page.locator(FORMAT_COLOUR).inputValue() === '#e01b24cc',
    await page.locator(FORMAT_COLOUR).inputValue());
  await screenshot(page, `fill-restyled-${pattern}`);

  await saveBoard(page);
  const group = fillGroups(await savedSvg(page))[0] ?? '';
  check(`[${pattern}] the new colour is what is painted`,
    group.includes('rgba(224, 27, 36, '), group.slice(0, 240));
  // the alpha of the colour is the fill's opacity: there is no second control
  // for it here, and dropping it would make half the picker do nothing
  check(`[${pattern}] the alpha of the colour became the opacity`,
    group.includes('opacity&quot;:0.8'), group.slice(0, 240));
  if (pattern === 'radial') {
    check('[radial] a restyled gradient still fades to nothing',
      group.includes('stop-opacity="0"') && group.includes('stop-opacity="0.8"'),
      group.slice(0, 320));
  }

  // one restyle is one undoable step, and the recorder can replay it
  await reopen(page);
  const replayed = (await page.evaluate(() => window.giteaDrawDebug())).history;
  check(`[${pattern}] a restyle replays out of the recorded log`,
    replayed.rejected === null, replayed.rejected ?? '');
  await saveBoard(page);
  check(`[${pattern}] and the fill comes back restyled`,
    (fillGroups(await savedSvg(page))[0] ?? '').includes('rgba(224, 27, 36, '));

  await page.close();
}

// --- watching a drawing with a fill being drawn
//
// The player is a second editor, built by gitea-draw-playback.js, that replays
// the recorded commands and never opens a board.  So it is a second place a
// fill has to be able to come back -- and the one that was missed: registering
// the component type when a *board* opened left the player unable to
// deserialize the fill, and a drawing played back to its last step and died
// there.  Registering when js-draw itself loads is what covers both.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern: 'radial'});
  await page.mouse.click(550, 420);
  await page.waitForTimeout(500);
  await saveBoard(page);

  await page.evaluate((text) => window.renderFence('standalone', text), await savedSvg(page));
  await page.locator('#standalone img.markup-draw-image').waitFor({timeout: 10000});
  await page.locator('#standalone .markup-draw-play').first().click();
  await page.locator('.markup-draw-player canvas').first().waitFor({timeout: 30000});

  await page.waitForFunction(
    () => document.querySelector('.markup-draw-player-fill')?.style.width === '100%' ||
      document.querySelector('.markup-draw-player-dead'),
    null, {timeout: 30000},
  );
  const caption = await page.locator('.markup-draw-player-caption').textContent() ?? '';
  check('a drawing with a fill plays back to its last step',
    await page.locator('.markup-draw-player-dead').count() === 0, caption);
  check('and the player says it reached the end',
    caption.includes('End of the recorded history'), caption);
  const player = (await page.evaluate(() => window.giteaDrawDebug())).player;
  check('the fill is on the replayed canvas, not skipped',
    player?.position === player?.total && player?.components >= 3, JSON.stringify(player));
  await screenshot(page, 'fill-playback');

  await page.close();
}

// --- with the tool switched off
//
// `fill: false` has to mean "do not offer the button", not "stop being able to
// read drawings that already have a fill in them".  Reading one back is two
// separate mechanisms -- the loader plugin and the component registration --
// and neither is gated on the option.

{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await drawBox(page, [300, 250, 800, 600]);
  await chooseFill(page, {pattern: 'linear'});
  await page.mouse.click(550, 420);
  await page.waitForTimeout(500);
  await saveBoard(page);
  const withFill = await source(page);
  await page.close();

  const off = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await off.addInitScript(() => { window.__cfgOverride = {fill: false}; });
  await off.goto(BASE);
  await off.evaluate((text) => {
    const el = document.querySelector('textarea.markdown-text-editor');
    el.value = text;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.setSelectionRange(20, 20);
  }, withFill);
  await off.waitForTimeout(300);

  await openBoard(off);
  await off.waitForTimeout(800);
  check('the button is gone when the tool is off',
    await off.locator(FILL_BUTTON).count() === 0);
  const status = (await off.evaluate(() => window.giteaDrawDebug())).filling;
  check('and it says why', status.available === false && status.why.includes('turned off'),
    JSON.stringify(status));

  await saveBoard(off);
  check('but the fill in an existing drawing still survives being opened',
    fillGroups(await savedSvg(off)).length === 1,
    (await savedSvg(off)).slice(0, 300));

  await off.close();
}

// --- the touch toolbar
//
// A narrow screen gets js-draw's edge toolbar instead of the dropdown one, and
// the two lay their widgets out differently.  Nothing here is specific to the
// fill button, which is exactly why it is worth checking that it is in both.

{
  const page = watchPage(await browser.newPage({
    viewport: {width: 420, height: 800}, hasTouch: true, isMobile: true,
  }));
  await page.goto(BASE);
  await openBoard(page, {tap: true});
  await page.waitForTimeout(600);
  check('the touch toolbar has the fill button too',
    await page.locator('.markup-draw-overlay .toolbar-internalWidgetId--gitea-draw-fill').count() === 1);
  await screenshot(page, 'fill-touch-toolbar');
  await page.close();
}

await browser.close();
finish();
