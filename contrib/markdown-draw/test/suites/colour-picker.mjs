// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// js-draw's colour inputs are Coloris, which appends its picker to <body>
// rather than into the editor. The board is a fixed full-screen overlay, so
// the picker has to be lifted above it -- otherwise clicking a swatch dims the
// screen (that overlay is inside the board) while the picker stays hidden
// behind it. Being present is not the test; being clickable is.

import {BASE, createChecks, launchBrowser, openBoard, screenshot, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('colour-picker');

const openPicker = async (page, widgetSelector) => {
  // the dropdown toolbar keeps a tool's properties inside its own container,
  // the edge toolbar moves them into a shared sheet -- accept either
  const swatch = page.locator('.markup-draw-overlay .clr-field').locator('visible=true').first();
  const button = page.locator(widgetSelector).first().locator('.toolbar-button').first();
  for (let i = 0; i < 3 && !await swatch.count(); i++) {
    await button.click({force: true}); // first click selects the tool, a later one opens it
    await page.waitForTimeout(500);
  }
  await swatch.click({force: true});
  await page.waitForTimeout(500);
};

const pickerState = (page) => page.evaluate(() => {
  const picker = document.querySelector('#clr-picker');
  if (!picker) return {exists: false};
  const rect = picker.getBoundingClientRect();
  const reaches = (dx, dy) => {
    const el = document.elementFromPoint(rect.x + dx, rect.y + dy);
    return el ? (el === picker || picker.contains(el)) : false;
  };
  return {
    exists: true,
    zIndex: Number(getComputedStyle(picker).zIndex),
    overlayZ: Number(getComputedStyle(document.querySelector('.markup-draw-overlay')).zIndex),
    onScreen: rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
      rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    hittableCentre: reaches(rect.width / 2, rect.height / 2),
    hittableCorners: reaches(4, 4) && reaches(rect.width - 4, rect.height - 4),
  };
});

const browser = await launchBrowser();

// --- the pen's picker, and the colour it picks actually reaching the drawing
{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);

  const debug = await page.evaluate(() => window.giteaDrawDebug());
  check('gitea-draw.css is loaded and current', debug.cssRevision === '2',
    `cssRevision=${debug.cssRevision}`);

  await openBoard(page);
  await openPicker(page, '.toolbar-internalWidgetId--pen');
  const state = await pickerState(page);
  check('[pen] the colour picker opens', state.exists);
  check('[pen] it is stacked above the board', state.zIndex > state.overlayZ,
    `picker z=${state.zIndex}, board z=${state.overlayZ}`);
  check('[pen] it is fully on screen', state.onScreen);
  check('[pen] clicks reach the picker, not the dimming overlay', state.hittableCentre);
  check('[pen] its corners are reachable too', state.hittableCorners);
  await screenshot(page, 'colour-picker');

  const blue = page.locator('#clr-swatches button').nth(2); // rgb(0, 0, 255)
  check('the picker offers clickable preset swatches', await blue.isVisible());
  await blue.click();
  await page.waitForTimeout(300);
  // Coloris commits on an outside click; Escape is its cancel
  await page.locator('.toolbar-closeColorPickerOverlay').click({force: true, position: {x: 5, y: 5}});
  await page.waitForTimeout(400);
  check('closing the picker does not tear the whole board down',
    await page.locator('.markup-draw-overlay').count() === 1);

  const box = await page.locator('.markup-draw-overlay canvas').first().boundingBox();
  await page.mouse.move(box.x + 200, box.y + 250);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 200 + i * 18, box.y + 250 + i * 6);
  await page.mouse.up();
  await page.waitForTimeout(200);

  await page.locator('.markup-draw-overlay .toolwidget-tag--save .toolbar-button').first().click();
  await page.locator('.markup-draw-overlay').waitFor({state: 'detached', timeout: 15000});
  const value = await page.locator('textarea.markdown-text-editor').inputValue();
  check('the chosen colour is what actually gets drawn', /#0000ff/i.test(value),
    (value.match(/stroke="#[0-9a-f]{6}"/i) ?? ['none'])[0]);
  await page.close();
}

// --- the text tool has a colour input of its own
{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(BASE);
  await openBoard(page);
  await openPicker(page, '.toolbar-internalWidgetId--text-tool-widget');
  const state = await pickerState(page);
  check('[text] the colour picker is reachable', state.exists && state.hittableCentre,
    `z=${state.zIndex} vs ${state.overlayZ}`);
  await page.close();
}

// --- and on touch, where the edge toolbar is used instead
{
  const context = await browser.newContext({
    viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true,
  });
  const page = watchPage(await context.newPage());
  await page.goto(BASE);
  await openBoard(page, {tap: true});
  await openPicker(page, '.toolbar-internalWidgetId--pen');
  const state = await pickerState(page);
  check('[touch] the colour picker is reachable', state.exists && state.hittableCentre,
    `z=${state.zIndex} vs ${state.overlayZ}`);
  await screenshot(page, 'colour-picker-touch');
  await page.close();
}

await browser.close();
finish();
