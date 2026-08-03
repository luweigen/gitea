// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Drawing with a finger. Uses raw CDP touch events rather than Playwright's
// mouse, so nothing here can pass by accident on a pointer the phone does not
// have.

import {BASE, createChecks, launchBrowser, screenshot, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('mobile');
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: {width: 390, height: 844},
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = watchPage(await context.newPage());
await page.goto(BASE);

await page.locator('.markup-draw-button').tap();
await page.locator('.markup-draw-overlay .imageEditorContainer').waitFor({timeout: 30000});
check('board opens from a tap (no mouse involved)', true);
check('narrow screen gets js-draw edge toolbar (touch friendly)',
  await page.locator('.markup-draw-overlay .toolbar-edge-toolbar').count() > 0);
check('page scrolling is locked behind the overlay',
  await page.evaluate(() => document.body.classList.contains('markup-draw-open')));

// --- finger drawing
const box = await page.locator('.markup-draw-overlay canvas').first().boundingBox();
const cdp = await context.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type,
  touchPoints: type === 'touchEnd' ? [] : [{x, y, radiusX: 12, radiusY: 12, force: 0.7}],
});
const x0 = box.x + 60, y0 = box.y + box.height / 2;
await touch('touchStart', x0, y0);
for (let i = 1; i <= 14; i++) await touch('touchMove', x0 + i * 15, y0 + Math.sin(i / 2) * 45);
await touch('touchEnd', 0, 0);
await page.waitForTimeout(300);

await page.locator('.markup-draw-overlay .toolwidget-tag--save .toolbar-button').first().tap();
await page.locator('.markup-draw-overlay').waitFor({state: 'detached', timeout: 15000});

const value = await page.locator('textarea.markdown-text-editor').inputValue();
check('finger stroke was captured and saved',
  /^```js-draw\n<svg[\s\S]*<path[\s\S]*<\/svg>\n```/m.test(value), `${value.length} chars`);
check('page scrolling restored after closing',
  await page.evaluate(() => !document.body.classList.contains('markup-draw-open')));

// --- aligning with a finger: the selection's "…" button is there on touch too,
// so the panel has to be reachable without a mouse
await page.locator('textarea.markdown-text-editor').evaluate((el) => {
  el.value = '';
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.setSelectionRange(0, 0);
});
await page.locator('.markup-draw-button').tap();
await page.locator('.markup-draw-overlay .imageEditorContainer').waitFor({timeout: 30000});
await page.waitForTimeout(600);

const swipe = async (points) => {
  await touch('touchStart', ...points[0]);
  for (const point of points.slice(1)) await touch('touchMove', ...point);
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(200);
};
const top = box.y + 120;
await swipe([[box.x + 40, top], [box.x + 90, top], [box.x + 90, top + 40]]);
await swipe([[box.x + 200, top + 120], [box.x + 250, top + 120], [box.x + 250, top + 160]]);

await page.locator('.toolbar-internalWidgetId--selection-tool-widget .toolbar-button').first().tap();
await page.waitForTimeout(300);
await swipe([[box.x + 20, top - 40], [box.x + 150, top + 80], [box.x + 300, top + 200]]);
await page.waitForTimeout(300);
check('the selection menu button is reachable by finger',
  await page.locator('.selection-tool-selection-menu button').count() === 1);

await page.locator('.selection-tool-selection-menu button').first().tap();
await page.locator('dialog.editor-popup-menu .content').waitFor({timeout: 5000});
check('the align entry is in the touch menu too',
  await page.locator('.markup-draw-align-entry').count() === 1);
await page.locator('.markup-draw-align-entry').tap();
await page.locator('.markup-draw-align-grid').waitFor({timeout: 5000});
await screenshot(page, 'mobile-align-panel');
check('the panel fits the phone screen',
  await page.locator('.markup-draw-align-panel').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && rect.width >= 120;
  }));

await page.locator('.markup-draw-align-grid button').first().tap(); // align left
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.locator('.markup-draw-overlay .toolwidget-tag--save .toolbar-button').first().tap();
await page.locator('.markup-draw-overlay').waitFor({state: 'detached', timeout: 15000});

const alignedLefts = await page.evaluate((svgText) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;visibility:hidden';
  host.innerHTML = svgText;
  document.body.append(host);
  const lefts = [...host.querySelectorAll('svg > path:not(.js-draw-image-background)')]
    .map((el) => el.getBBox().x);
  host.remove();
  return lefts;
}, (await page.locator('textarea.markdown-text-editor').inputValue())
  .replace(/^```js-draw\n/, '').replace(/\n```[\s\S]*$/, ''));
check('a finger-driven alignment lines the strokes up',
  alignedLefts.length === 2 && Math.abs(alignedLefts[0] - alignedLefts[1]) < 0.5,
  alignedLefts.map((x) => x.toFixed(1)).join(' '));

// --- and the result has to fit a phone screen
await page.evaluate((svg) => window.renderFence('standalone', svg),
  value.replace(/^```js-draw\n/, '').replace(/\n```[\s\S]*$/, ''));
const img = page.locator('#standalone img.markup-draw-image');
await img.waitFor({timeout: 10000});
check('renders on mobile without overflowing the viewport',
  await img.evaluate((el) => el.getBoundingClientRect().width <= document.documentElement.clientWidth));
await screenshot(page, 'mobile-rendered', {fullPage: true});

await browser.close();
finish();
