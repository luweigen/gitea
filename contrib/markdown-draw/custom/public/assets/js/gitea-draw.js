// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Freehand drawing for Gitea markdown, powered by js-draw (https://github.com/personalizedrefrigerator/js-draw).
//
// This is a drop-in customization: it lives in Gitea's CUSTOM_PATH and needs no
// change to Gitea's source and no rebuild.  See contrib/markdown-draw/README.md.
//
// A drawing is stored inline in the markdown source as a fenced code block:
//
//     ```js-draw
//     <svg ...>...</svg>
//     ```
//
// so it is versioned, diffable and travels with the markdown text itself.

(() => {
  'use strict';

  const cfg = {
    // fence info string used to mark a drawing
    lang: 'js-draw',
    // where install.sh put js-draw's "bundle.js" / "bundledStyles.js"
    assetsPrefix: '/assets/js-draw',
    // refuse to render sources larger than this (mirrors MERMAID_MAX_SOURCE_CHARACTERS)
    maxSourceChars: 512 * 1024,
    // width below which js-draw's touch-friendly "edge" toolbar is used
    edgeToolbarMaxWidth: 800,
    ...(window.giteaDrawConfig ?? {}),
  };

  const TICKS = '```';
  const CODE_SELECTOR = `.markup code.language-${cfg.lang}`;
  const ATTR_RENDERED = 'data-markup-draw-rendered';
  const ATTR_TOOLBAR = 'data-markup-draw-toolbar';
  const TOOLBAR_STATE_KEY = 'gitea-draw-toolbar-state';

  const i18n = {
    insert: 'Insert drawing',
    edit: 'Edit drawing',
    loading: 'Loading the drawing board…',
    invalidSvg: 'Not a valid SVG drawing',
  };

  // octicon-pencil, inlined so that no extra request is needed
  const PENCIL_PATH = 'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z';

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // matches a whole ```js-draw fenced block; group 1 is the SVG payload
  const fenceRegExp = () => new RegExp(
    `^${TICKS}${escapeRegExp(cfg.lang)}[^\\n]*\\n([\\s\\S]*?)\\n${TICKS}[ \\t]*$`,
    'gm',
  );

  const makeFence = (svgText) => `${TICKS}${cfg.lang}\n${svgText}\n${TICKS}`;

  function svgIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', PENCIL_PATH);
    svg.append(path);
    return svg;
  }

  // ---------------------------------------------------------------- js-draw loading

  let jsDrawPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.addEventListener('load', () => resolve(), {once: true});
      el.addEventListener('error', () => reject(new Error(`failed to load ${src}`)), {once: true});
      document.head.append(el);
    });
  }

  // js-draw is only fetched when a drawing board is actually opened, so pages
  // that merely display drawings stay as light as they were.
  function loadJsDraw() {
    jsDrawPromise ??= (async () => {
      await loadScript(`${cfg.assetsPrefix}/bundledStyles.js`); // self-injects a <style>
      await loadScript(`${cfg.assetsPrefix}/bundle.js`); // defines window.jsdraw
      if (!window.jsdraw?.Editor) throw new Error('js-draw did not register itself, check assetsPrefix');
      return window.jsdraw;
    })();
    return jsDrawPromise;
  }

  // ---------------------------------------------------------------- rendering

  // Parses the SVG only to read its intrinsic size.  DOMParser neither runs
  // scripts nor fetches subresources, and the parsed nodes never reach the live
  // document -- the drawing itself is displayed through an <img>, see below.
  function parseSvgSize(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.querySelector('parsererror') || doc.documentElement.nodeName.toLowerCase() !== 'svg') {
      throw new Error(i18n.invalidSvg);
    }
    const root = doc.documentElement;
    const positive = (value) => {
      const n = Number.parseFloat(value ?? '');
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    let width = positive(root.getAttribute('width'));
    let height = positive(root.getAttribute('height'));
    if (!width || !height) {
      const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
      if (box.length === 4 && Number.isFinite(box[2]) && Number.isFinite(box[3])) {
        width = box[2];
        height = box[3];
      }
    }
    return {width: Math.round(width), height: Math.round(height)};
  }

  function showBlockError(elBlock, err) {
    elBlock.classList.remove('is-loading');
    const elError = document.createElement('pre');
    elError.className = 'ui message error markup-block-error';
    elError.textContent = err.message || String(err);
    elBlock.before(elError);
  }

  function renderDrawing(elPre, source) {
    const svgText = source.trim();
    if (svgText.length > cfg.maxSourceChars) {
      throw new Error(`drawing source of ${svgText.length} characters exceeds the maximum allowed length of ${cfg.maxSourceChars}`);
    }
    const {width, height} = parseSvgSize(svgText);

    const elContainer = document.createElement('div');
    elContainer.className = 'markup-draw';

    // The payload comes from markdown written by other users, so it must never be
    // inserted into this document as live SVG.  An <img> is the safe primitive:
    // browsers refuse to run scripts or load external references inside an SVG
    // referenced that way, so a hostile drawing can only paint pixels.
    const elImg = document.createElement('img');
    elImg.className = 'markup-draw-image';
    elImg.alt = 'drawing';
    elImg.decoding = 'async';
    elImg.loading = 'lazy';
    if (width && height) {
      elImg.width = width;
      elImg.height = height;
    }
    const blobUrl = URL.createObjectURL(new Blob([svgText], {type: 'image/svg+xml'}));
    const revoke = () => URL.revokeObjectURL(blobUrl);
    elImg.addEventListener('load', revoke, {once: true});
    elImg.addEventListener('error', revoke, {once: true});
    elImg.src = blobUrl;
    elContainer.append(elImg);

    // Inside the markdown editor's own preview pane the drawing can be edited in
    // place, because the matching source fence is right there in the textarea.
    const elCombo = elPre.closest('.combo-markdown-editor');
    if (elCombo) {
      const elEdit = document.createElement('button');
      elEdit.type = 'button';
      elEdit.className = 'ui tiny basic button markup-draw-edit';
      elEdit.textContent = i18n.edit;
      elEdit.addEventListener('click', () => editPreviewedDrawing(elCombo, elContainer));
      const elActions = document.createElement('div');
      elActions.className = 'markup-draw-actions';
      elActions.append(elEdit);
      elContainer.append(elActions);
    }

    const elBlock = elPre.closest('.code-block-container') ?? elPre;
    elBlock.classList.remove('is-loading');
    elBlock.style.display = 'none'; // keep the source around, it is the model
    elBlock.after(elContainer);
  }

  function renderAllDrawings() {
    for (const elCode of document.querySelectorAll(CODE_SELECTOR)) {
      const elPre = elCode.closest('pre');
      if (!elPre || elPre.hasAttribute(ATTR_RENDERED)) continue;
      elPre.setAttribute(ATTR_RENDERED, 'true');
      try {
        renderDrawing(elPre, elCode.textContent ?? '');
      } catch (err) {
        showBlockError(elPre.closest('.code-block-container') ?? elPre, err);
      }
    }
  }

  // ---------------------------------------------------------------- textarea plumbing

  function findFenceAt(text, pos) {
    for (const match of text.matchAll(fenceRegExp())) {
      const start = match.index;
      const end = start + match[0].length;
      if (pos >= start && pos <= end) return {start, end, content: match[1]};
    }
    return null;
  }

  function findFenceByIndex(text, index) {
    const match = [...text.matchAll(fenceRegExp())][index];
    if (!match) return null;
    return {start: match.index, end: match.index + match[0].length, content: match[1]};
  }

  function replaceRange(textarea, start, end, replacement) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    let inserted = false;
    try {
      // keeps the browser's native undo stack intact
      inserted = document.execCommand('insertText', false, replacement);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      textarea.setRangeText(replacement, start, end, 'end');
    }
    // let Gitea's autosize / draft saving / preview refresh notice the change
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
  }

  function insertAtCursor(textarea, block) {
    const {selectionStart: start, selectionEnd: end, value} = textarea;
    const before = start === 0 || value[start - 1] === '\n' ? '' : '\n';
    const after = end >= value.length ? '\n' : value[end] === '\n' ? '\n' : '\n\n';
    replaceRange(textarea, start, end, before + block + after);
  }

  // ---------------------------------------------------------------- the drawing board

  function restoreToolbarState(toolbar) {
    try {
      const state = window.localStorage.getItem(TOOLBAR_STATE_KEY);
      if (state) toolbar.deserializeState(state);
    } catch {
      // a corrupted or unavailable state must never block drawing
    }
  }

  function saveToolbarState(toolbar) {
    try {
      window.localStorage.setItem(TOOLBAR_STATE_KEY, toolbar.serializeState());
    } catch {
      // ignore, e.g. private mode with storage disabled
    }
  }

  async function openDrawingBoard({initialSvg, onSave}) {
    const elOverlay = document.createElement('div');
    elOverlay.className = 'markup-draw-overlay';
    const elHost = document.createElement('div');
    elHost.className = 'markup-draw-host';
    elHost.textContent = i18n.loading;
    elOverlay.append(elHost);
    document.body.append(elOverlay);
    document.body.classList.add('markup-draw-open');

    let editor = null;
    let toolbar = null;
    const close = () => {
      if (toolbar) saveToolbarState(toolbar);
      editor?.remove();
      elOverlay.remove();
      document.body.classList.remove('markup-draw-open');
    };
    // bubble phase, so that js-draw's own dialogs can swallow Escape first
    elOverlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    let jsdraw;
    try {
      jsdraw = await loadJsDraw();
    } catch (err) {
      elHost.textContent = String(err.message || err);
      return;
    }

    elHost.textContent = '';
    editor = new jsdraw.Editor(elHost, {
      wheelEventsEnabled: 'only-if-focused',
      appInfo: {name: 'Gitea', description: 'markdown drawing'},
    });

    // js-draw's edge toolbar is the one built for thumbs, so use it on narrow
    // screens and on any touch-first device regardless of its width
    const useEdgeToolbar = window.matchMedia(
      `(max-width: ${cfg.edgeToolbarMaxWidth}px), (pointer: coarse)`,
    ).matches;
    toolbar = useEdgeToolbar ? jsdraw.makeEdgeToolbar(editor) : jsdraw.makeDropdownToolbar(editor);
    toolbar.addDefaults();
    restoreToolbarState(toolbar);
    toolbar.addExitButton(() => close());
    toolbar.addSaveButton(async () => {
      const svgElem = await editor.toSVGAsync();
      onSave(new XMLSerializer().serializeToString(svgElem));
      close();
    });

    if (initialSvg.trim()) {
      // sanitize=true: the SVG was written by whoever wrote the markdown
      await editor.loadFromSVG(initialSvg, true);
    } else {
      // an opaque background keeps dark ink visible whatever theme the reader uses
      editor.dispatch(editor.setBackgroundStyle({
        color: jsdraw.Color4.white,
        type: jsdraw.BackgroundComponentBackgroundType.SolidColor,
        autoresize: true,
      }), false);
    }
    editor.focus();
  }

  // ---------------------------------------------------------------- entry points

  function editPreviewedDrawing(elCombo, elContainer) {
    const textarea = elCombo.querySelector('textarea.markdown-text-editor');
    if (!textarea) return;
    const drawings = [...elCombo.querySelectorAll('.markup-draw')];
    const index = drawings.indexOf(elContainer);
    const fence = index < 0 ? null : findFenceByIndex(textarea.value, index);
    if (!fence) return;
    openDrawingBoard({
      initialSvg: fence.content,
      onSave: (svgText) => {
        // the textarea may have been edited while the board was open
        const current = findFenceByIndex(textarea.value, index);
        if (current) replaceRange(textarea, current.start, current.end, makeFence(svgText));
      },
    });
  }

  function onToolbarButtonClick(elCombo) {
    const textarea = elCombo?.querySelector('textarea.markdown-text-editor');
    if (!textarea) return;
    const fence = findFenceAt(textarea.value, textarea.selectionStart);
    openDrawingBoard({
      initialSvg: fence?.content ?? '',
      onSave: (svgText) => {
        const block = makeFence(svgText);
        if (fence) {
          replaceRange(textarea, fence.start, fence.end, block);
        } else {
          insertAtCursor(textarea, block);
        }
      },
    });
  }

  function initEditorToolbars() {
    for (const elToolbar of document.querySelectorAll('.combo-markdown-editor markdown-toolbar')) {
      if (elToolbar.hasAttribute(ATTR_TOOLBAR)) continue;
      elToolbar.setAttribute(ATTR_TOOLBAR, 'true');

      const elButton = document.createElement('button');
      elButton.type = 'button'; // must not submit the surrounding form
      elButton.className = 'markdown-toolbar-button markup-draw-button';
      elButton.setAttribute('data-tooltip-content', i18n.insert);
      elButton.setAttribute('aria-label', i18n.insert);
      elButton.append(svgIcon());
      elButton.addEventListener('click', () => onToolbarButtonClick(elToolbar.closest('.combo-markdown-editor')));

      const elGroup = document.createElement('div');
      elGroup.className = 'markdown-toolbar-group';
      elGroup.append(elButton);
      elToolbar.append(elGroup);
    }
  }

  let scheduled = false;
  function scheduleInit() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderAllDrawings();
      initEditorToolbars();
    });
  }

  function init() {
    scheduleInit();
    // Gitea swaps large parts of the page through htmx and async rendering,
    // so both markup blocks and editors can appear at any time
    new MutationObserver(scheduleInit).observe(document.body, {childList: true, subtree: true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once: true});
  } else {
    init();
  }
})();
