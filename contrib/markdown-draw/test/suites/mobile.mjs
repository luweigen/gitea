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
