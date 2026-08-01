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
    // file extensions the repository file editor offers the button for,
    // keep in sync with [markdown] FILE_EXTENSIONS
    markdownExtensions: ['.md', '.markdown', '.mdown', '.mkd', '.livemd'],
    ...(window.giteaDrawConfig ?? {}),
  };

  const TICKS = '```';
  const CODE_SELECTOR = `.markup code.language-${cfg.lang}`;
  const ATTR_RENDERED = 'data-markup-draw-rendered';
  const ATTR_BUTTON = 'data-markup-draw-button';
  const TOOLBAR_STATE_KEY = 'gitea-draw-toolbar-state';

  const i18n = {
    insert: 'Insert drawing',
    edit: 'Edit drawing',
    loading: 'Loading the drawing board…',
    invalidSvg: 'Not a valid SVG drawing',
    noEditor: 'The code editor is not ready yet, please try again',
  };

  // octicon-pencil, inlined so that no extra request is needed
  const PENCIL_PATH = 'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z';

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // matches a whole ```js-draw fenced block; group 1 is the SVG payload.
  // CRLF is tolerated because repository files often use it.
  const fenceRegExp = () => new RegExp(
    `^${TICKS}${escapeRegExp(cfg.lang)}[^\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n${TICKS}[ \\t]*$`,
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

  // ---------------------------------------------------------------- text sources
  //
  // Gitea has two unrelated markdown editors and a drawing has to be written
  // back into whichever one is on the page:
  //
  //   * issues, comments, wiki, releases: a plain <textarea> in .combo-markdown-editor
  //   * the repository file editor: Monaco, whose instances Gitea publishes
  //     through window.codeEditors ("export editor for customization")
  //
  // Both are wrapped into the same tiny interface.

  function textareaSource(textarea) {
    return {
      root: textarea.closest('.combo-markdown-editor') ?? textarea.form ?? textarea.parentElement,
      getValue: () => textarea.value,
      getCursorOffset: () => textarea.selectionStart,
      replaceRange(start, end, text) {
        textarea.focus();
        textarea.setSelectionRange(start, end);
        let inserted = false;
        try {
          // keeps the browser's native undo stack intact
          inserted = document.execCommand('insertText', false, text);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          textarea.setRangeText(text, start, end, 'end');
        }
        // let Gitea's autosize / draft saving / preview refresh notice the change
        textarea.dispatchEvent(new Event('input', {bubbles: true}));
      },
    };
  }

  function monacoSource(editor, root) {
    const model = editor.getModel();
    return {
      root,
      getValue: () => model.getValue(),
      getCursorOffset: () => {
        const position = editor.getPosition();
        return position ? model.getOffsetAt(position) : 0;
      },
      replaceRange(start, end, text) {
        const from = model.getPositionAt(start);
        const to = model.getPositionAt(end);
        editor.executeEdits('markdown-draw', [{
          range: {
            startLineNumber: from.lineNumber, startColumn: from.column,
            endLineNumber: to.lineNumber, endColumn: to.column,
          },
          text,
          forceMoveMarkers: true,
        }]);
        editor.focus();
      },
    };
  }

  function findMonacoEditor(elContainer) {
    for (const editor of window.codeEditors ?? []) {
      try {
        const node = editor.getContainerDomNode?.();
        if (node && elContainer.contains(node) && editor.getModel?.()) return editor;
      } catch {
        // a disposed editor may throw, just skip it
      }
    }
    return null;
  }

  // Resolves the editable text behind a rendered markdown block, so that a
  // drawing shown in a preview pane can be edited in place.
  function sourceForMarkup(elMarkup) {
    const elCombo = elMarkup.closest('.combo-markdown-editor');
    if (elCombo) {
      const textarea = elCombo.querySelector('textarea.markdown-text-editor');
      return textarea ? textareaSource(textarea) : null;
    }
    const elForm = elMarkup.closest('form');
    if (elForm) {
      const editor = findMonacoEditor(elForm);
      if (editor) return monacoSource(editor, elForm);
    }
    return null;
  }

  // ---------------------------------------------------------------- fence utils

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

  function insertAtCursor(source, block) {
    const value = source.getValue();
    const pos = source.getCursorOffset();
    const before = pos === 0 || value[pos - 1] === '\n' ? '' : '\n';
    const after = pos >= value.length ? '\n' : value[pos] === '\n' ? '\n' : '\n\n';
    source.replaceRange(pos, pos, before + block + after);
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

    // Inside a markdown editor's own preview the drawing can be edited in place,
    // because the matching source fence is right there in the editor.
    const elMarkup = elPre.closest('.markup');
    if (elMarkup && sourceForMarkup(elMarkup)) {
      const elEdit = document.createElement('button');
      elEdit.type = 'button';
      elEdit.className = 'ui tiny basic button markup-draw-edit';
      elEdit.textContent = i18n.edit;
      elEdit.addEventListener('click', () => editPreviewedDrawing(elMarkup, elContainer));
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

  // "Insert drawing" / "edit the drawing under the cursor"
  function openForSource(source) {
    if (!source) return;
    const fence = findFenceAt(source.getValue(), source.getCursorOffset());
    openDrawingBoard({
      initialSvg: fence?.content ?? '',
      onSave: (svgText) => {
        const block = makeFence(svgText);
        if (fence) {
          source.replaceRange(fence.start, fence.end, block);
        } else {
          insertAtCursor(source, block);
        }
      },
    });
  }

  // "Edit drawing" on a drawing shown in a preview pane
  function editPreviewedDrawing(elMarkup, elContainer) {
    const source = sourceForMarkup(elMarkup);
    if (!source) return;
    const index = [...elMarkup.querySelectorAll('.markup-draw')].indexOf(elContainer);
    const fence = index < 0 ? null : findFenceByIndex(source.getValue(), index);
    if (!fence) return;
    openDrawingBoard({
      initialSvg: fence.content,
      onSave: (svgText) => {
        // the text may have been edited while the board was open
        const current = findFenceByIndex(source.getValue(), index);
        if (current) source.replaceRange(current.start, current.end, makeFence(svgText));
      },
    });
  }

  function makeButton(className, withLabel) {
    const elButton = document.createElement('button');
    elButton.type = 'button'; // must not submit the surrounding form
    elButton.className = className;
    elButton.setAttribute('data-tooltip-content', i18n.insert);
    elButton.setAttribute('aria-label', i18n.insert);
    elButton.append(svgIcon());
    if (withLabel) elButton.append(document.createTextNode(` ${i18n.insert}`));
    return elButton;
  }

  // issues, comments, wiki, releases: the shared markdown editor
  function initComboEditors() {
    for (const elToolbar of document.querySelectorAll('.combo-markdown-editor markdown-toolbar')) {
      if (elToolbar.hasAttribute(ATTR_BUTTON)) continue;
      elToolbar.setAttribute(ATTR_BUTTON, 'true');

      const elButton = makeButton('markdown-toolbar-button markup-draw-button', false);
      elButton.addEventListener('click', () => {
        const textarea = elToolbar.closest('.combo-markdown-editor')?.querySelector('textarea.markdown-text-editor');
        if (textarea) openForSource(textareaSource(textarea));
      });

      const elGroup = document.createElement('div');
      elGroup.className = 'markdown-toolbar-group';
      elGroup.append(elButton);
      elToolbar.append(elGroup);
    }
  }

  function editedFileName(elForm) {
    return (elForm.querySelector('#file-name')?.value ?? '').trim().toLowerCase();
  }

  function isMarkdownFileName(name) {
    return cfg.markdownExtensions.some((ext) => name.endsWith(ext.toLowerCase()));
  }

  // the repository file editor: Monaco, no markdown toolbar of its own
  function initFileEditors() {
    for (const elMenu of document.querySelectorAll('.repo-editor-menu')) {
      const elForm = elMenu.closest('form');
      // Monaco is loaded asynchronously; wait for it so the button never
      // appears before it can do anything
      if (!elForm || !elForm.querySelector('.monaco-editor-container')) continue;

      let elButton = elForm.querySelector('.markup-draw-button-file');
      if (!elButton) {
        elButton = makeButton('ui compact small button markup-draw-button-file', true);
        elButton.addEventListener('click', () => {
          const editor = findMonacoEditor(elForm);
          if (!editor) {
            window.alert(i18n.noEditor);
            return;
          }
          openForSource(monacoSource(editor, elForm));
        });
        // sit with the other editor controls when they exist (the git hook
        // editor has none), otherwise right after the write/preview tabs
        const elOptions = elForm.querySelector('.code-editor-options');
        if (elOptions) {
          elOptions.prepend(elButton);
        } else {
          elMenu.after(elButton);
        }

        const elName = elForm.querySelector('#file-name');
        elName?.addEventListener('input', () => scheduleInit());
      }

      // the file name can be changed while editing, and the fence only means
      // anything in a file rendered as markdown
      elButton.style.display = isMarkdownFileName(editedFileName(elForm)) ? '' : 'none';
    }
  }

  let scheduled = false;
  function scheduleInit() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderAllDrawings();
      initComboEditors();
      initFileEditors();
    });
  }

  function init() {
    scheduleInit();
    // Gitea swaps large parts of the page through htmx and async rendering,
    // so markup blocks, editors and Monaco itself can appear at any time
    new MutationObserver(scheduleInit).observe(document.body, {childList: true, subtree: true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once: true});
  } else {
    init();
  }
})();
