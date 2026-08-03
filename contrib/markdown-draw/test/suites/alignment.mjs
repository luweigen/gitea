// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Lining up elements that have already been drawn: the "Align…" entry added to
// the selection's own "…" menu, and the geometry behind it.
//
// Every check goes through the saved SVG rather than through the editor's
// internals, so what is asserted is what ends up in the markdown.

import {BASE, createChecks, drawStroke, launchBrowser, openBoard, saveBoard, screenshot, stripFence, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('alignment');
const browser = await launchBrowser();
const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await page.goto(BASE);

// positions of the buttons in the 3x4 panel grid
const ALIGN = {
  left: 0, centerX: 1, right: 2,
  top: 3, centerY: 4, bottom: 5,
  distributeX: 6, distributeY: 7, snapToGrid: 8,
  matchWidth: 9, matchHeight: 10, matchSize: 11,
};

// An L, drawn the same way every time so that strokes only differ by where
// they sit and by how far they reach.
const stroke = (x, y, w = 60, h = 40) => [[x, y], [x + w, y], [x + w, y + h]];

async function selectAll(page) {
  await page.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button').first().click();
  await page.waitForTimeout(150);
  await drawStroke(page, [[120, 200], [500, 450], [1150, 780]]);
  await page.waitForTimeout(300);
}

async function openAlignPanel(page) {
  await page.locator('.selection-tool-selection-menu button').first().click();
  await page.locator('dialog.editor-popup-menu .content').waitFor({timeout: 5000});
  await page.locator('.markup-draw-align-entry').click();
  await page.locator('.markup-draw-align-grid').waitFor({timeout: 5000});
}

const clickAction = async (page, name) => {
  await page.locator('.markup-draw-align-grid button').nth(ALIGN[name]).click();
  await page.waitForTimeout(250);
};

// js-draw's own bounding box -- and so alignment -- covers the ink, which
// reaches half a stroke width past the path itself.  Reading stroke-width back
// out of the SVG keeps the checks in the same terms the feature works in.
async function boxesFromEditor(page) {
  const value = await page.locator('textarea.markdown-text-editor').inputValue();
  return page.evaluate((svgText) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden';
    host.innerHTML = svgText;
    document.body.append(host);
    const boxes = [...host.querySelectorAll('svg > path:not(.js-draw-image-background)')]
      .map((el) => {
        const box = el.getBBox();
        const pen = Number.parseFloat(el.getAttribute('stroke-width') ?? '0');
        return {
          pen,
          left: box.x - pen / 2, top: box.y - pen / 2,
          width: box.width + pen, height: box.height + pen,
        };
      })
      .map((box) => ({...box, right: box.left + box.width, bottom: box.top + box.height}));
    host.remove();
    return boxes;
  }, stripFence(value));
}

// Each scenario starts from an empty editor, so the boards never inherit a
// drawing from the one before.
async function runScenario({strokes, act, select = selectAll}) {
  await page.locator('textarea.markdown-text-editor').evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.setSelectionRange(0, 0);
  });
  await openBoard(page);
  for (const points of strokes) await drawStroke(page, points);
  await select(page);
  await act(page);
  // Escape has to dismiss the menu without taking the board with it
  if (await page.locator('dialog.editor-popup-menu').count()) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  const stillOpen = await page.locator('.markup-draw-overlay').count() === 1;
  await saveBoard(page);
  return {boxes: await boxesFromEditor(page), stillOpen};
}

const spread = (values) => Math.max(...values) - Math.min(...values);
const sorted = (boxes, key) => [...boxes].sort((a, b) => a[key] - b[key]);

// --- the menu entry itself
await openBoard(page);
await drawStroke(page, stroke(200, 300));
await drawStroke(page, stroke(500, 400));
await selectAll(page);
await page.locator('.selection-tool-selection-menu button').first().click();
await page.locator('dialog.editor-popup-menu .content').waitFor({timeout: 5000});
const options = await page.locator('dialog.editor-popup-menu .content > button')
  .evaluateAll((els) => els.map((el) => el.textContent.trim()));
check('"Align…" is added to the selection menu', options.includes('Align…'), options.join(', '));
check("js-draw's own menu entries are left alone",
  ['Duplicate', 'Delete', 'Copy to clipboard'].every((label) => options.includes(label)));
check('the align entry is the last one', options[options.length - 1] === 'Align…');

await page.locator('.markup-draw-align-entry').click();
await page.locator('.markup-draw-align-grid').waitFor({timeout: 5000});
check('the panel replaces the menu with twelve actions',
  await page.locator('.markup-draw-align-grid button').count() === 12);
check('js-draw\'s own entries are hidden while the panel is up',
  await page.locator('dialog.editor-popup-menu .content > button.editor-popup-menu-option:visible').count() === 0);
check('the base object is named', (await page.locator('.markup-draw-align-base span').first().textContent()) === 'Base: 1 of 2');
check('the base object is outlined on the canvas',
  await page.locator('.markup-draw-base-box').isVisible());

// the menu opens on top of what it acts on, so it has to be see-through
const menuBackground = await page.locator('dialog.editor-popup-menu > .content')
  .evaluate((el) => getComputedStyle(el).backgroundColor);
const menuAlpha = ((match) => (match ? Number(match[1]) : 1))(
  menuBackground.match(/[,/]\s*([\d.]+)\s*\)$/),
);
check('the menu lets what is under it show through',
  menuAlpha > 0.3 && menuAlpha < 1, menuBackground);
await screenshot(page, 'alignment-panel');

await page.locator('.markup-draw-align-back').click();
await page.waitForTimeout(200);
check('"Back" returns to js-draw\'s own menu',
  await page.locator('.markup-draw-align-grid').count() === 0 &&
  await page.locator('dialog.editor-popup-menu .content > button:visible').count() === options.length);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape closes the menu without closing the board',
  await page.locator('.markup-draw-overlay').count() === 1 &&
  await page.locator('dialog.editor-popup-menu').count() === 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape with no menu open still closes the board',
  await page.locator('.markup-draw-overlay').count() === 0);

// --- aligning to the base object
const three = [stroke(200, 300), stroke(400, 380), stroke(620, 460)];

const left = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'left');
  },
});
check('the board survives Escape after an alignment', left.stillOpen);
check('align left puts every left edge on the base object',
  left.boxes.length === 3 && spread(left.boxes.map((b) => b.left)) < 0.5,
  left.boxes.map((b) => b.left.toFixed(1)).join(' '));
check('align left leaves the other axis alone',
  spread(left.boxes.map((b) => b.top)) > 100);

const top = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'top');
  },
});
check('align top puts every top edge on the base object',
  spread(top.boxes.map((b) => b.top)) < 0.5,
  top.boxes.map((b) => b.top.toFixed(1)).join(' '));

const right = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'right');
  },
});
check('align right puts every right edge on the base object',
  spread(right.boxes.map((b) => b.right)) < 0.5);

const centres = await runScenario({
  strokes: [stroke(200, 300, 60), stroke(400, 380, 140), stroke(620, 460, 30)],
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'centerX');
  },
});
check('align horizontal centres works on elements of different widths',
  spread(centres.boxes.map((b) => b.left + b.width / 2)) < 0.5);

// --- one command per action, so one undo takes the whole thing back
const undone = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'left');
    await page.keyboard.press('Escape'); // the menu is modal, undo is behind it
    await page.waitForTimeout(200);
    await page.locator('.markup-draw-overlay .toolwidget-tag--undo .toolbar-button').first().click();
    await page.waitForTimeout(300);
  },
});
check('a single undo takes back a whole alignment',
  spread(undone.boxes.map((b) => b.left)) > 300,
  undone.boxes.map((b) => b.left.toFixed(1)).join(' '));

// --- the base object can be stepped through
const cycled = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await page.locator('.markup-draw-align-next').click();
    await page.locator('.markup-draw-align-next').click();
    check('stepping through the selection renames the base',
      (await page.locator('.markup-draw-align-base span').first().textContent()) === 'Base: 3 of 3');
    await clickAction(page, 'left');
  },
});
check('a different base object gives a different result',
  spread(cycled.boxes.map((b) => b.left)) < 0.5 &&
  Math.abs(cycled.boxes[0].left - left.boxes[0].left) > 300,
  `${cycled.boxes[0].left.toFixed(1)} vs ${left.boxes[0].left.toFixed(1)}`);

// --- a lone element aligns to everything drawn, there being no base object
const lone = await runScenario({
  strokes: [stroke(200, 300), stroke(600, 500)],
  select: async (page) => {
    await page.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button').first().click();
    await page.waitForTimeout(150);
    await drawStroke(page, [[560, 460], [640, 520], [740, 580]]); // only the second stroke
    await page.waitForTimeout(300);
  },
  act: async (page) => {
    await openAlignPanel(page);
    check('one selected element gets no base object, it aligns to the drawing',
      (await page.locator('.markup-draw-align-base span').first().textContent()) ===
        'Aligned to everything drawn');
    check('with one element selected nothing is outlined as the base',
      !await page.locator('.markup-draw-base-box').isVisible());
    await clickAction(page, 'left');
  },
});
check('a lone element moves to the left edge of everything drawn',
  Math.abs(lone.boxes[0].left - lone.boxes[1].left) < 0.5,
  lone.boxes.map((b) => b.left.toFixed(1)).join(' '));

// --- spacing out
const spaced = await runScenario({
  strokes: [stroke(200, 300), stroke(300, 300), stroke(700, 300)],
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'distributeX');
  },
});
const byLeft = sorted(spaced.boxes, 'left');
check('spacing out horizontally leaves equal gaps',
  Math.abs((byLeft[1].left - byLeft[0].right) - (byLeft[2].left - byLeft[1].right)) < 0.5,
  byLeft.map((b) => b.left.toFixed(1)).join(' '));
check('spacing out keeps the outermost two where they were',
  Math.abs(byLeft[0].left - 198) < 1 && Math.abs(byLeft[2].right - 762) < 1,
  `${byLeft[0].left.toFixed(1)} .. ${byLeft[2].right.toFixed(1)}`);

const spacedY = await runScenario({
  strokes: [stroke(200, 200), stroke(200, 300), stroke(200, 700)],
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'distributeY');
  },
});
const byTop = sorted(spacedY.boxes, 'top');
check('spacing out vertically leaves equal gaps',
  Math.abs((byTop[1].top - byTop[0].bottom) - (byTop[2].top - byTop[1].bottom)) < 0.5);

// --- matching sizes
const widths = [stroke(200, 300, 60), stroke(200, 400, 140), stroke(200, 500, 30)];
const matched = await runScenario({
  strokes: widths,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'matchWidth');
  },
});
check('match width scales every element to the base object',
  spread(matched.boxes.map((b) => b.width)) < 0.5,
  matched.boxes.map((b) => b.width.toFixed(1)).join(' '));
// The shapes keep their height; their ink does not, because js-draw scales a
// stroke's width along with it -- which is why the pen width is taken back out
// here, and why the README says so.
check('match width leaves the shapes as tall as they were',
  spread(matched.boxes.map((box) => box.height - box.pen)) < 0.5,
  matched.boxes.map((box) => (box.height - box.pen).toFixed(1)).join(' '));
// scaling happens about each element's own centre, so nothing wanders off
check('match width does not move the elements it scales',
  sorted(matched.boxes, 'top').every((box, i) => {
    const [[x], [xEnd]] = widths[i];
    return Math.abs(box.left + box.width / 2 - (x + (xEnd - x) / 2)) < 0.5;
  }),
  sorted(matched.boxes, 'top').map((box) => (box.left + box.width / 2).toFixed(1)).join(' '));

const matchedBoth = await runScenario({
  strokes: [stroke(200, 300, 60, 40), stroke(200, 400, 140, 90), stroke(200, 600, 30, 20)],
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'matchSize');
  },
});
check('match size scales both axes',
  spread(matchedBoth.boxes.map((b) => b.width)) < 0.5 &&
  spread(matchedBoth.boxes.map((b) => b.height)) < 0.5);

// --- snapping to the grid.  The grid's size follows the zoom level, so rather
// than assume one, check the property that makes it a grid: snapping again
// changes nothing, while the first snap did.
const snappedOnce = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'snapToGrid');
  },
});
const snappedTwice = await runScenario({
  strokes: three,
  act: async (page) => {
    await openAlignPanel(page);
    await clickAction(page, 'snapToGrid');
    await clickAction(page, 'snapToGrid');
  },
});
check('snapping to the grid moves the elements',
  snappedOnce.boxes.some((box, i) => Math.abs(box.left - three[i][0][0] + 2) > 0.5),
  snappedOnce.boxes.map((b) => b.left.toFixed(1)).join(' '));
check('snapping an already snapped drawing changes nothing',
  snappedOnce.boxes.every((box, i) => Math.abs(box.left - snappedTwice.boxes[i].left) < 0.01 &&
    Math.abs(box.top - snappedTwice.boxes[i].top) < 0.01),
  snappedTwice.boxes.map((b) => b.left.toFixed(1)).join(' '));

// --- guides while dragging
//
// Two identical Ls, the second dragged towards the first. Where it ends up is
// read out of the saved SVG, so what is checked is where the element really
// landed and not what the guides claimed.

const GUIDE_A = 300; // both strokes' path x, before anything is dragged
const GUIDE_B = 600;

async function dragScenario({shift = 0, shiftY = 0, hold, grabHandle = false, width = 60}) {
  await page.locator('textarea.markdown-text-editor').evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.setSelectionRange(0, 0);
  });
  await openBoard(page);
  await drawStroke(page, stroke(GUIDE_A, 300));
  await drawStroke(page, stroke(GUIDE_B, 500, width));

  // select the second one only
  await page.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button').first().click();
  await page.waitForTimeout(150);
  await drawStroke(page, [[GUIDE_B - 30, 460], [GUIDE_B + width, 520], [GUIDE_B + width + 60, 580]]);
  await page.waitForTimeout(300);

  let from = [GUIDE_B + width / 2, 520];
  if (grabHandle) {
    // the corner handle rather than the selection itself: a resize, not a move
    const rect = await page.locator('.selection-tool-resize-xy').boundingBox();
    from = [rect.x + rect.width / 2, rect.y + rect.height / 2];
  }
  if (hold) await page.keyboard.down(hold);
  await page.mouse.move(...from);
  await page.mouse.down();
  for (const step of [0.2, 0.5, 0.8, 1]) {
    await page.mouse.move(from[0] + shift * step, from[1] + shiftY * step);
  }
  await page.waitForTimeout(200);
  const guides = await page.locator('.markup-draw-guide').count();
  await page.mouse.up();
  await page.waitForTimeout(300);
  const guidesAfter = await page.locator('.markup-draw-guide').count();
  if (hold) await page.keyboard.up(hold);

  await saveBoard(page);
  return {guides, guidesAfter, boxes: await boxesFromEditor(page)};
}

// dropped 5px short of the first stroke's left edge: within reach
const snapped = await dragScenario({shift: GUIDE_A - GUIDE_B + 5});
check('a drag that comes close snaps onto the other element',
  Math.abs(snapped.boxes[0].left - snapped.boxes[1].left) < 0.01,
  snapped.boxes.map((box) => box.left.toFixed(2)).join(' '));
check('guides are drawn while dragging', snapped.guides > 0, `${snapped.guides} guides`);
check('guides go away once the drag ends', snapped.guidesAfter === 0);

// the same going up: guides come from both axes
const snappedY = await dragScenario({shiftY: 300 - 500 + 5});
check('a drag snaps vertically too',
  Math.abs(snappedY.boxes[0].top - snappedY.boxes[1].top) < 0.01,
  snappedY.boxes.map((box) => box.top.toFixed(2)).join(' '));

// a wider element brought up to the first one's centre line: what snaps here is
// the centre, which no edge-only snapping would find
const centred = await dragScenario({width: 140, shift: -335});
check('centres snap, not just edges',
  Math.abs((centred.boxes[0].left + centred.boxes[0].width / 2) -
    (centred.boxes[1].left + centred.boxes[1].width / 2)) < 0.01 &&
  Math.abs(centred.boxes[0].left - centred.boxes[1].left) > 20,
  centred.boxes.map((box) => (box.left + box.width / 2).toFixed(2)).join(' '));

// 40px short: further than the 8px the snap reaches
const missed = await dragScenario({shift: GUIDE_A - GUIDE_B + 40});
check('a drag that stays clear is left alone',
  Math.abs(missed.boxes[1].left - missed.boxes[0].left - 40) < 1,
  missed.boxes.map((box) => box.left.toFixed(1)).join(' '));
check('no guides when nothing is within reach', missed.guides === 0);

// Ctrl is js-draw's own "snap to grid, press and hold", so this stands down
const withCtrl = await dragScenario({shift: GUIDE_A - GUIDE_B + 5, hold: 'Control'});
check('holding Ctrl hands over to js-draw\'s grid snapping', withCtrl.guides === 0);

// a resize handle is not a move: the transform is not a translation, and has to
// reach js-draw unchanged
const resized = await dragScenario({shift: -30, grabHandle: true});
check('resizing draws no guides', resized.guides === 0);
check('resizing still works', resized.boxes[1].width < resized.boxes[0].width - 10,
  resized.boxes.map((box) => box.width.toFixed(1)).join(' '));

// --- and it can be turned off without losing the menu
{
  const plain = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await plain.addInitScript(() => {
    window.__cfgOverride = {snapDistance: 0};
  });
  await plain.goto(BASE);
  await openBoard(plain);
  await drawStroke(plain, stroke(GUIDE_A, 300));
  await drawStroke(plain, stroke(GUIDE_B, 500));
  await plain.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button').first().click();
  await plain.waitForTimeout(150);
  await drawStroke(plain, [[570, 470], [620, 520], [700, 570]]);
  await plain.waitForTimeout(300);
  await plain.mouse.move(GUIDE_B + 30, 520);
  await plain.mouse.down();
  for (const step of [0.5, 1]) await plain.mouse.move(GUIDE_B + 30 + (GUIDE_A - GUIDE_B + 5) * step, 520);
  await plain.waitForTimeout(200);
  check('snapDistance 0 turns the guides off',
    await plain.locator('.markup-draw-guide').count() === 0);
  await plain.mouse.up();
  await plain.waitForTimeout(200);
  check('the menu is still there with the guides turned off',
    await plain.locator('.selection-tool-selection-menu button').count() === 1);
  await plain.close();
}

// --- nothing selected: js-draw offers "Paste" there and alignment has no meaning
await page.locator('textarea.markdown-text-editor').evaluate((el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.setSelectionRange(0, 0);
});
await openBoard(page);
await page.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button').first().click();
await page.waitForTimeout(150);
await page.mouse.click(700, 500, {button: 'right'});
await page.waitForTimeout(500);
check('the menu with nothing selected offers no alignment',
  await page.locator('dialog.editor-popup-menu').count() === 1 &&
  await page.locator('.markup-draw-align-entry').count() === 0);

check('giteaDrawDebug() reports the menu hook',
  (await page.evaluate(() => window.giteaDrawDebug())).alignmentHooked === true);

await browser.close();
finish();
