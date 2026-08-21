// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// "Fit…", the second entry added to the selection menu: that it sits beside
// "Align…" rather than inside it, that it is offered only where it means
// something, that each of its three fits puts the path on the edges of the box
// the path already filled, and that one undo takes the original back.
//
// Checks go through the saved SVG rather than through the editor's internals,
// so what is asserted is what ends up in the markdown.  They also go through
// the SVG DOM rather than the `d` string: js-draw writes each command absolute
// or relative by whichever is shorter, so `d` is not a stable thing to read.

import {BASE, createChecks, drawStroke, launchBrowser, openBoard, saveBoard, screenshot, stripFence, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('path-fit');
const browser = await launchBrowser();
const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await page.goto(BASE);

// positions of the three buttons in the fit panel
const FIT = {sharp: 0, rounded: 1, curve: 2};

// A rough elbow: a hand never lands on the corner it means, and a fit that only
// worked on a stroke already drawn square would prove nothing.  The wobble is
// deterministic so that two runs compare.
function roughElbow({x, y, w, h, viaTop}) {
  const wobble = (i) => ((i * 7) % 5) - 2;
  const points = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    points.push(viaTop
      ? [x + w * t + wobble(i), y + wobble(i + 1)]
      : [x + wobble(i), y + h * t + wobble(i + 1)]);
  }
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    points.push(viaTop
      ? [x + w + wobble(i), y + h * t + wobble(i + 1)]
      : [x + w * t + wobble(i), y + h + wobble(i + 1)]);
  }
  return points;
}

// A capital G in one stroke: from about two o'clock, anticlockwise over the
// top, down the left, along the bottom and up the right, then in along the
// crossbar.  Neither of its ends is at a corner of the box it spans and the
// second is well inside it, which is the case the fit has to keep rather than
// round off to the nearest corner.
function roughG({x, y, w, h}) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const wobble = (i) => ((i * 7) % 5) - 2;
  const points = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const angle = -Math.PI / 3 - (i / steps) * (Math.PI * 5) / 3;
    points.push([
      cx + rx * Math.cos(angle) + wobble(i),
      cy + ry * Math.sin(angle) + wobble(i + 1),
    ]);
  }
  for (let i = 1; i <= 8; i++) {
    points.push([cx + rx - (i / 8) * rx * 0.9 + wobble(i), cy + wobble(i + 1)]);
  }
  return points;
}

async function useSelectionTool(page) {
  await page.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button')
    .first().click();
  await page.waitForTimeout(150);
}

// A rubber band over the given rectangle; js-draw takes what it encloses.
async function selectWithin(page, [x1, y1], [x2, y2]) {
  await useSelectionTool(page);
  await drawStroke(page, [[x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2], [x2, y2]]);
  await page.waitForTimeout(300);
}

// The menu's own entries are hidden rather than removed while a panel is up,
// so anything that has to be reachable is asked for as visible.
const panel = (page) => page.locator('.markup-draw-align-panel');
const actions = (page) => panel(page).locator('.markup-draw-align-grid button');
const fitEntry = (page) => page.locator('.markup-draw-fit-entry');

async function openMenu(page) {
  await page.locator('.selection-tool-selection-menu button').first().click();
  await page.locator('dialog.editor-popup-menu .content').waitFor({timeout: 5000});
  await fitEntry(page).waitFor({timeout: 5000});
}

async function openFitPanel(page) {
  await openMenu(page);
  await fitEntry(page).click();
  await panel(page).waitFor({timeout: 5000});
}

const clickFit = async (page, name) => {
  await actions(page).nth(FIT[name]).click();
  await page.waitForTimeout(300);
};

// js-draw names a pen type on the <label> of its radio button.
async function choosePen(page, label) {
  const button = page.locator('.markup-draw-overlay .toolbar-internalWidgetId--pen .toolbar-button')
    .first();
  const option = page.locator(`.markup-draw-overlay .toolbar-dropdown label[title="${label}"]`).first();
  for (let i = 0; i < 3; i++) {
    if (await option.isVisible().catch(() => false)) break;
    await button.click();
    await page.waitForTimeout(400);
  }
  await option.click();
  await page.waitForTimeout(200);
  await button.click();
  await page.waitForTimeout(300);
}

// Where the saved path sits and where it goes.  200 samples is well over the
// number of commands any fit produces, so a corner cannot fall between two.
async function savedPath(page) {
  const value = await page.locator('textarea.markdown-text-editor').inputValue();
  return page.evaluate((svgText) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden';
    host.innerHTML = svgText;
    document.body.append(host);
    const els = [...host.querySelectorAll('svg > path:not(.js-draw-image-background)')];
    const el = els[0];
    if (!el) {
      host.remove();
      return {count: 0};
    }
    const box = el.getBBox();
    const length = el.getTotalLength();
    const points = [];
    for (let i = 0; i <= 200; i++) {
      const {x, y} = el.getPointAtLength((length * i) / 200);
      points.push([x, y]);
    }
    const result = {
      count: els.length,
      d: el.getAttribute('d'),
      colour: el.getAttribute('stroke'),
      pen: Number.parseFloat(el.getAttribute('stroke-width') ?? '0'),
      box: {x: box.x, y: box.y, w: box.width, h: box.height},
      points,
    };
    host.remove();
    return result;
  }, stripFence(value));
}

const insideBox = (box, [x, y]) => Math.min(
  Math.abs(x - box.x), Math.abs(x - (box.x + box.w)),
  Math.abs(y - box.y), Math.abs(y - (box.y + box.h)),
);

// how far the path strays from the edges of its own bounding box: for a square
// fit only as far as the hop out to a kept end, a quarter of the corner radius
// more for a rounded one, and a good fraction of the box for a curve
const offEdges = (path) => Math.max(...path.points.map((point) => insideBox(path.box, point)));

// how far in from the box the two kept ends sit, which is the length of the
// longer of those two hops
const endsInset = (path) => Math.max(...endsOf(path).map((point) => insideBox(path.box, point)));

const nearest = (path, [cx, cy]) => Math.min(...path.points.map(
  ([x, y]) => Math.hypot(x - cx, y - cy),
));

const endsOf = (path) => [path.points[0], path.points[path.points.length - 1]];

// The fit is rounded to the viewport's grid on the way out, the same as every
// stroke js-draw saves, so "unmoved" is to within that rounding.
const keptEnds = (fitted, original) => endsOf(fitted).every(
  ([x, y], i) => Math.hypot(x - endsOf(original)[i][0], y - endsOf(original)[i][1]) < 1.5,
);

// A corner between two samples is only ever found to within half the spacing
// between them, which over these boxes is a little over one unit.  Anything
// this close is the path passing through the corner; the checks that want the
// opposite answer are two orders of magnitude away from it.
const TOUCHES = 3;

const corners = (box) => ({
  topLeft: [box.x, box.y],
  topRight: [box.x + box.w, box.y],
  bottomRight: [box.x + box.w, box.y + box.h],
  bottomLeft: [box.x, box.y + box.h],
});

// how many drawing commands the path is made of, and how many of them curve
const commandCount = (d) => (d.match(/[MLQCmlqc]/g) ?? []).length;
const curveCount = (d) => (d.match(/[QCqc]/g) ?? []).length;

// Each scenario starts from an empty editor, so no board inherits a drawing
// from the one before.
async function runScenario({draw, act}) {
  await page.locator('textarea.markdown-text-editor').evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.setSelectionRange(0, 0);
  });
  await openBoard(page);
  await draw(page);
  const result = await act(page);
  if (await page.locator('dialog.editor-popup-menu').count()) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await saveBoard(page);
  return {...result, path: await savedPath(page)};
}

const ELBOW = {x: 340, y: 300, w: 280, h: 170};
const AROUND_ELBOW = [[300, 260], [680, 520]];

// --- the entry itself

await openBoard(page);
await drawStroke(page, roughElbow({...ELBOW, viaTop: true}));
await selectWithin(page, ...AROUND_ELBOW);
await openMenu(page);

const options = await page.locator('dialog.editor-popup-menu .content > button')
  .evaluateAll((els) => els.map((el) => el.textContent.trim()));
check('"Fit…" sits in the selection menu beside "Align…", not inside it',
  options.includes('Fit…') && options.includes('Align…'), options.join(', '));
check('...after it, and after everything js-draw put there',
  options.indexOf('Fit…') === options.length - 1 &&
  options.indexOf('Align…') === options.length - 2, options.join(', '));
check("js-draw's own menu entries are left alone",
  ['Duplicate', 'Delete', 'Copy to clipboard'].every((label) => options.includes(label)));
check('"Fit…" is enabled for a single path', !await fitEntry(page).isDisabled());
await screenshot(page, 'path-fit-menu');

await fitEntry(page).click();
await panel(page).waitFor({timeout: 5000});
check('the fit panel replaces the menu with three fits',
  await actions(page).count() === 3 &&
  await page.locator('dialog.editor-popup-menu .content > button:visible').count() === 0);
check('the fit panel names what it fits to',
  (await panel(page).locator('.markup-draw-align-base').textContent()).includes('bounding box'));
await screenshot(page, 'path-fit-panel');

await panel(page).locator('.markup-draw-align-back').click();
await page.waitForTimeout(250);
check('"Back" returns to js-draw\'s own menu, not to the align panel',
  await panel(page).count() === 0 &&
  await page.locator('dialog.editor-popup-menu .content > button:visible').count() === options.length);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape closes the menu without closing the board',
  await page.locator('.markup-draw-overlay').count() === 1 &&
  await page.locator('dialog.editor-popup-menu').count() === 0);
await saveBoard(page);

// --- when it is offered, and when it is not

const twoPaths = await runScenario({
  draw: async (page) => {
    await drawStroke(page, roughElbow({...ELBOW, viaTop: true}));
    await drawStroke(page, roughElbow({x: 750, y: 300, w: 200, h: 150, viaTop: true}));
  },
  act: async (page) => {
    await selectWithin(page, [300, 260], [1000, 520]);
    await openMenu(page);
    return {
      disabled: await fitEntry(page).isDisabled(),
      why: await fitEntry(page).getAttribute('title'),
    };
  },
});
check('"Fit…" is greyed out with two elements selected', twoPaths.disabled);
check('...and says why', /one path at a time/.test(twoPaths.why ?? ''), twoPaths.why);

const filled = await runScenario({
  draw: async (page) => {
    await choosePen(page, 'Arrow');
    await drawStroke(page, [[340, 300], [620, 470]]);
  },
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openMenu(page);
    return {
      disabled: await fitEntry(page).isDisabled(),
      why: await fitEntry(page).getAttribute('title'),
    };
  },
});
check('"Fit…" is greyed out for a filled shape', filled.disabled);
check('...and says why', /filled shape/.test(filled.why ?? ''), filled.why);

// the toolbar's state is saved across boards, so put the arrow pen away again
// -- "Round" is js-draw's own freehand pen, the one every check below draws with
await openBoard(page);
await choosePen(page, 'Round');
await saveBoard(page);

// --- the three fits

const rough = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: true})),
  act: async () => ({}),
});
check('a rough elbow is drawn as many commands',
  commandCount(rough.path.d) > 8, `${commandCount(rough.path.d)} commands`);

const sharp = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: true})),
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openFitPanel(page);
    await clickFit(page, 'sharp');
    return {};
  },
});
check('a square fit leaves one path, not two', sharp.path.count === 1, `${sharp.path.count}`);
check('a square fit starts and ends exactly where the stroke did',
  keptEnds(sharp.path, rough.path),
  `${JSON.stringify(endsOf(sharp.path))} vs ${JSON.stringify(endsOf(rough.path))}`);
check('a square fit is straight lines only', curveCount(sharp.path.d) === 0, sharp.path.d);
// reaching back out to a kept end is the only thing that may take a square fit
// off an edge of the box, so the hop to the further of the two bounds it
check('a square fit is on the box everywhere but the hops out to those ends',
  offEdges(sharp.path) <= endsInset(sharp.path) + 0.5,
  `${offEdges(sharp.path).toFixed(2)} off, ends ${endsInset(sharp.path).toFixed(2)} in`);
check('a square fit keeps the box the rough stroke had',
  Math.abs(sharp.path.box.w - rough.path.box.w) < 1 &&
  Math.abs(sharp.path.box.h - rough.path.box.h) < 1,
  `${sharp.path.box.w.toFixed(1)}x${sharp.path.box.h.toFixed(1)} vs ` +
  `${rough.path.box.w.toFixed(1)}x${rough.path.box.h.toFixed(1)}`);
check('a square fit keeps the stroke\'s colour and width',
  sharp.path.colour === rough.path.colour && sharp.path.pen === rough.path.pen,
  `${sharp.path.colour} ${sharp.path.pen} vs ${rough.path.colour} ${rough.path.pen}`);

const rounded = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: true})),
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openFitPanel(page);
    await clickFit(page, 'rounded');
    return {};
  },
});
// exactly one per turn the square fit makes, which is its every vertex bar the
// two ends -- the ends are free and have nothing to round
check('a rounded fit curves at each corner it turns and nowhere else',
  curveCount(rounded.path.d) === commandCount(sharp.path.d) - 2,
  `${curveCount(rounded.path.d)} curves, square fit turns ${commandCount(sharp.path.d) - 2} times`);
check('a rounded fit starts and ends exactly where the stroke did',
  keptEnds(rounded.path, rough.path));
// a quadratic cut back by r from a right-angled corner sits r/4 inside it at
// its furthest, and r is a quarter of the shorter side
check('a rounded fit leaves the edges only at the corner',
  offEdges(rounded.path) > 1 && offEdges(rounded.path) < Math.min(
    rounded.path.box.w, rounded.path.box.h,
  ) / 12,
  offEdges(rounded.path).toFixed(2));

const curve = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: true})),
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openFitPanel(page);
    await clickFit(page, 'curve');
    return {};
  },
});
// one Bezier per corner turned, the same as the rounded fit -- except that a
// route turning only once or twice is a single quadratic or cubic instead
check('a curve fit is a Bezier per corner it turns',
  curveCount(curve.path.d) === commandCount(sharp.path.d) - 2, curve.path.d);
check('a curve fit starts and ends exactly where the stroke did',
  keptEnds(curve.path, rough.path));
check('a curve fit leans into the corner between them without reaching it',
  nearest(curve.path, corners(curve.path.box).topRight) > 20 &&
  offEdges(curve.path) > Math.min(curve.path.box.w, curve.path.box.h) / 8,
  `${nearest(curve.path, corners(curve.path.box).topRight).toFixed(1)} away, ` +
  `${offEdges(curve.path).toFixed(1)} off the edges`);
await screenshot(page, 'path-fit-curve');

// --- which way round the box the fit goes

const underneath = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: false})),
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openFitPanel(page);
    await clickFit(page, 'sharp');
    return {};
  },
});
check('a stroke that went over the top is fitted over the top',
  nearest(sharp.path, corners(sharp.path.box).topRight) < TOUCHES &&
  nearest(sharp.path, corners(sharp.path.box).bottomLeft) > 50);
check('a stroke that went under the bottom is fitted under the bottom',
  nearest(underneath.path, corners(underneath.path.box).bottomLeft) < TOUCHES &&
  nearest(underneath.path, corners(underneath.path.box).topRight) > 50);

// --- the ends are kept, wherever on the shape they fell

const G = {x: 400, y: 260, w: 260, h: 300};
const AROUND_G = [[350, 210], [720, 620]];

const roughGee = await runScenario({
  draw: (page) => drawStroke(page, roughG(G)),
  act: async () => ({}),
});
const gee = await runScenario({
  draw: (page) => drawStroke(page, roughG(G)),
  act: async (page) => {
    await selectWithin(page, ...AROUND_G);
    await openFitPanel(page);
    await clickFit(page, 'sharp');
    // the menu sits over the drawing, so put it away before photographing it
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await screenshot(page, 'path-fit-g');
    return {};
  },
});
check('a G keeps both of its ends, neither of which is at a corner',
  keptEnds(gee.path, roughGee.path),
  `${JSON.stringify(endsOf(gee.path))} vs ${JSON.stringify(endsOf(roughGee.path))}`);
check('...which are not corners to begin with',
  Math.min(...Object.values(corners(roughGee.path.box))
    .map((corner) => nearest({points: endsOf(roughGee.path)}, corner))) > 20);
check('a G is fitted as straight lines only', curveCount(gee.path.d) === 0, gee.path.d);
check('a G is on the box everywhere but the hops out to those ends',
  offEdges(gee.path) <= endsInset(gee.path) + 0.5,
  `${offEdges(gee.path).toFixed(2)} off, ends ${endsInset(gee.path).toFixed(2)} in`);
check('a G runs round the three corners its arc encloses',
  ['topLeft', 'bottomLeft', 'bottomRight']
    .every((corner) => nearest(gee.path, corners(gee.path.box)[corner]) < TOUCHES),
  ['topLeft', 'bottomLeft', 'bottomRight', 'topRight']
    .map((c) => `${c} ${nearest(gee.path, corners(gee.path.box)[c]).toFixed(1)}`).join(', '));
check('...and not round the corner its gap is on',
  nearest(gee.path, corners(gee.path.box).topRight) > 20);

// --- a fit can be replaced, and taken back

const rethought = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: true})),
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openFitPanel(page);
    await clickFit(page, 'sharp');
    await clickFit(page, 'rounded');
    return {};
  },
});
check('a second fit works on the first, not beside it',
  rethought.path.count === 1 &&
  curveCount(rethought.path.d) === curveCount(rounded.path.d), rethought.path.d);
check('...and lands on the same box, and the same ends, the first one did',
  Math.abs(rethought.path.box.w - sharp.path.box.w) < 1 &&
  Math.abs(rethought.path.box.h - sharp.path.box.h) < 1 &&
  keptEnds(rethought.path, sharp.path));

const undone = await runScenario({
  draw: (page) => drawStroke(page, roughElbow({...ELBOW, viaTop: true})),
  act: async (page) => {
    await selectWithin(page, ...AROUND_ELBOW);
    await openFitPanel(page);
    await clickFit(page, 'sharp');
    // the menu is modal, undo is behind it
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.locator('.markup-draw-overlay .toolwidget-tag--undo .toolbar-button')
      .first().click();
    await page.waitForTimeout(300);
    return {};
  },
});
check('a single undo takes back a whole fit',
  undone.path.count === 1 && commandCount(undone.path.d) === commandCount(rough.path.d),
  `${commandCount(undone.path.d)} commands, rough had ${commandCount(rough.path.d)}`);

// --- a closed stroke has no free ends, so every corner is a turn

const ring = await runScenario({
  draw: (page) => {
    const points = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      points.push([480 + Math.cos(a) * 140, 400 + Math.sin(a) * 100]);
    }
    return drawStroke(page, points);
  },
  act: async (page) => {
    await selectWithin(page, [300, 260], [680, 540]);
    await openFitPanel(page);
    await clickFit(page, 'curve');
    return {};
  },
});
check('a closed stroke fits to a closed curve, one per corner',
  curveCount(ring.path.d) === 4, ring.path.d);
check('...that stays inside the box it came from',
  offEdges(ring.path) > Math.min(ring.path.box.w, ring.path.box.h) / 8,
  offEdges(ring.path).toFixed(1));

await browser.close();
finish();
