// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// The shared markdown editor: issues, pull requests, comments, wiki, releases.
// Covers inserting a drawing, rendering one, and the round trip back.

import {BASE, createChecks, launchBrowser, openBoard, saveBoard, scribbleOnCanvas, screenshot, stripFence, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('combo-editor');
const browser = await launchBrowser();
const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await page.goto(BASE);

// --- the toolbar button
const pencil = page.locator('.markup-draw-button');
await pencil.waitFor({timeout: 10000});
check('pencil button injected into markdown-toolbar', await pencil.count() === 1);
check('pencil button is type=button (does not submit the form)',
  await pencil.getAttribute('type') === 'button');

// --- js-draw must not be paid for until a board is opened
check('js-draw not fetched before the board opens',
  await page.evaluate(() => performance.getEntriesByType('resource')
    .every((r) => !r.name.includes('js-draw/bundle.js'))));
await openBoard(page);
check('drawing board opens and js-draw loads', true);
check('js-draw fetched exactly once',
  await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((r) => r.name.includes('js-draw/bundle.js')).length === 1));

// --- draw and save
await scribbleOnCanvas(page);
await saveBoard(page);
check('board closes after save', true);

const value = await page.locator('textarea.markdown-text-editor').inputValue();
check('a js-draw fence was inserted', /^```js-draw\n<svg[\s\S]*<\/svg>\n```/m.test(value),
  `${value.length} chars`);
check('the stroke is in the saved SVG', /<path/.test(value));

// --- rendering a fence produces a safe <img> preview
await page.evaluate((svg) => window.renderFence('standalone', svg), stripFence(value));
const img = page.locator('#standalone img.markup-draw-image');
await img.waitFor({timeout: 10000});
check('drawing renders as an <img>', await img.count() === 1);
check('<img> uses a blob URL', (await img.getAttribute('src')).startsWith('blob:'));
check('intrinsic size taken from the SVG', Number(await img.getAttribute('width')) > 0);
check('source block is hidden but kept in the DOM',
  await page.locator('#standalone .code-block-container').evaluate((el) => el.style.display === 'none'));
check('<img> actually decoded (not a broken image)',
  await img.evaluate((el) => el.complete && el.naturalWidth > 0));
await screenshot(page, 'combo-editor-rendered', {fullPage: true});

// --- a hostile fence must not execute. This is the property that makes it safe
// to render user-written markdown at all, so it is checked, not assumed.
await page.evaluate(() => {
  window.renderFence('standalone',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="window.__pwned = 1">` +
    `<script>window.__pwned = 2;<\/script></svg>`);
});
await page.waitForTimeout(700);
check('script/onload inside a fenced SVG does not run',
  await page.evaluate(() => window.__pwned === undefined));
check('hostile drawing still renders as an image',
  await page.locator('#standalone img.markup-draw-image').count() === 2);

// --- garbage in a fence must be reported, not thrown
await page.evaluate(() => window.renderFence('standalone', 'not an svg at all'));
await page.waitForTimeout(300);
check('invalid payload shows a block error',
  await page.locator('#standalone .markup-block-error').count() === 1);

// --- cursor inside a fence reopens that drawing and replaces it
await page.locator('textarea.markdown-text-editor').evaluate((el) => {
  el.focus();
  el.setSelectionRange(20, 20);
});
await openBoard(page);
check('board reopens with the existing drawing',
  await page.locator('.markup-draw-overlay canvas').count() > 0);
await saveBoard(page);
const after = await page.locator('textarea.markdown-text-editor').inputValue();
check('editing replaces the fence instead of appending a new one',
  (after.match(/```js-draw/g) ?? []).length === 1);
check('re-saved drawing kept its content', /<path/.test(after));

// --- the editor's own preview offers in-place editing
await page.evaluate((svg) => window.renderFence('preview', svg), stripFence(after));
await page.waitForTimeout(300);
check('preview inside the editor gets an "Edit drawing" button',
  await page.locator('#preview .markup-draw-edit').count() === 1);

await browser.close();
finish();
