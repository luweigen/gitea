// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Gitea's file editor markup has changed shape across versions. The button
// must land somewhere usable in each of them, and still write into Monaco --
// existing is not the same as working, so both are checked every time.

import {BASE, createChecks, launchBrowser, screenshot, watchPage} from '../lib.mjs';

const {check, finish} = createChecks('file-editor-layouts');

const VARIANTS = [
  {
    page: 'fileeditor.html',
    label: 'current layout (tab menu + editor controls)',
    anchor: '.code-editor-options',
  },
  {
    page: 'fileeditor-old.html',
    label: 'older layout (plain tabular menu only)',
    anchor: null,
  },
  {
    page: 'fileeditor-bare.html',
    label: 'bare layout (no header, file name only in tree_path)',
    anchor: null,
  },
];

const browser = await launchBrowser();

for (const variant of VARIANTS) {
  console.log(`  --- ${variant.label}`);
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(`${BASE}/${variant.page}`);
  await page.evaluate(() => window.__monacoReady);

  const button = page.locator('.markup-draw-button-file');
  try {
    await button.waitFor({timeout: 20000});
  } catch {
    check(`[${variant.page}] button appears`, false, 'never showed up');
    await page.close();
    continue;
  }
  check(`[${variant.page}] button appears`, true);
  check(`[${variant.page}] button is visible`, await button.isVisible());
  check(`[${variant.page}] button is inside the edit form`,
    await button.evaluate((el) => el.closest('form') !== null));
  check(`[${variant.page}] button does not overlap the editor`,
    await button.evaluate((el) => {
      const editor = el.closest('form').querySelector('.monaco-editor-container');
      const b = el.getBoundingClientRect(), e = editor.getBoundingClientRect();
      return b.bottom <= e.top + 1 || b.right <= e.left + 1 || b.left >= e.right - 1;
    }));
  if (variant.anchor) {
    check(`[${variant.page}] button used the ${variant.anchor} anchor`,
      await button.evaluate((el, sel) => el.closest(sel) !== null, variant.anchor));
  }

  // existing is not enough: it has to actually insert
  await page.evaluate(() => {
    window.codeEditors[0].setValue('# Title\n\ntail\n');
    window.codeEditors[0].setPosition({lineNumber: 3, column: 1});
  });
  await button.click();
  await page.locator('.markup-draw-overlay .imageEditorContainer').waitFor({timeout: 30000});
  const box = await page.locator('.markup-draw-overlay canvas').first().boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 200 + i * 18, box.y + 200 + i * 9);
  await page.mouse.up();
  await page.locator('.markup-draw-overlay .toolwidget-tag--save .toolbar-button').first().click();
  await page.locator('.markup-draw-overlay').waitFor({state: 'detached', timeout: 15000});

  const value = await page.evaluate(() => window.codeEditors[0].getValue());
  check(`[${variant.page}] drawing written into Monaco`,
    /```js-draw\n<svg[\s\S]*<\/svg>\n```/.test(value) && value.includes('# Title'),
    `${value.length} chars`);

  const debug = await page.evaluate(() => window.giteaDrawDebug());
  check(`[${variant.page}] giteaDrawDebug() reports the editor`,
    debug.codeEditors === 1 && debug.ourButtons === 1);
  await screenshot(page, `layout-${variant.page.replace('.html', '')}`);
  await page.close();
}

// --- a non-markdown file must not get the button, in any layout
{
  const page = watchPage(await browser.newPage({viewport: {width: 1280, height: 900}}));
  await page.goto(`${BASE}/fileeditor.html`);
  await page.evaluate(() => window.__monacoReady);
  await page.locator('#file-name').fill('hook.sh');
  await page.waitForTimeout(400);
  check('[non-markdown] button hidden for hook.sh',
    !await page.locator('.markup-draw-button-file').isVisible());
  await page.close();
}

await browser.close();
finish();
