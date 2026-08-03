// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// The repository file editor, driving the real Monaco build Gitea pins.
// Its hidden #edit_area textarea is written *by* Monaco, never read from, so
// nothing here can be faked by poking the textarea.

import {BASE, createChecks, launchBrowser, screenshot, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('file-editor');
const browser = await launchBrowser();
const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
await page.goto(`${BASE}/fileeditor.html`);
await page.evaluate(() => window.__monacoReady);

const button = page.locator('.markup-draw-button-file');
await button.waitFor({timeout: 20000});
check('button appears in the file editor header once Monaco is up', await button.count() === 1);
check('button is visible for a .md file', await button.isVisible());
check('button is type=button (does not submit the edit form)',
  await button.getAttribute('type') === 'button');
check('button sits with the other editor controls',
  await button.evaluate((el) => el.closest('.code-editor-options') !== null));

// --- the button follows a rename
await page.locator('#file-name').fill('Draw.txt');
await page.waitForTimeout(400);
check('button hides when the file is no longer markdown', !await button.isVisible());
await page.locator('#file-name').fill('Draw.md');
await page.waitForTimeout(400);
check('button comes back for markdown', await button.isVisible());

const drawAndSave = async () => {
  await page.locator('.markup-draw-overlay .imageEditorContainer').waitFor({timeout: 30000});
  const box = await page.locator('.markup-draw-overlay canvas').first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 100, cy - 40);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 100 + i * 20, cy - 40 + Math.sin(i / 2) * 35);
  await page.mouse.up();
  await page.locator('.markup-draw-overlay .toolwidget-tag--save .toolbar-button').first().click();
  await page.locator('.markup-draw-overlay').waitFor({state: 'detached', timeout: 15000});
};

// --- insert at the cursor, in the middle of existing prose
await page.evaluate(() => {
  const editor = window.codeEditors[0];
  editor.setValue('# Title\n\nsome prose\n\ntail\n');
  editor.setPosition({lineNumber: 4, column: 1}); // the empty line after the prose
});
await button.click();
await drawAndSave();

const value = await page.evaluate(() => window.codeEditors[0].getValue());
check('a js-draw fence was written into the Monaco model',
  /^```js-draw\n<svg[\s\S]*<\/svg>\n```/m.test(value), `${value.length} chars`);
check('existing file content is preserved',
  value.includes('# Title') && value.includes('some prose') && value.includes('tail'));
check('the fence was inserted at the cursor, not at the end',
  value.indexOf('```js-draw') < value.indexOf('tail'));
check('the fence starts on its own line', /\n```js-draw\n/.test(value));
check('hidden #edit_area is in sync, so the commit will carry the drawing',
  await page.locator('#edit_area').inputValue() === value);
await screenshot(page, 'file-editor');

// --- one Ctrl+Z, not one per inserted line (executeEdits, not setValue)
await page.locator('.monaco-editor textarea.inputarea').press('Control+z');
await page.waitForTimeout(300);
check('Ctrl+Z undoes the insertion in one step',
  !(await page.evaluate(() => window.codeEditors[0].getValue())).includes('```js-draw'));
await page.locator('.monaco-editor textarea.inputarea').press('Control+y');
await page.waitForTimeout(300);
check('redo brings it back',
  (await page.evaluate(() => window.codeEditors[0].getValue())).includes('```js-draw'));

// --- cursor inside the fence reopens that drawing and replaces it
await page.evaluate(() => {
  const editor = window.codeEditors[0];
  const offset = editor.getValue().indexOf('```js-draw') + 20;
  editor.setPosition(editor.getModel().getPositionAt(offset));
});
await button.click();
await drawAndSave();
const after = await page.evaluate(() => window.codeEditors[0].getValue());
check('editing replaces the fence instead of appending a second one',
  (after.match(/```js-draw/g) ?? []).length === 1);
check('surrounding prose survived the replacement',
  after.includes('# Title') && after.includes('tail'));

// --- the preview pane edits in place too
await page.evaluate((svg) => window.renderFence('filepreview', svg),
  after.replace(/^[\s\S]*?```js-draw\n/, '').replace(/\n```[\s\S]*$/, ''));
await page.waitForTimeout(400);
const editButton = page.locator('#filepreview .markup-draw-edit');
check('preview pane offers "Edit drawing"', await editButton.count() === 1);
await editButton.click();
await drawAndSave();
const final = await page.evaluate(() => window.codeEditors[0].getValue());
check('editing from the preview writes back into Monaco',
  (final.match(/```js-draw/g) ?? []).length === 1 && final.includes('# Title'));

// --- repository files are often CRLF; comment textareas never are
await page.evaluate(() => {
  const editor = window.codeEditors[0];
  editor.getModel().setEOL(1); // CRLF
  editor.setPosition(editor.getModel().getPositionAt(editor.getValue().indexOf('```js-draw') + 20));
});
check('model really is CRLF now',
  (await page.evaluate(() => window.codeEditors[0].getValue())).includes('\r\n'));
await button.click();
await drawAndSave();
const crlf = await page.evaluate(() => window.codeEditors[0].getValue());
check('a CRLF file still gets its fence replaced, not duplicated',
  (crlf.match(/```js-draw/g) ?? []).length === 1, `${crlf.length} chars`);

await browser.close();
finish();
