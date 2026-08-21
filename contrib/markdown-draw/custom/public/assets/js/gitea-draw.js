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
//
// The customization is four files, loaded in this order (see header.tmpl):
//
//   gitea-draw.js            this one: the buttons, the drawing board, and
//                            everything the other three are built on
//   gitea-draw-history.js    recording what Ctrl+Z can take back into the
//                            drawing, and reading it back
//   gitea-draw-playback.js   watching a recorded drawing being made, and
//                            exporting that as an animation
//   gitea-draw-fill.js       filling an area that other elements close off
//
// The other three hang themselves off `window.giteaDraw`, which this file
// publishes, and read it as they load -- which is why they load after it.  It
// only goes one way: all three are optional, and without them a drawing is
// still drawn, edited and rendered exactly as it was before any of them
// existed, so this file reaches for them only when a reader clicks something,
// never while it is being loaded.

(() => {
  'use strict';

  // bump when changing this file; the four files are fetched and cached
  // separately, so giteaDrawDebug() reports a revision per file and a stale
  // browser cache can be told apart from a real problem
  const REVISION = '27';

  // Every option lives here, but only the ones this file acts on are defaulted
  // here: the other three files add their own on load, so an option sits next
  // to the code it drives.  The admin's giteaDrawConfig is applied last by each
  // of them, so it always wins.
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
    // add the "Align…" entry to the selection menu, see the alignment section
    alignment: true,
    // how close, in screen pixels, a dragged selection has to come to another
    // element's edge or centre before it snaps onto it; 0 turns that off and
    // leaves only the menu
    snapDistance: 8,
    // offer "Fit…" inside the align panel when a single path is selected, see
    // the path fitting section
    fit: true,
    // corner radius of a rounded fit, as a fraction of the shorter side of the
    // path's own bounding box
    fitCornerRadius: 0.25,
    // offer the six UML relationship pens in the pen dropdown, see the UML pens
    // section
    umlPens: true,
    ...(window.giteaDrawConfig ?? {}),
  };

  const TICKS = '```';
  const CODE_SELECTOR = `.markup code.language-${cfg.lang}`;
  const ATTR_RENDERED = 'data-markup-draw-rendered';
  const ATTR_BUTTON = 'data-markup-draw-button';
  const ATTR_ALIGN_MENU = 'data-markup-draw-align';
  const TOOLBAR_STATE_KEY = 'gitea-draw-toolbar-state';

  // Strings.  The other three files add theirs to this same object as they
  // load, so a translation still has one place to happen.
  const i18n = {
    insert: 'Insert drawing',
    edit: 'Edit drawing',
    loading: 'Loading the drawing board…',
    invalidSvg: 'Not a valid SVG drawing',
    noEditor: 'The code editor is not ready yet, please try again',
    align: 'Align…',
    alignTitle: 'Align',
    back: 'Back',
    baseObject: 'Base object',
    nextBase: 'Use the next element as the base object',
    baseOf: (n, total) => `Base: ${n} of ${total}`,
    alignToContent: 'Aligned to everything drawn',
    alignLeft: 'Align left edges',
    alignCenterX: 'Align horizontal centres',
    alignRight: 'Align right edges',
    alignTop: 'Align top edges',
    alignCenterY: 'Align vertical centres',
    alignBottom: 'Align bottom edges',
    distributeX: 'Space out horizontally',
    distributeY: 'Space out vertically',
    snapToGrid: 'Snap to grid',
    matchWidth: 'Match width',
    matchHeight: 'Match height',
    matchSize: 'Match width and height',
    fit: 'Fit…',
    fitTitle: 'Fit',
    fitToBox: 'Fitted to its own bounding box',
    fitSharp: 'Right angles along the bounding box',
    fitRounded: 'Rounded corners along the bounding box',
    fitCurve: 'Curve through the bounding box corners',
    // why the entry is greyed out, shown as its tooltip
    fitNeedsOne: 'Fitting works on one path at a time',
    fitNeedsLine: 'This element is a filled shape rather than a line',
    fitNeedsBox: 'This path is too small to have a bounding box',
    // kept short: js-draw lays the pen types out in a grid whose cells a longer
    // name overflows
    umlGeneralization: 'Generalization',
    umlRealization: 'Realization',
    umlComposition: 'Composition',
    umlAggregation: 'Aggregation',
    umlAssociation: 'Association',
    umlDependency: 'Dependency',
  };

  // ---------------------------------------------------------------- the namespace
  //
  // What the recorder, the player and the fill tool are looked up through, and
  // what they add themselves to.  They load after this file, so nothing here
  // may read them while it is being defined -- see the note at the top.

  const draw = {
    cfg,
    i18n,
    // one entry per file that loaded, for giteaDrawDebug()
    scripts: [{name: 'gitea-draw.js', revision: REVISION, url: document.currentScript?.src ?? '(unknown)'}],
  };
  window.giteaDraw = draw;

  // The recorder, or null where there is none: gitea-draw-history.js was not
  // installed, or the admin switched recording off.  A board without one saves
  // a plain SVG, which is what every board did before there was a recorder.
  const recorder = () => (cfg.history ? draw.recording ?? null : null);

  // Taking a stored history back out of an SVG.  Where there is no recorder
  // there is nothing to take out, and the SVG is the whole drawing.
  const splitHistory = (svgText) =>
    draw.recording?.splitHistory(svgText) ?? {svg: svgText, stored: null};

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
      // A filled area is a component type of gitea-draw-fill.js's own, and
      // js-draw refuses to deserialize one it has not been told about.  That
      // has to happen before anything rebuilds a drawing from JSON, which is
      // not only the board: the player replays the same commands into an
      // editor of its own and never opens one.  This is the single moment
      // every one of them goes through.
      draw.filling?.register(window.jsdraw);
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

  // ---------------------------------------------------------------- asking a question
  //
  // Both overlays -- the board and the player -- put their questions inside
  // themselves rather than in a `window.confirm`, so a question is asked where
  // the drawing it is about is.

  // A short menu inside an overlay: a title, and one button per choice with a
  // line saying what picking it means.
  function askChoice(elParent, {title, body, choices, cancel}) {
    const elDialog = document.createElement('dialog');
    elDialog.className = 'markup-draw-confirm markup-draw-choice';
    const elTitle = document.createElement('p');
    elTitle.className = 'markup-draw-confirm-title';
    elTitle.textContent = title;
    elDialog.append(elTitle);
    if (body) {
      const elBody = document.createElement('p');
      elBody.textContent = body;
      elDialog.append(elBody);
    }
    for (const choice of choices) {
      const elChoice = document.createElement('button');
      elChoice.type = 'button';
      elChoice.className = 'markup-draw-choice-option';
      const elLabel = document.createElement('span');
      elLabel.className = 'markup-draw-choice-label';
      elLabel.textContent = choice.label;
      const elHint = document.createElement('span');
      elHint.className = 'markup-draw-choice-hint';
      elHint.textContent = choice.hint;
      elChoice.append(elLabel, elHint);
      elChoice.addEventListener('click', () => {
        elDialog.close();
        choice.onPick();
      });
      elDialog.append(elChoice);
    }
    const elActions = document.createElement('div');
    elActions.className = 'markup-draw-confirm-actions';
    const elCancel = document.createElement('button');
    elCancel.type = 'button';
    elCancel.textContent = cancel;
    elCancel.addEventListener('click', () => elDialog.close());
    elActions.append(elCancel);
    elDialog.append(elActions);
    elDialog.addEventListener('close', () => elDialog.remove(), {once: true});
    elParent.append(elDialog);
    elDialog.showModal();
    elDialog.querySelector('.markup-draw-choice-option')?.focus();
  }

  // A yes/no question inside an overlay.  It goes in a <dialog> so that Escape
  // dismisses the question rather than the board behind it -- both overlays
  // already let a key through when one is open.
  function askConfirmation(elParent, {title, body, confirm, cancel, onConfirm}) {
    const elDialog = document.createElement('dialog');
    elDialog.className = 'markup-draw-confirm';
    const elTitle = document.createElement('p');
    elTitle.className = 'markup-draw-confirm-title';
    elTitle.textContent = title;
    const elBody = document.createElement('p');
    elBody.textContent = body;
    const elActions = document.createElement('div');
    elActions.className = 'markup-draw-confirm-actions';
    const elCancel = document.createElement('button');
    elCancel.type = 'button';
    elCancel.textContent = cancel;
    const elConfirm = document.createElement('button');
    elConfirm.type = 'button';
    elConfirm.className = 'markup-draw-confirm-go';
    elConfirm.textContent = confirm;
    elCancel.addEventListener('click', () => elDialog.close());
    elConfirm.addEventListener('click', () => {
      elDialog.close();
      onConfirm();
    });
    elDialog.addEventListener('close', () => elDialog.remove(), {once: true});
    elActions.append(elCancel, elConfirm);
    elDialog.append(elTitle, elBody, elActions);
    elParent.append(elDialog);
    elDialog.showModal();
    elConfirm.focus();
  }

  // ---------------------------------------------------------------- rendering

  // Parses the SVG only to read its intrinsic size.  DOMParser neither runs
  // scripts nor fetches subresources, and the parsed nodes never reach the live
  // document -- the drawing itself is displayed through an <img>, see below.
  function parseSvgFrame(svgText) {
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
    // The viewBox also says *where* on the canvas the drawing sits, which is what
    // playback needs to hold the view still while the drawing appears in it.
    const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const framed = box.length === 4 && box.every((n) => Number.isFinite(n));
    if ((!width || !height) && framed) {
      width = box[2];
      height = box[3];
    }
    return {
      width: Math.round(width),
      height: Math.round(height),
      viewBox: framed ? {x: box[0], y: box[1], width: box[2], height: box[3]} : null,
      // js-draw marks a canvas that grows with its content by a class on the
      // root, and reads it back the same way (svgLoaderAutoresizeClassName)
      autoresize: root.classList.contains('js-draw--autoresize'),
    };
  }

  // Replaying a log reinstates the components and nothing else, but loadFromSVG
  // also sets three things: where the drawing sits on the canvas, whether the
  // canvas grows with its content, and the view onto it.  Without them a
  // reopened drawing lands at js-draw's default 0 0 500 500 while the drawing
  // itself may be anywhere else, which shows up as a board zoomed into one
  // corner with the stray default region drawn beside it.
  //
  // All three are taken from the SVG rather than from the log.  The SVG is what
  // the drawing renders as, so it is authoritative by definition, it is always
  // there on the replay path, and taking them from it also repairs logs written
  // before this was noticed.  Recording them instead would have been worse than
  // it looks: setAutoresizeEnabled returns the non-serializable Command.empty
  // when the value is unchanged, which would have made the whole log
  // unserializable and switched recording off.
  function restoreCanvasFrame(jsdraw, editor, svgText) {
    let frame = null;
    try {
      frame = parseSvgFrame(svgText);
    } catch {
      // not parseable, so there is nothing to take the frame from
    }
    const box = frame?.viewBox;
    if (!box || box.width <= 0 || box.height <= 0) {
      // no usable viewBox: at least put the drawing on screen
      const bounds = editor.image.getImportExportRect();
      if (bounds?.maxDimension > 0) editor.dispatchNoAnnounce(editor.viewport.zoomTo(bounds), false);
      return;
    }
    const rect = new jsdraw.Rect2(box.x, box.y, box.width, box.height);
    // the order loadFrom uses; setImportExportRect turns autoresize off, so it
    // has to go first
    editor.dispatchNoAnnounce(editor.image.setImportExportRect(rect), false);
    editor.dispatchNoAnnounce(editor.viewport.zoomTo(rect), false);
    editor.dispatchNoAnnounce(editor.image.setAutoresizeEnabled(frame.autoresize), false);
  }

  function showBlockError(elBlock, err) {
    elBlock.classList.remove('is-loading');
    const elError = document.createElement('pre');
    elError.className = 'ui message error markup-block-error';
    elError.textContent = err.message || String(err);
    elBlock.before(elError);
  }

  function renderDrawing(elPre, source) {
    // The edit history is metadata, not picture: it is kept out of the blob the
    // <img> reads and out of the size limit, which is about how much drawing a
    // page is asked to rasterize.  Counting it would push drawings that were
    // fine yesterday over the limit today.
    const {svg: svgText, stored} = splitHistory(source.trim());
    if (svgText.length > cfg.maxSourceChars) {
      throw new Error(`drawing source of ${svgText.length} characters exceeds the maximum allowed length of ${cfg.maxSourceChars}`);
    }
    const {width, height} = parseSvgFrame(svgText);

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

    const elActions = document.createElement('div');
    elActions.className = 'markup-draw-actions';

    // Inside a markdown editor's own preview the drawing can be edited in place,
    // because the matching source fence is right there in the editor.
    const elMarkup = elPre.closest('.markup');
    if (elMarkup && sourceForMarkup(elMarkup)) {
      const elEdit = document.createElement('button');
      elEdit.type = 'button';
      elEdit.className = 'ui tiny basic button markup-draw-edit';
      elEdit.textContent = i18n.edit;
      elEdit.addEventListener('click', () => editPreviewedDrawing(elMarkup, elContainer));
      elActions.append(elEdit);
    }

    // A drawing that carries its edit history can be watched being made,
    // wherever it is rendered -- there is no editor involved.  The player is
    // gitea-draw-playback.js, so the button only appears where that loaded.
    if (stored && cfg.playback && draw.playback) {
      const elPlay = document.createElement('button');
      elPlay.type = 'button';
      elPlay.className = 'ui tiny basic button markup-draw-play';
      elPlay.textContent = `▶ ${i18n.play}`;
      // elMarkup is passed so the player can find the text behind the drawing:
      // where there is one, its steps can be edited and written back.
      elPlay.addEventListener('click', () =>
        void draw.playback.open(source, elMarkup ? {elMarkup, elContainer} : null));
      elActions.append(elPlay);
    }

    if (elActions.children.length) elContainer.append(elActions);

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

  // ---------------------------------------------------------------- alignment
  //
  // js-draw moves a selection as one block; it has nothing that lines the
  // members of a selection up with each other.  This adds that, hung off the
  // menu the selection's own "…" button already opens rather than off a toolbar
  // of our own, so it sits next to the drawing it acts on.
  //
  // What the elements line up against:
  //
  //   * one element selected -- the bounding box of everything drawn.  The
  //     background is not a component (`image.getAllComponents()` documents
  //     that it leaves background elements out), so a full-page white backdrop
  //     does not swallow that box.
  //   * several selected -- one of them, the *base object*, which stays put
  //     while the others move onto it.  It is outlined on the canvas and can be
  //     stepped through, because a rubber-band selection has no click order for
  //     "the one you picked first" to be read out of; see selectionOrder below.
  //
  // Every action turns into one `transformBy` command per element, united into
  // a single undoable command, so one Ctrl+Z takes back a whole alignment.

  const alignDebug = {hooked: false, why: 'no drawing board opened yet'};

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Icons are drawn here rather than fetched: js-draw has none for alignment,
  // and an extra request for sixteen 16x16 glyphs is not worth it.  A shape is
  // [x, y, w, h], ['path', d] for a filled outline, or ['line', d, width] for a
  // stroked one -- the fit glyphs draw a line, which no fill can describe
  // without doubling back on itself.  The "rule" class marks the edge the
  // blocks line up against so it can be drawn more strongly than they are.
  //
  // The fit glyphs share one faint box, so that the three of them read as three
  // routes across the same rectangle: it runs between (3,4) and (13,12), which
  // is where every fit path below starts and ends.
  const GLYPH_BOX = [
    [3, 3.5, 10, 1], [3, 11.5, 10, 1], [2.5, 4, 1, 8], [12.5, 4, 1, 8],
  ];

  const GLYPHS = {
    left: [[1, 1, 1.5, 14, 'rule'], [3.5, 3, 10, 3.5], [3.5, 9.5, 6.5, 3.5]],
    centerX: [[7.25, 1, 1.5, 14, 'rule'], [3, 3, 10, 3.5], [4.75, 9.5, 6.5, 3.5]],
    right: [[13.5, 1, 1.5, 14, 'rule'], [3.5, 3, 10, 3.5], [7, 9.5, 6.5, 3.5]],
    top: [[1, 1, 14, 1.5, 'rule'], [3, 3.5, 3.5, 10], [9.5, 3.5, 3.5, 6.5]],
    centerY: [[1, 7.25, 14, 1.5, 'rule'], [3, 3, 3.5, 10], [9.5, 4.75, 3.5, 6.5]],
    bottom: [[1, 13.5, 14, 1.5, 'rule'], [3, 3.5, 3.5, 10], [9.5, 7, 3.5, 6.5]],
    distributeX: [[1, 3, 2.5, 10], [6.75, 3, 2.5, 10], [12.5, 3, 2.5, 10]],
    distributeY: [[3, 1, 10, 2.5], [3, 6.75, 10, 2.5], [3, 12.5, 10, 2.5]],
    grid: [[5.3, 1, 1, 14, 'rule'], [9.7, 1, 1, 14, 'rule'], [1, 5.3, 14, 1, 'rule'], [1, 9.7, 14, 1, 'rule']],
    matchWidth: [[2, 2, 12, 4.5], [2, 9, 12, 5]],
    matchHeight: [[2, 2, 4.5, 12], [9, 2, 5, 12]],
    matchSize: [[1.5, 4, 6, 8], [8.5, 4, 6, 8]],
    back: [['path', 'M10.5 2.5 5 8l5.5 5.5z']],
    next: [['path', 'M5.5 2.5 11 8l-5.5 5.5z']],
    fit: [...GLYPH_BOX, ['line', 'M3 4h10v8', 1.9]],
    fitRounded: [...GLYPH_BOX, ['line', 'M3 4h7a3 3 0 0 1 3 3v5', 1.9]],
    // a quadratic whose control point is the corner the box shares with it
    fitCurve: [...GLYPH_BOX, ['line', 'M3 4q10 0 10 8', 1.9]],
  };

  function makeGlyph(shapes) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('markup-draw-glyph');
    for (const shape of shapes) {
      if (shape[0] === 'path' || shape[0] === 'line') {
        const elPath = document.createElementNS(SVG_NS, 'path');
        elPath.setAttribute('d', shape[1]);
        if (shape[0] === 'line') {
          elPath.setAttribute('stroke-width', shape[2]);
          elPath.classList.add('markup-draw-glyph-line');
        }
        svg.append(elPath);
        continue;
      }
      const elRect = document.createElementNS(SVG_NS, 'rect');
      const [x, y, w, h, kind] = shape;
      elRect.setAttribute('x', x);
      elRect.setAttribute('y', y);
      elRect.setAttribute('width', w);
      elRect.setAttribute('height', h);
      if (kind) elRect.classList.add(`markup-draw-glyph-${kind}`);
      svg.append(elRect);
    }
    return svg;
  }

  // js-draw's own selection rectangle is the union of getBBox(), so alignment
  // uses the same box the user sees rather than a tighter one they do not.
  const bboxOf = (component) => component.getBBox();

  const EPSILON = 1e-9;

  // ref is the box being aligned to, box the one being moved
  const ALIGN_DELTAS = {
    left: (box, ref) => [ref.x - box.x, 0],
    centerX: (box, ref) => [ref.center.x - box.center.x, 0],
    right: (box, ref) => [ref.x + ref.w - (box.x + box.w), 0],
    top: (box, ref) => [0, ref.y - box.y],
    centerY: (box, ref) => [0, ref.center.y - box.center.y],
    bottom: (box, ref) => [0, ref.y + ref.h - (box.y + box.h)],
  };

  // the union of everything drawn: what a lone element aligns to
  function contentBounds(editor) {
    let bounds = null;
    for (const component of editor.image.getAllComponents()) {
      const box = bboxOf(component);
      bounds = bounds ? bounds.union(box) : box;
    }
    return bounds;
  }

  function translateCommand(jsdraw, component, dx, dy) {
    if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return null;
    return component.transformBy(jsdraw.Mat33.translation(jsdraw.Vec2.of(dx, dy)));
  }

  // One command for the whole action, so it undoes in one step.  The selection
  // rectangle is derived from the elements, so it has to be rebuilt now that
  // they have moved; the set is unchanged, so this fires no selection event.
  function applyAlignCommands(ctx, objects, commands, description) {
    const real = commands.filter(Boolean);
    if (!real.length) return;
    ctx.editor.dispatch(ctx.jsdraw.uniteCommands(real, {description}));
    ctx.tool.setSelection(objects);
    ctx.updateHighlight();
  }

  function alignSelection(ctx, edge) {
    const objects = ctx.tool.getSelectedObjects();
    if (!objects.length) return;
    const base = objects.length > 1 ? ctx.getBase() : null;
    const reference = base ? bboxOf(base) : contentBounds(ctx.editor);
    if (!reference) return;
    const commands = objects
      .filter((component) => component !== base)
      .map((component) => translateCommand(
        ctx.jsdraw, component, ...ALIGN_DELTAS[edge](bboxOf(component), reference),
      ));
    applyAlignCommands(ctx, objects, commands, i18n[`align${edge[0].toUpperCase()}${edge.slice(1)}`]);
  }

  // Equal gaps between neighbours, with the outermost two left where they are.
  // The base object plays no part here: which elements bound the row is a
  // property of where they sit, not of what was selected first.
  function distributeSelection(ctx, axis) {
    const objects = ctx.tool.getSelectedObjects();
    if (objects.length < 3) return;
    const horizontal = axis === 'x';
    const start = (box) => (horizontal ? box.x : box.y);
    const size = (box) => (horizontal ? box.w : box.h);

    const sorted = [...objects].sort((a, b) => start(bboxOf(a)) - start(bboxOf(b)));
    const boxes = sorted.map(bboxOf);
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    const span = start(last) + size(last) - start(first);
    const filled = boxes.reduce((sum, box) => sum + size(box), 0);
    const gap = (span - filled) / (boxes.length - 1);

    const commands = [];
    let cursor = start(first) + size(first) + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      const shift = cursor - start(boxes[i]);
      commands.push(translateCommand(
        ctx.jsdraw, sorted[i], horizontal ? shift : 0, horizontal ? 0 : shift,
      ));
      cursor += size(boxes[i]) + gap;
    }
    applyAlignCommands(ctx, objects, commands, horizontal ? i18n.distributeX : i18n.distributeY);
  }

  // Scaled about each element's own centre, so it changes size without moving.
  // Note that this scales stroke widths with everything else.
  function matchSizeOfSelection(ctx, mode) {
    const objects = ctx.tool.getSelectedObjects();
    const base = ctx.getBase();
    if (objects.length < 2 || !base) return;
    const reference = bboxOf(base);
    const commands = [];
    for (const component of objects) {
      if (component === base) continue;
      const box = bboxOf(component);
      const sx = mode === 'height' || box.w < EPSILON ? 1 : reference.w / box.w;
      const sy = mode === 'width' || box.h < EPSILON ? 1 : reference.h / box.h;
      if (Math.abs(sx - 1) < EPSILON && Math.abs(sy - 1) < EPSILON) continue;
      commands.push(component.transformBy(
        ctx.jsdraw.Mat33.scaling2D(ctx.jsdraw.Vec2.of(sx, sy), box.center),
      ));
    }
    const labels = {width: i18n.matchWidth, height: i18n.matchHeight, both: i18n.matchSize};
    applyAlignCommands(ctx, objects, commands, labels[mode]);
  }

  // Each element separately, unlike js-draw's own snapSelectedObjectsToGrid(),
  // which moves the selection as a block.  The grid is js-draw's, so its size
  // follows the zoom level.
  function snapSelectionToGrid(ctx) {
    const objects = ctx.tool.getSelectedObjects();
    if (!objects.length) return;
    const commands = objects.map((component) => {
      const box = bboxOf(component);
      const snapped = ctx.editor.viewport.snapToGrid(box.topLeft);
      return translateCommand(ctx.jsdraw, component, snapped.x - box.x, snapped.y - box.y);
    });
    applyAlignCommands(ctx, objects, commands, i18n.snapToGrid);
  }

  // ------------------------------------------------ fitting a path to its box
  //
  // "Fit…", reached from the selection menu with exactly one path selected.  It
  // replaces a rough stroke with a clean one that runs along the edges of the
  // box the stroke already fills.  The route is:
  //
  //     the stroke's own start point, left exactly where it is
  //     -> straight out from it onto an edge of the box
  //     -> along the box's edges, through the corners on the way
  //     -> onto the edge the other end sits off
  //     -> the stroke's own end point, left exactly where it is
  //
  // so a G comes back as: up out of where the pen started, along the top, down
  // the left, along the bottom, and out to where the pen stopped.  **The two
  // ends do not move.**  They are what says which stroke this was; a fit that
  // dragged them onto the nearest corners would turn every shape with the same
  // bounding box into the same drawing.
  //
  // That route is then drawn in one of three ways -- square corners, rounded
  // corners, or as a Bezier curve whose control points are the corners.
  //
  // This is the manual counterpart of the autocorrect measured in
  // doc/stroke-fitting.md, and it is manual because of what that note found:
  // no corner detector it tried was stable, the best of them answering
  // differently on one redraw in ten.  Nothing here detects a corner.  A
  // bounding box has four of them whether the hand shook or not, so the same
  // stroke fits the same way every time, and the fit happens because a button
  // was pressed rather than because a guess fired.
  //
  // See doc/box-fitting.md for what each of the three does to which strokes.

  // how many evenly spaced points a path is reduced to before the candidate
  // routes are scored against it, and how many each route is reduced to
  const FIT_SAMPLES = 64;
  // points per curve command when a path is flattened into a polyline
  const FIT_CURVE_STEPS = 8;
  // a stroke whose two ends come closer to each other than this much of its
  // box's perimeter is taken to be closed
  const FIT_CLOSED = 0.1;

  // Only a stroked path can be fitted.  js-draw's freehand pen draws one --
  // {fill: transparent, stroke: {color, width}} -- but its pressure-sensitive
  // pen, its shape pens and the UML pens above all draw a *filled outline*
  // instead, where the visible line is the gap between two sides of one closed
  // loop.  Running that loop around the box would leave a hairline where a
  // shape used to be, so those are refused rather than ruined.
  function fittablePart(component) {
    const parts = component?.getParts?.();
    if (!parts || parts.length !== 1) return null;
    const part = parts[0];
    if (!part.path || !part.style?.stroke) return null;
    return part;
  }

  // why "Fit…" is greyed out, or '' when it is not
  function fitProblem(ctx) {
    const objects = ctx.tool.getSelectedObjects();
    if (objects.length !== 1) return i18n.fitNeedsOne;
    const part = fittablePart(objects[0]);
    if (!part) return i18n.fitNeedsLine;
    const box = part.path.getExactBBox();
    if (Math.max(box.w, box.h) < EPSILON) return i18n.fitNeedsBox;
    return '';
  }

  // de Casteljau.  A curve has to contribute its shape and not just its end
  // points, or re-fitting a path that a previous fit already curved would score
  // the two ways round the box against a straight line between its ends.
  function appendCurvePoints(from, command, into) {
    const hull = command.controlPoint
      ? [from, command.controlPoint, command.endPoint]
      : [from, command.controlPoint1, command.controlPoint2, command.endPoint];
    for (let step = 1; step <= FIT_CURVE_STEPS; step++) {
      const t = step / FIT_CURVE_STEPS;
      let level = hull;
      while (level.length > 1) {
        const next = [];
        for (let i = 1; i < level.length; i++) next.push(level[i - 1].lerp(level[i], t));
        level = next;
      }
      into.push(level[0]);
    }
  }

  function pathToPolyline(jsdraw, path) {
    const points = [path.startPoint];
    for (const command of path.parts) {
      if (command.kind === jsdraw.PathCommandType.LineTo ||
          command.kind === jsdraw.PathCommandType.MoveTo) {
        points.push(command.point);
      } else {
        appendCurvePoints(points[points.length - 1], command, points);
      }
    }
    return points;
  }

  // Evenly spaced points along a polyline.  Without this the score below would
  // count wherever the pen dawdled twice, and a stroke slows at its corners --
  // which is exactly where the two candidate routes differ most.
  function resamplePolyline(points, count) {
    const along = [0];
    for (let i = 1; i < points.length; i++) {
      along.push(along[i - 1] + points[i].distanceTo(points[i - 1]));
    }
    const total = along[along.length - 1];
    if (!(total > EPSILON)) return [points[0], points[points.length - 1]];
    const out = [];
    let at = 1;
    for (let i = 0; i < count; i++) {
      const target = (total * i) / (count - 1);
      while (at < along.length - 1 && along[at] < target) at++;
      const span = along[at] - along[at - 1];
      out.push(points[at - 1].lerp(points[at], span > EPSILON ? (target - along[at - 1]) / span : 0));
    }
    return out;
  }

  function distanceToSegment(point, from, to) {
    const along = to.minus(from);
    const lengthSquared = along.dot(along);
    if (lengthSquared < EPSILON) return point.distanceTo(from);
    const t = Math.min(1, Math.max(0, point.minus(from).dot(along) / lengthSquared));
    return point.distanceTo(from.plus(along.times(t)));
  }

  const distanceToRoute = (point, route) => {
    let best = Infinity;
    for (let i = 1; i < route.length; i++) {
      best = Math.min(best, distanceToSegment(point, route[i - 1], route[i]));
    }
    return best;
  };

  // A zero-width or zero-height box has its corners on top of each other, and a
  // route through a repeated point has an edge with no direction for a rounded
  // corner to be cut back along.
  const withoutRepeats = (points) => points.filter(
    (point, i) => i === 0 || point.distanceTo(points[i - 1]) > EPSILON,
  );

  // The box's perimeter as a loop of one number: the distance clockwise from
  // the top left corner.  A walk between two points on the box is then
  // arithmetic, rather than case analysis over which edges each of them is on.
  function perimeterOf(jsdraw, box) {
    const {w, h} = box;
    const total = 2 * (w + h);
    const at = (t) => {
      const s = ((t % total) + total) % total;
      if (s <= w) return jsdraw.Vec2.of(box.x + s, box.y);
      if (s <= w + h) return jsdraw.Vec2.of(box.x + w, box.y + s - w);
      if (s <= 2 * w + h) return jsdraw.Vec2.of(box.x + 2 * w + h - s, box.y + h);
      return jsdraw.Vec2.of(box.x, box.y + total - s);
    };
    // where `point` lands when pushed straight out onto `edge`, numbered from
    // the top edge clockwise.  This is the segment that keeps the stroke's own
    // end: it leaves the box at a right angle, so a square fit stays square.
    const onto = (point, edge) => {
      const x = Math.min(Math.max(point.x, box.x), box.x + w);
      const y = Math.min(Math.max(point.y, box.y), box.y + h);
      if (edge === 0) return x - box.x;
      if (edge === 1) return w + (y - box.y);
      if (edge === 2) return w + h + (box.x + w - x);
      return 2 * w + h + (box.y + h - y);
    };
    return {total, corners: [0, w, w + h, 2 * w + h], at, onto};
  }

  // The corners passed walking from `from` to `to` with `step` (+1 clockwise),
  // in the order they are reached and not counting either end.
  function cornersBetween(perimeter, from, to, step) {
    const {total, corners, at} = perimeter;
    const loop = (d) => ((d % total) + total) % total;
    const span = loop(step > 0 ? to - from : from - to);
    return corners
      .map((corner) => loop(step > 0 ? corner - from : from - corner))
      .filter((reached) => reached > EPSILON && reached < span - EPSILON)
      .sort((a, b) => a - b)
      .map((reached) => at(from + step * reached));
  }

  // The whole perimeter, from the corner the stroke started nearest.  A closed
  // stroke's two ends are the same point, so there is nothing for the route to
  // keep, and starting at a corner keeps the rounded and curved fits down to
  // the four turns the box has rather than five.
  function closedRoute(box, start) {
    const corners = [box.topLeft, box.topRight, box.bottomRight, box.bottomLeft];
    let first = 0;
    for (let i = 1; i < corners.length; i++) {
      if (start.distanceTo(corners[i]) < start.distanceTo(corners[first])) first = i;
    }
    const route = withoutRepeats(Array.from(
      {length: corners.length + 1}, (unused, i) => corners[(first + i) % corners.length],
    ));
    return route.length < 3 ? null : route;
  }

  const meanDistanceTo = (points, polyline) => points.reduce(
    (sum, point) => sum + distanceToRoute(point, polyline), 0,
  ) / points.length;

  // Both directions.  Charging only for how far the stroke sits from the route
  // would make the longest route win every time: another side of the box can
  // only bring the route nearer to the stroke, never further.  The second half
  // charges for route that goes where the stroke did not, which is what turns
  // "which way round did it go" into a question with an answer.
  const routeCost = (samples, route) =>
    meanDistanceTo(samples, route) +
    meanDistanceTo(resamplePolyline(route, FIT_SAMPLES), samples);

  // Which edge an end is pushed out onto: the nearest, so that the hop is the
  // shortest one that reaches the box.
  //
  // Scoring all four edges against the stroke was tried instead, and is a trap.
  // A hop long enough to cross the box can lie along the stroke *better* than
  // the edge it stands in for does -- the ink is a couple of units inside the
  // box, the edge is not -- so the best-matching route stopped being the one
  // that hugs the box, which is the whole of what the fit promises.  The hop is
  // the exception to that promise, so it is kept as small as it can be.
  function nearestEdge(box, point) {
    const distances = [
      point.y - box.y, box.x + box.w - point.x,
      box.y + box.h - point.y, point.x - box.x,
    ];
    return distances.indexOf(Math.min(...distances));
  }

  // The route the fit follows.  Its first and last points are the stroke's own
  // two ends, unmoved; between them it leaves each end at a right angle for the
  // nearest edge of the box, and walks the box's edges from one to the other.
  //
  // Which way round it walks is not decided by a rule: both are built and the
  // one whose shape sits closest to the stroke's own wins.  A rule would have
  // to guess at what the score can simply measure.
  function fitRoute(jsdraw, path, box) {
    const samples = resamplePolyline(pathToPolyline(jsdraw, path), FIT_SAMPLES);
    const start = samples[0];
    const end = samples[samples.length - 1];
    const perimeter = perimeterOf(jsdraw, box);

    if (start.distanceTo(end) < FIT_CLOSED * perimeter.total) {
      return closedRoute(box, start);
    }

    const from = perimeter.onto(start, nearestEdge(box, start));
    const to = perimeter.onto(end, nearestEdge(box, end));
    let chosen = null;
    for (const step of [1, -1]) {
      // an end already on the edge it is pushed onto joins the walk directly,
      // and the duplicate point that leaves is dropped here
      const route = withoutRepeats([
        start, perimeter.at(from),
        ...cornersBetween(perimeter, from, to, step),
        perimeter.at(to), end,
      ]);
      if (route.length < 2) continue;
      const cost = routeCost(samples, route);
      if (!chosen || cost < chosen.cost) chosen = {route, cost};
    }
    return chosen?.route ?? null;
  }

  const fitLineTo = (jsdraw, point) => ({kind: jsdraw.PathCommandType.LineTo, point});
  const fitQuadTo = (jsdraw, controlPoint, endPoint) => ({
    kind: jsdraw.PathCommandType.QuadraticBezierTo, controlPoint, endPoint,
  });

  // A route that ends where it began has no free ends, which changes what the
  // rounded and curved fits have to do with its first corner.
  const isClosedRoute = (route) =>
    route[0].distanceTo(route[route.length - 1]) < EPSILON;

  const sharpFit = (jsdraw, route) => ({
    startPoint: route[0],
    commands: route.slice(1).map((point) => fitLineTo(jsdraw, point)),
  });

  // Every corner is cut back along both of its edges and the cut ends joined by
  // a quadratic whose control point is the corner itself -- the construction a
  // rounded corner already is, rather than an arc approximating one.
  function roundedFit(jsdraw, route, radius) {
    const closed = isClosedRoute(route);
    const points = closed ? route.slice(0, -1) : route;
    const count = points.length;
    const edge = (i) => points[(i + 1) % count].minus(points[i]);
    // never more than half of either edge, or two corners sharing a short one
    // would round through each other and the line would double back
    const radiusAt = (i) => Math.min(
      radius,
      edge((i - 1 + count) % count).magnitude() / 2,
      edge(i).magnitude() / 2,
    );
    const before = (i) =>
      points[i].minus(edge((i - 1 + count) % count).normalized().times(radiusAt(i)));
    const after = (i) => points[i].plus(edge(i).normalized().times(radiusAt(i)));

    // a closed route is rounded at its first corner too, so the path starts
    // part way along the first edge instead of at the corner behind it; an open
    // one keeps its two free ends square, there being no turn to round there
    const startPoint = closed ? after(0) : points[0];
    const commands = [];
    for (let i = 1; i <= (closed ? count - 1 : count - 2); i++) {
      commands.push(fitLineTo(jsdraw, before(i)), fitQuadTo(jsdraw, points[i], after(i)));
    }
    if (closed) {
      commands.push(fitLineTo(jsdraw, before(0)), fitQuadTo(jsdraw, points[0], startPoint));
    } else {
      commands.push(fitLineTo(jsdraw, points[count - 1]));
    }
    return {startPoint, commands};
  }

  // The route's ends become the curve's ends and the corners it turns at become
  // the control points, so the curve leans into each corner of the box without
  // reaching it: one corner is a quadratic, two are a cubic.
  function curveFit(jsdraw, route) {
    const endPoint = route[route.length - 1];

    // A closed route has no ends to anchor a curve to, so every corner becomes
    // a control point and the curve runs from edge midpoint to edge midpoint --
    // the standard closed quadratic spline, which around a rectangle draws the
    // loop inscribed in it that a freehand circle should come back as.
    if (isClosedRoute(route)) {
      const controls = route.slice(0, -1);
      const between = (i) => controls[i].lerp(controls[(i + 1) % controls.length], 0.5);
      return {
        startPoint: between(controls.length - 1),
        commands: controls.map((control, i) => fitQuadTo(jsdraw, control, between(i))),
      };
    }

    // An open route turns wherever the box does between the two ends it keeps,
    // which can be more corners than one Bezier has control points: an elbow
    // has one and a G has four.  Up to two are that one Bezier; past that they
    // become a chain of quadratics handed off at the midpoints between
    // consecutive corners, the join that leaves the tangent continuous.
    const controls = route.slice(1, -1);
    const commands = [];
    if (!controls.length) commands.push(fitLineTo(jsdraw, endPoint));
    else if (controls.length === 1) commands.push(fitQuadTo(jsdraw, controls[0], endPoint));
    else if (controls.length === 2) {
      commands.push({
        kind: jsdraw.PathCommandType.CubicBezierTo,
        controlPoint1: controls[0],
        controlPoint2: controls[1],
        endPoint,
      });
    } else {
      for (let i = 0; i < controls.length; i++) {
        commands.push(fitQuadTo(jsdraw, controls[i], i === controls.length - 1
          ? endPoint
          : controls[i].lerp(controls[i + 1], 0.5)));
      }
    }
    return {startPoint: route[0], commands};
  }

  const FITS = {sharp: sharpFit, rounded: roundedFit, curve: curveFit};

  // An erase and an add, united, so that one Ctrl+Z puts the original stroke
  // back -- the cheap rejection doc/stroke-fitting.md asks any fit to have.
  // The new stroke keeps the old one's style and z-index, so nothing about it
  // changes but its geometry and where it sits in the stacking order stays put.
  function fitSelection(ctx, kind) {
    if (fitProblem(ctx)) return;
    const component = ctx.tool.getSelectedObjects()[0];
    const part = fittablePart(component);
    const box = part.path.getExactBBox();
    const route = fitRoute(ctx.jsdraw, part.path, box);
    if (!route) return;

    const {startPoint, commands} = FITS[kind](
      ctx.jsdraw, route, Math.min(box.w, box.h) * cfg.fitCornerRadius,
    );
    // rounding keeps the exported path free of long decimals, for the same
    // reason the UML pens round: this is markdown someone has to read in a diff
    const fitted = new ctx.jsdraw.Path(startPoint, commands)
      .mapPoints((point) => ctx.editor.viewport.roundPoint(point));
    const stroke = new ctx.jsdraw.Stroke(
      [ctx.jsdraw.pathToRenderable(fitted, part.style)], component.getZIndex(),
    );

    ctx.editor.dispatch(ctx.jsdraw.uniteCommands([
      new ctx.jsdraw.Erase([component]),
      ctx.editor.image.addComponent(stroke),
    ], {description: i18n[`fit${kind[0].toUpperCase()}${kind.slice(1)}`]}));
    // the fitted stroke is a different component, so the selection has to be
    // moved onto it or the panel would still be pointing at what was erased
    ctx.tool.setSelection([stroke]);
    ctx.updateHighlight();
  }

  // Which element is the base, and the outline that says so.
  //
  // SelectionTool.setSelection() sorts by z-index, so the click order is not
  // recoverable from the selection itself.  Selections are *extended* by
  // appending, though, so remembering the order events arrive in keeps
  // shift-click order intact; a rubber-band selection genuinely has none and
  // falls back to z-index, i.e. the order the elements were drawn in.
  function createSelectionOrder() {
    let ordered = [];
    let base = null;
    return {
      update(objects) {
        const selected = new Set(objects);
        const kept = ordered.filter((component) => selected.has(component));
        const keptSet = new Set(kept);
        ordered = [...kept, ...objects.filter((component) => !keptSet.has(component))];
        if (!base || !selected.has(base)) base = ordered[0] ?? null;
      },
      getBase: () => base,
      getOrder: () => ordered,
      next() {
        if (ordered.length < 2) return;
        base = ordered[(ordered.indexOf(base) + 1) % ordered.length];
      },
    };
  }

  // A layer pinned over the editor's rendering area.  js-draw's
  // canvasToScreen() is relative to exactly that area, so anything placed
  // inside can use its coordinates directly, and clipping to it keeps drawings
  // on the canvas from being painted over the toolbar.
  function createCanvasOverlay(editor, elParent, className) {
    const elLayer = document.createElement('div');
    elLayer.className = `markup-draw-canvas-overlay ${className}`;
    elParent.append(elLayer);
    return {
      el: elLayer,
      show() {
        const area = editor.getOutputBBoxInDOM();
        elLayer.style.display = '';
        elLayer.style.left = `${area.x}px`;
        elLayer.style.top = `${area.y}px`;
        elLayer.style.width = `${area.w}px`;
        elLayer.style.height = `${area.h}px`;
      },
      hide() {
        elLayer.style.display = 'none';
      },
    };
  }

  function createBaseHighlight(jsdraw, editor, tool, elParent, getBase) {
    const layer = createCanvasOverlay(editor, elParent, 'markup-draw-base');
    const elBox = document.createElement('div');
    elBox.className = 'markup-draw-base-box';
    layer.el.append(elBox);

    const update = () => {
      const base = getBase();
      const objects = tool.getSelectedObjects?.() ?? [];
      // with a single element selected there is no base: it aligns to the
      // drawing as a whole, and outlining the only selected element would just
      // repeat the selection rectangle
      if (!base || objects.length < 2 || !objects.includes(base)) {
        layer.hide();
        return;
      }
      layer.show();

      // mid-drag the elements have not moved yet -- the pending transform sits
      // on the selection until it is finalised
      const pending = tool.getSelection()?.getTransform?.() ?? null;
      const corners = bboxOf(base).corners.map((corner) => editor.viewport.canvasToScreen(
        pending ? pending.transformVec2(corner) : corner,
      ));
      const box = jsdraw.Rect2.bboxOf(corners);
      elBox.style.left = `${box.x}px`;
      elBox.style.top = `${box.y}px`;
      elBox.style.width = `${box.w}px`;
      elBox.style.height = `${box.h}px`;
    };

    // A drag only reaches the elements when it ends, so follow the pending
    // transform while a pointer is down and stop as soon as it is up.
    let frame = null;
    const follow = () => {
      if (!layer.el.isConnected) return; // the board was closed mid-drag
      update();
      frame = requestAnimationFrame(follow);
    };
    return {
      update,
      startFollowing() {
        frame ??= requestAnimationFrame(follow);
      },
      stopFollowing() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        update();
      },
    };
  }

  // Guides while dragging.
  //
  // js-draw publishes no "the selection is being dragged" hook, but a drag is a
  // stream of `Selection.setTransform(Mat33.translation(…))` calls, and
  // setTransform is an ordinary method: shadowing it *on the instance* (never
  // on the prototype, which is shared with every other board on the page) lets
  // the translation be adjusted on its way through.
  //
  // Anything that is not a plain translation goes through untouched, so resize
  // and rotate handles keep working; so does anything with `preview` false,
  // which is how the finalising command replays the transform. Holding Ctrl
  // hands over to js-draw's own grid snapping rather than fighting it.

  // The translation a transform performs, or null if it does anything else.
  // Read off the transform rather than out of its matrix, so that this does not
  // depend on how Mat33 stores itself.
  function translationOf(jsdraw, transform) {
    const {Vec2} = jsdraw;
    const origin = transform.transformVec2(Vec2.of(0, 0));
    const alongX = transform.transformVec2(Vec2.of(1, 0)).minus(origin);
    const alongY = transform.transformVec2(Vec2.of(0, 1)).minus(origin);
    const isUnit = (vec, x, y) => Math.abs(vec.x - x) < 1e-6 && Math.abs(vec.y - y) < 1e-6;
    return isUnit(alongX, 1, 0) && isUnit(alongY, 0, 1) ? origin : null;
  }

  function createDragSnapping(jsdraw, editor, tool, elParent) {
    const layer = createCanvasOverlay(editor, elParent, 'markup-draw-guides');
    layer.hide();
    const patched = new WeakSet();
    let lines = null; // candidate guides, gathered once per drag
    let dragBox = null; // the selection's box before the drag, likewise
    let dragging = false;

    // Where an element offers to line others up: its two edges and its centre,
    // on each axis.  Guides at the same coordinate are merged, and each keeps
    // the extent of what produced it so the drawn line can reach from the
    // element it belongs to to the one being dragged.
    function gatherLines(selection) {
      const selected = new Set(selection.getSelectedObjects());
      const axes = {x: new Map(), y: new Map()};
      const add = (axis, at, from, to) => {
        const key = at.toFixed(3);
        const line = axis.get(key);
        if (line) {
          line.from = Math.min(line.from, from);
          line.to = Math.max(line.to, to);
        } else {
          axis.set(key, {at, from, to});
        }
      };
      for (const component of editor.image.getAllComponents()) {
        if (selected.has(component)) continue;
        const box = bboxOf(component);
        for (const at of [box.x, box.center.x, box.x + box.w]) add(axes.x, at, box.y, box.y + box.h);
        for (const at of [box.y, box.center.y, box.y + box.h]) add(axes.y, at, box.x, box.x + box.w);
      }
      return {x: [...axes.x.values()], y: [...axes.y.values()]};
    }

    const edgesOf = (box) => ({
      x: [box.x, box.center.x, box.x + box.w],
      y: [box.y, box.center.y, box.y + box.h],
    });

    // the smallest move that puts one of the dragged edges onto a guide
    function nearestShift(edges, candidates, limit) {
      let shift = 0;
      let best = limit;
      for (const edge of edges) {
        for (const candidate of candidates) {
          const distance = Math.abs(candidate.at - edge);
          if (distance < best) {
            best = distance;
            shift = candidate.at - edge;
          }
        }
      }
      return shift;
    }

    const linesHit = (edges, candidates) => candidates.filter(
      (candidate) => edges.some((edge) => Math.abs(candidate.at - edge) < 1e-3),
    );

    function drawGuides(hits, box) {
      const elLines = [];
      const guide = (from, to) => {
        const start = editor.viewport.canvasToScreen(from);
        const end = editor.viewport.canvasToScreen(to);
        const span = end.minus(start);
        const elLine = document.createElement('div');
        elLine.className = 'markup-draw-guide';
        elLine.style.left = `${start.x}px`;
        elLine.style.top = `${start.y}px`;
        elLine.style.width = `${span.magnitude()}px`;
        // a rotated viewport turns an axis-aligned guide into a slanted one
        elLine.style.transform = `rotate(${Math.atan2(span.y, span.x)}rad)`;
        elLines.push(elLine);
      };
      for (const line of hits.x) {
        guide(
          jsdraw.Vec2.of(line.at, Math.min(line.from, box.y)),
          jsdraw.Vec2.of(line.at, Math.max(line.to, box.y + box.h)),
        );
      }
      for (const line of hits.y) {
        guide(
          jsdraw.Vec2.of(Math.min(line.from, box.x), line.at),
          jsdraw.Vec2.of(Math.max(line.to, box.x + box.w), line.at),
        );
      }
      if (!elLines.length) {
        layer.hide();
        return;
      }
      layer.show();
      layer.el.replaceChildren(...elLines);
    }

    const clear = () => {
      layer.hide();
      layer.el.replaceChildren();
    };

    function adjust(selection, transform, preview) {
      // `preview` false is the finalising command replaying what the drag
      // already produced; snapping it a second time would move it twice
      if (!dragging || !preview || tool.snapToGrid) return transform;
      const delta = translationOf(jsdraw, transform);
      if (!delta) { // a resize or rotate handle, not the selection itself
        clear();
        return transform;
      }
      // the grab itself, before any movement: snapping here would tug the
      // selection out from under the pointer
      if (Math.abs(delta.x) < EPSILON && Math.abs(delta.y) < EPSILON) {
        clear();
        return transform;
      }

      lines ??= gatherLines(selection);
      dragBox ??= selection.computeTightBoundingBox();
      if (!dragBox || (!lines.x.length && !lines.y.length)) return transform;

      const limit = cfg.snapDistance * editor.viewport.getSizeOfPixelOnCanvas();
      const edges = edgesOf(dragBox);
      const moved = jsdraw.Vec2.of(
        delta.x + nearestShift(edges.x.map((at) => at + delta.x), lines.x, limit),
        delta.y + nearestShift(edges.y.map((at) => at + delta.y), lines.y, limit),
      );
      const box = dragBox.translatedBy(moved);
      const hit = edgesOf(box);
      drawGuides({x: linesHit(hit.x, lines.x), y: linesHit(hit.y, lines.y)}, box);
      return jsdraw.Mat33.translation(moved);
    }

    return {
      // Selections are rebuilt whenever what is selected changes, so each new
      // one has to be shadowed again.
      attach(selection) {
        if (!selection || patched.has(selection) || typeof selection.setTransform !== 'function') return;
        patched.add(selection);
        const original = selection.setTransform.bind(selection);
        selection.setTransform = (transform, preview = true) => {
          let adjusted = transform;
          try {
            adjusted = adjust(selection, transform, preview);
          } catch {
            adjusted = transform; // never let snapping break dragging
          }
          original(adjusted, preview);
        };
      },
      startDrag(selection) {
        this.attach(selection);
        lines = null;
        dragBox = null;
        dragging = cfg.snapDistance > 0;
      },
      endDrag() {
        dragging = false;
        clear();
      },
      // what is on the canvas changed, so the guides it offers did too
      invalidate() {
        lines = null;
        dragBox = null;
      },
    };
  }

  function makeAlignButton(glyph, label, onClick) {
    const elButton = document.createElement('button');
    elButton.type = 'button';
    elButton.className = 'markup-draw-align-button';
    elButton.title = label;
    elButton.setAttribute('aria-label', label);
    elButton.append(makeGlyph(glyph));
    elButton.addEventListener('click', onClick);
    return elButton;
  }

  // A panel's title row: the way back to whatever opened it, and its name.
  function makePanelHead(title, onBack) {
    const elHead = document.createElement('div');
    elHead.className = 'markup-draw-align-head';
    const elBack = makeAlignButton(GLYPHS.back, i18n.back, onBack);
    elBack.classList.add('markup-draw-align-back');
    const elTitle = document.createElement('span');
    elTitle.textContent = title;
    elHead.append(elBack, elTitle);
    return elHead;
  }

  // "Fit…", the panel behind the menu entry of that name.  It stays open after
  // a fit, like the align panel does, so one shape can be tried three ways -- a
  // fitted path fits the same way again, its box being the box it was just
  // given.
  function buildFitPanel(ctx, onBack) {
    const elPanel = document.createElement('div');
    elPanel.className = 'markup-draw-align-panel';
    elPanel.append(makePanelHead(i18n.fitTitle, onBack));

    const elNote = document.createElement('div');
    elNote.className = 'markup-draw-align-base';
    elNote.textContent = i18n.fitToBox;
    elPanel.append(elNote);

    const elGrid = document.createElement('div');
    elGrid.className = 'markup-draw-align-grid';
    for (const [glyph, label, kind] of [
      [GLYPHS.fit, i18n.fitSharp, 'sharp'],
      [GLYPHS.fitRounded, i18n.fitRounded, 'rounded'],
      [GLYPHS.fitCurve, i18n.fitCurve, 'curve'],
    ]) {
      elGrid.append(makeAlignButton(glyph, label, () => fitSelection(ctx, kind)));
    }
    elPanel.append(elGrid);
    return elPanel;
  }

  // The panel that replaces the menu's own contents when "Align…" is picked.
  // It stays open after an action: js-draw's menu has a transparent backdrop,
  // so the drawing is visible behind it and alignments can be chained.
  function buildAlignPanel(ctx, onBack) {
    const count = ctx.tool.getSelectedObjects().length;

    const elPanel = document.createElement('div');
    elPanel.className = 'markup-draw-align-panel';
    elPanel.append(makePanelHead(i18n.alignTitle, onBack));

    const elBase = document.createElement('div');
    elBase.className = 'markup-draw-align-base';
    const elBaseText = document.createElement('span');
    const elNext = makeAlignButton(GLYPHS.next, i18n.nextBase, () => {
      ctx.nextBase();
      ctx.updateHighlight();
      refreshBase();
    });
    elNext.classList.add('markup-draw-align-next');
    const refreshBase = () => {
      if (count < 2) {
        elBaseText.textContent = i18n.alignToContent;
        return;
      }
      const order = ctx.getOrder();
      elBaseText.textContent = i18n.baseOf(order.indexOf(ctx.getBase()) + 1, order.length);
    };
    refreshBase();
    elBase.append(elBaseText);
    if (count >= 2) elBase.append(elNext);
    elPanel.append(elBase);

    // [glyph, label, action, how many elements it needs]
    const actions = [
      [GLYPHS.left, i18n.alignLeft, () => alignSelection(ctx, 'left'), 1],
      [GLYPHS.centerX, i18n.alignCenterX, () => alignSelection(ctx, 'centerX'), 1],
      [GLYPHS.right, i18n.alignRight, () => alignSelection(ctx, 'right'), 1],
      [GLYPHS.top, i18n.alignTop, () => alignSelection(ctx, 'top'), 1],
      [GLYPHS.centerY, i18n.alignCenterY, () => alignSelection(ctx, 'centerY'), 1],
      [GLYPHS.bottom, i18n.alignBottom, () => alignSelection(ctx, 'bottom'), 1],
      [GLYPHS.distributeX, i18n.distributeX, () => distributeSelection(ctx, 'x'), 3],
      [GLYPHS.distributeY, i18n.distributeY, () => distributeSelection(ctx, 'y'), 3],
      [GLYPHS.grid, i18n.snapToGrid, () => snapSelectionToGrid(ctx), 1],
      [GLYPHS.matchWidth, i18n.matchWidth, () => matchSizeOfSelection(ctx, 'width'), 2],
      [GLYPHS.matchHeight, i18n.matchHeight, () => matchSizeOfSelection(ctx, 'height'), 2],
      [GLYPHS.matchSize, i18n.matchSize, () => matchSizeOfSelection(ctx, 'both'), 2],
    ];

    const elGrid = document.createElement('div');
    elGrid.className = 'markup-draw-align-grid';
    for (const [glyph, label, action, minimum] of actions) {
      const elButton = makeAlignButton(glyph, label, action);
      elButton.disabled = count < minimum;
      elGrid.append(elButton);
    }
    elPanel.append(elGrid);
    return elPanel;
  }

  // One entry in the selection's menu: a button that swaps the menu's own
  // contents for a panel of ours, and puts them back on the way out.  Hiding
  // rather than removing keeps whatever js-draw built exactly as it was found.
  function makeMenuEntry(elContent, {glyph, label, className, problem, build}) {
    const elEntry = document.createElement('button');
    elEntry.type = 'button';
    elEntry.className = `option editor-popup-menu-option ${className}`;
    elEntry.setAttribute('role', 'menuitem');
    elEntry.disabled = Boolean(problem);
    if (problem) elEntry.title = problem;
    elEntry.append(makeGlyph(glyph), document.createTextNode(label));
    elEntry.addEventListener('click', () => {
      const elHidden = [...elContent.children];
      for (const el of elHidden) el.style.display = 'none';
      const elPanel = build(() => {
        elPanel.remove();
        for (const el of elHidden) el.style.display = '';
        elEntry.focus();
      });
      elContent.append(elPanel);
      elPanel.querySelector('button')?.focus();
    });
    return elEntry;
  }

  // Adds "Align…" and "Fit…" to the menu the selection's "…" button (and a
  // right click) opens.  js-draw builds that menu as a
  // <dialog class="editor-popup-menu"> holding a .content list of
  // .editor-popup-menu-option buttons; everything js-draw puts there is left
  // alone, ours are appended.
  //
  // The two are siblings rather than one inside the other: they are different
  // questions about the selection -- where it sits against everything else, and
  // what shape one path in it should be -- and neither is a step on the way to
  // the other.
  function injectMenuEntries(ctx, elRoot) {
    // a menu that is on its way out keeps its element for the length of its
    // fade, so the one being opened is the last that is not fading
    const elDialogs = elRoot.querySelectorAll('dialog.editor-popup-menu:not(.-hide)');
    const elDialog = elDialogs[elDialogs.length - 1];
    if (!elDialog || elDialog.hasAttribute(ATTR_ALIGN_MENU)) return;
    const elContent = elDialog.querySelector('.content');
    // no selection means this is the "paste here" menu, which has nothing to align
    if (!elContent || !ctx.tool.getSelectedObjects().length) return;
    elDialog.setAttribute(ATTR_ALIGN_MENU, 'true');

    elContent.append(makeMenuEntry(elContent, {
      glyph: GLYPHS.left,
      label: i18n.align,
      className: 'markup-draw-align-entry',
      build: (onBack) => buildAlignPanel(ctx, onBack),
    }));
    // Greyed out rather than left out: a fit needs one path and most selections
    // are not one, so an entry that came and went would look like a bug, and
    // the tooltip is the only place the reason can be said.
    if (cfg.fit) {
      elContent.append(makeMenuEntry(elContent, {
        glyph: GLYPHS.fit,
        label: i18n.fit,
        className: 'markup-draw-fit-entry',
        problem: fitProblem(ctx),
        build: (onBack) => buildFitPanel(ctx, onBack),
      }));
    }
  }

  function setupAlignment(jsdraw, editor, elRoot) {
    if (!cfg.alignment) {
      alignDebug.why = 'turned off in giteaDrawConfig';
      return;
    }
    const tool = editor.toolController.getMatchingTools?.(jsdraw.SelectionTool)?.[0];
    if (!tool || typeof tool.showContextMenu !== 'function') {
      alignDebug.why = 'js-draw has no selection tool with a context menu';
      return;
    }

    const order = createSelectionOrder();
    const highlight = createBaseHighlight(jsdraw, editor, tool, elRoot, order.getBase);
    const snapping = createDragSnapping(jsdraw, editor, tool, elRoot);
    const ctx = {
      editor, jsdraw, tool,
      getBase: order.getBase,
      getOrder: order.getOrder,
      nextBase: order.next,
      updateHighlight: highlight.update,
    };

    editor.notifier.on(jsdraw.EditorEventType.SelectionUpdated, (event) => {
      order.update(event.selectedComponents ?? []);
      snapping.attach(tool.getSelection?.());
      snapping.invalidate();
      highlight.update();
    });
    for (const kind of [
      jsdraw.EditorEventType.ViewportChanged,
      jsdraw.EditorEventType.CommandDone,
      jsdraw.EditorEventType.CommandUndone,
    ]) {
      editor.notifier.on(kind, () => {
        snapping.invalidate();
        highlight.update();
      });
    }

    // A drag is bracketed by these: js-draw handles the pointer on the canvas
    // itself, so by the time the event reaches here its own work is done.
    elRoot.addEventListener('pointerdown', () => {
      snapping.startDrag(tool.getSelection?.());
      highlight.startFollowing();
    });
    const endDrag = () => {
      snapping.endDrag();
      highlight.stopFollowing();
    };
    elRoot.addEventListener('pointerup', endDrag);
    elRoot.addEventListener('pointercancel', endDrag);

    // showContextMenu is an instance property js-draw reads when it builds a
    // selection, so replacing it here -- before anything can be selected --
    // covers both the "…" button and a right click.
    const showContextMenu = tool.showContextMenu;
    tool.showContextMenu = (anchor, preferSelectionMenu = true) => {
      const result = showContextMenu(anchor, preferSelectionMenu);
      // the menu's <dialog> is built and shown synchronously, so it is already
      // in the DOM; if js-draw ever changes that markup the entries silently do
      // not appear, which is the failure mode to prefer over a broken menu
      try {
        injectMenuEntries(ctx, elRoot);
      } catch {
        alignDebug.why = 'the selection menu no longer looks the way this expects';
      }
      return result;
    };

    alignDebug.hooked = true;
    alignDebug.why = '';
  }

  // ---------------------------------------------------------------- UML pens
  //
  // A class diagram tells its relationships apart by two things: the shape of
  // the head, and whether the line is solid or dashed.  js-draw has one
  // arrowhead -- a solid filled triangle, not configurable -- and no dashed
  // lines at all: a stroke's style is {fill, stroke: {color, width}}, with no
  // dash array anywhere.  So none of the six relationships below can be drawn
  // with the pens it ships, other than by hand.
  //
  // These go in through EditorSettings.pens.additionalPenTypes, which is public
  // API -- unlike the two hooks the alignment section above reaches for, this
  // cannot be broken by a js-draw internal changing.  The toolbar icons come
  // for free: js-draw generates one per pen by running the builder and drawing
  // the result.
  //
  // Each arrow is ONE stroke with ONE style, and that is a requirement rather
  // than a simplification.  The SVG renderer starts a new <path> wherever the
  // style changes, and the loader makes one component per <path>; a drawing
  // lives in the markdown as SVG text, so it makes that round trip every time
  // it is opened.  An arrow built out of two styles -- say a stroked shaft and
  // a filled head -- would come back as two components: two clicks to select,
  // two steps to undo, and the alignment feature above lining a head up against
  // its own shaft.
  //
  // So everything is filled geometry, the idiom js-draw's own arrow, line and
  // rectangle builders use.  The shaft is a quad, a dash is a shorter quad, and
  // a hollow head is a band: the outline, then the same outline inset and wound
  // backwards, which the default nonzero fill rule turns into a hole.

  // the six relationships, by head shape and line style
  const UML_PENS = [
    {id: 'uml-generalization', name: 'umlGeneralization', head: 'hollowTriangle', dashed: false},
    {id: 'uml-realization', name: 'umlRealization', head: 'hollowTriangle', dashed: true},
    {id: 'uml-composition', name: 'umlComposition', head: 'filledDiamond', dashed: false},
    {id: 'uml-aggregation', name: 'umlAggregation', head: 'hollowDiamond', dashed: false},
    {id: 'uml-association', name: 'umlAssociation', head: 'openArrow', dashed: false},
    {id: 'uml-dependency', name: 'umlDependency', head: 'openArrow', dashed: true},
  ];

  // How long each head is, as a multiple of the pen width.  A head is scaled
  // down when the arrow is too short to hold one at full size, the way js-draw's
  // own arrow does with Math.min(lineWidth, arrowLength / 2).  This is not
  // cosmetic: without it an arrow shorter than its head leaves no shaft, and
  // normalizing that zero-length shaft writes NaN into the path.  js-draw draws
  // a 113-unit arrow at the current thickness to make each pen's toolbar icon,
  // so a thick pen would hit it just by opening the toolbar.
  const UML_HEAD_LENGTHS = {hollowTriangle: 5, filledDiamond: 6, hollowDiamond: 6, openArrow: 4};

  const umlLineTo = (jsdraw, point) => ({kind: jsdraw.PathCommandType.LineTo, point});
  const umlMoveTo = (jsdraw, point) => ({kind: jsdraw.PathCommandType.MoveTo, point});

  // a closed polygon, appended to the command list `out`
  function umlPolygon(jsdraw, out, points) {
    out.push(umlMoveTo(jsdraw, points[0]));
    for (let i = 1; i < points.length; i++) out.push(umlLineTo(jsdraw, points[i]));
    out.push(umlLineTo(jsdraw, points[0]));
  }

  // Inset a convex polygon by `d`: offset every edge inwards, then intersect
  // each pair of neighbours, which is a miter join.
  function umlInsetPolygon(points, d) {
    const count = points.length;
    const centroid = points.reduce((acc, point) => acc.plus(point)).times(1 / count);
    const edges = points.map((point, i) => {
      const direction = points[(i + 1) % count].minus(point).normalized();
      let normal = direction.orthog();
      if (centroid.minus(point).dot(normal) < 0) normal = normal.times(-1);
      return {point: point.plus(normal.times(d)), direction};
    });
    return points.map((point, i) => {
      const previous = edges[(i - 1 + count) % count];
      const next = edges[i];
      const denominator = previous.direction.x * next.direction.y -
        previous.direction.y * next.direction.x;
      // parallel neighbours have no miter point; the offset corner is as close
      // as this gets, and a polygon that degenerate is not visible anyway
      if (Math.abs(denominator) < 1e-9) return next.point;
      const delta = next.point.minus(previous.point);
      const t = (delta.x * next.direction.y - delta.y * next.direction.x) / denominator;
      return previous.point.plus(previous.direction.times(t));
    });
  }

  // the outline of `points`, `w` wide, as a filled ring: the inner outline is
  // wound the other way, so the nonzero fill rule leaves the middle empty
  function umlBand(jsdraw, out, points, w) {
    umlPolygon(jsdraw, out, points);
    umlPolygon(jsdraw, out, umlInsetPolygon(points, w).reverse());
  }

  // a straight run from `from` to `to`, as a filled quad `w` wide
  function umlSegment(jsdraw, out, from, to, w) {
    if (to.distanceTo(from) < 1e-6) return;
    const normal = to.minus(from).normalized().orthog().times(w / 2);
    umlPolygon(jsdraw, out, [
      from.minus(normal), to.minus(normal), to.plus(normal), from.plus(normal),
    ]);
  }

  // umlSegment, broken into dashes
  function umlDashedSegment(jsdraw, out, from, to, w, dash) {
    const total = to.distanceTo(from);
    if (total < 1e-6) return;
    const direction = to.minus(from).normalized();
    for (let at = 0; at < total; at += dash * 2) {
      umlSegment(
        jsdraw, out,
        from.plus(direction.times(at)),
        from.plus(direction.times(Math.min(at + dash, total))),
        w,
      );
    }
  }

  // Each head draws itself at `tip` and returns how much of the shaft it covers,
  // so that a solid line does not show through a hollow head.  Open barbs cover
  // nothing: the line runs all the way to the point.
  const UML_HEADS = {
    // generalization, realization
    hollowTriangle(jsdraw, out, tip, direction, w) {
      const length = w * 5, half = w * 2.6;
      const normal = direction.orthog();
      const base = tip.minus(direction.times(length));
      umlBand(jsdraw, out, [
        tip, base.plus(normal.times(half)), base.minus(normal.times(half)),
      ], w * 0.9);
      return length;
    },
    // composition
    filledDiamond(jsdraw, out, tip, direction, w) {
      const length = w * 6, half = w * 1.9;
      const normal = direction.orthog();
      const back = tip.minus(direction.times(length));
      const waist = tip.minus(direction.times(length / 2));
      umlPolygon(jsdraw, out, [
        tip, waist.plus(normal.times(half)), back, waist.minus(normal.times(half)),
      ]);
      return length;
    },
    // aggregation
    hollowDiamond(jsdraw, out, tip, direction, w) {
      const length = w * 6, half = w * 1.9;
      const normal = direction.orthog();
      const back = tip.minus(direction.times(length));
      const waist = tip.minus(direction.times(length / 2));
      umlBand(jsdraw, out, [
        tip, waist.plus(normal.times(half)), back, waist.minus(normal.times(half)),
      ], w * 0.9);
      return length;
    },
    // association, dependency
    openArrow(jsdraw, out, tip, direction, w) {
      const length = w * 4, half = w * 2.2;
      const normal = direction.orthog();
      const base = tip.minus(direction.times(length));
      umlSegment(jsdraw, out, base.plus(normal.times(half)), tip, w);
      umlSegment(jsdraw, out, base.minus(normal.times(half)), tip, w);
      return 0;
    },
  };

  function makeUmlBuilder(jsdraw, pen) {
    return (startPoint, viewport) => {
      let endPoint = startPoint;

      const buildPreview = () => {
        const from = startPoint.pos;
        const tip = endPoint.pos;
        const w = Math.max(startPoint.width, endPoint.width);
        const distance = tip.distanceTo(from);
        const commands = [];
        if (distance > 1e-6) {
          const direction = tip.minus(from).normalized();
          const headWidth = Math.min(w, distance / (2 * UML_HEAD_LENGTHS[pen.head]));
          const covered = UML_HEADS[pen.head](jsdraw, commands, tip, direction, headWidth);
          const shaftEnd = tip.minus(direction.times(covered));
          if (pen.dashed) umlDashedSegment(jsdraw, commands, from, shaftEnd, w, w * 2.5);
          else umlSegment(jsdraw, commands, from, shaftEnd, w);
        }
        // rounding keeps the exported path free of long decimals -- this is
        // markdown that someone has to read in a diff
        const path = new jsdraw.Path(from, commands)
          .mapPoints((point) => viewport.roundPoint(point));
        return new jsdraw.Stroke([
          jsdraw.pathToRenderable(path, {fill: startPoint.color}),
        ]);
      };

      return {
        getBBox: () => buildPreview().getBBox(),
        build: buildPreview,
        preview: (renderer) => buildPreview().render(renderer),
        addPoint: (point) => { endPoint = point; },
      };
    };
  }

  // Every shape pen js-draw ships is wrapped in makeSnapToGridAutocorrect, which
  // is what snaps a shape to the grid when the pen is held still.  It is not
  // exported from the package, so it is reproduced here -- it is a thin wrapper
  // whose only call into js-draw, viewport.snapToGrid, is public.  Without it
  // these pens would behave differently from the ones beside them in the same
  // dropdown, for no reason a user could see.
  function withSnapToGrid(factory) {
    return (startPoint, viewport) => {
      const builder = factory(startPoint, viewport);
      const points = [startPoint];
      return {
        ...builder,
        addPoint: (point) => {
          points.push(point);
          builder.addPoint(point);
        },
        autocorrectShape: async () => {
          const snap = (point) => ({...point, pos: viewport.snapToGrid(point.pos)});
          const snapped = factory(snap(startPoint), viewport);
          for (const point of points) snapped.addPoint(snap(point));
          return snapped.build();
        },
      };
    };
  }

  function umlPenTypes(jsdraw) {
    return UML_PENS.map((pen) => ({
      id: pen.id,
      name: i18n[pen.name],
      isShapeBuilder: true,
      factory: withSnapToGrid(makeUmlBuilder(jsdraw, pen)),
    }));
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

  // the open board, so that giteaDrawDebug() can report on it
  let boardHistory = null;
  let boardEditor = null;

  async function openDrawingBoard({initialSvg, onSave, ignoreHistory = null}) {
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
      if (boardHistory) draw.recording?.remember(boardHistory.describe());
      boardHistory = null;
      boardEditor = null;
      editor?.remove();
      elOverlay.remove();
      document.body.classList.remove('markup-draw-open');
    };
    elOverlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // A <dialog> closes itself on Escape but does not stop the key event, so
      // without this, dismissing the selection menu would take the whole board
      // -- and the drawing -- with it.
      if (elOverlay.querySelector('dialog[open]')) return;
      close();
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
      pens: cfg.umlPens ? {additionalPenTypes: umlPenTypes(jsdraw)} : null,
      // the filled areas gitea-draw-fill.js adds are components of its own, and
      // this is what reads them back out of a stored drawing
      svg: {loaderPlugins: draw.filling?.loaderPlugins(jsdraw) ?? []},
    });
    setupAlignment(jsdraw, editor, elOverlay);
    // adds its tool, which has to happen before the toolbar is built below
    const filling = draw.filling?.create(jsdraw, editor, elOverlay) ?? null;

    // js-draw's edge toolbar is the one built for thumbs, so use it on narrow
    // screens and on any touch-first device regardless of its width
    const useEdgeToolbar = window.matchMedia(
      `(max-width: ${cfg.edgeToolbarMaxWidth}px), (pointer: coarse)`,
    ).matches;
    toolbar = useEdgeToolbar ? jsdraw.makeEdgeToolbar(editor) : jsdraw.makeDropdownToolbar(editor);
    toolbar.addDefaults();
    // beside the pens and the eraser, and before the stored state is read back
    // so that the colour and pattern last used come back with everything else
    filling?.addToToolbar(toolbar);
    restoreToolbarState(toolbar);
    toolbar.addExitButton(() => close());

    const {svg: baseSvg, stored} = splitHistory(initialSvg);
    const history = recorder()?.createHistory(jsdraw, editor, elOverlay) ?? null;

    toolbar.addSaveButton(async () => {
      const svgElem = await editor.toSVGAsync();
      let svgText = new XMLSerializer().serializeToString(svgElem);
      if (history) svgText = await history.attach(svgText);
      onSave(svgText);
      close();
    });

    // Replaying the log is the normal way in; loading the SVG is the fallback for
    // a drawing that has no log yet, or whose log cannot be trusted.
    if (ignoreHistory) history?.rejectStored(ignoreHistory);
    const journal = history && stored && !ignoreHistory ? await history.load(stored, baseSvg) : null;
    if (journal) {
      try {
        await history.replay(journal);
        restoreCanvasFrame(jsdraw, editor, baseSvg);
      } catch (err) {
        // A log that parsed but does not replay leaves the canvas half-built,
        // and js-draw has no way to empty an editor again -- loadFromSVG only
        // replaces the background and adds the rest on top.  Throwing the board
        // away and opening a fresh one straight from the SVG is the one recovery
        // that cannot leave a drawing showing a mixture of the two.
        close();
        await openDrawingBoard({
          initialSvg,
          onSave,
          ignoreHistory: `the recorded history could not be replayed (${err.message || err})`,
        });
        return;
      }
    } else {
      if (baseSvg.trim()) {
        // sanitize=true: the SVG was written by whoever wrote the markdown
        await editor.loadFromSVG(baseSvg, true);
      } else {
        // an opaque background keeps dark ink visible whatever theme the reader uses
        editor.dispatch(editor.setBackgroundStyle({
          color: jsdraw.Color4.white,
          type: jsdraw.BackgroundComponentBackgroundType.SolidColor,
          autoresize: true,
        }), false);
      }
      // The background is dispatched outside the undo stack, so it is invisible
      // to the recorder; adopting picks it up along with everything else and
      // makes the starting picture the log's own first command.
      history?.adopt();
    }
    history?.start();
    boardHistory = history;
    boardEditor = editor;
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

  // The file being edited, from the rename input when there is one, then from
  // the submitted tree path, and finally from the URL.  Gitea's editor markup
  // has changed shape across versions, the URL has not.
  function editedFileName(elForm) {
    const candidates = [
      elForm.querySelector('#file-name')?.value,
      elForm.querySelector('#tree_path, input[name="tree_path"]')?.value,
      decodeURIComponent(window.location.pathname),
    ];
    return (candidates.find((v) => v?.trim()) ?? '').trim().toLowerCase();
  }

  function isMarkdownFileName(name) {
    return cfg.markdownExtensions.some((ext) => name.endsWith(ext.toLowerCase()));
  }

  // Places the button without depending on the editor page layout, which differs
  // between Gitea versions: use whichever anchor this version happens to have.
  function placeFileEditorButton(elForm, elEditorNode, elButton) {
    const elOptions = elForm.querySelector('.code-editor-options');
    if (elOptions) { // current layout: with the indent / line-wrap controls
      elButton.classList.add('markup-draw-button-inline');
      elOptions.prepend(elButton);
      return;
    }
    // older layouts: after the write/preview/diff tab menu, whatever it is called
    const elMenu = elForm.querySelector('.repo-editor-menu') ??
      elForm.querySelector('[data-tab="write"]')?.closest('.menu');
    if (elMenu) {
      elButton.classList.add('markup-draw-button-standalone');
      elMenu.after(elButton);
      return;
    }
    // last resort: directly above the editor itself
    elButton.classList.add('markup-draw-button-standalone');
    elEditorNode.before(elButton);
  }

  // The repository file editor is Monaco and has no markdown toolbar of its own.
  // Drive it straight off window.codeEditors so that no assumption about the
  // surrounding markup is needed to find the editor.
  function initFileEditors() {
    for (const editor of window.codeEditors ?? []) {
      let elEditorNode = null;
      try {
        elEditorNode = editor.getContainerDomNode?.();
      } catch {
        continue; // disposed editor
      }
      if (!elEditorNode?.isConnected || !editor.getModel?.()) continue;

      const elForm = elEditorNode.closest('form');
      if (!elForm) continue;

      let elButton = elForm.querySelector('.markup-draw-button-file');
      if (!elButton) {
        elButton = makeButton('ui compact small button markup-draw-button-file', true);
        elButton.addEventListener('click', () => {
          const found = findMonacoEditor(elForm);
          if (!found) {
            window.alert(i18n.noEditor);
            return;
          }
          openForSource(monacoSource(found, elForm));
        });
        placeFileEditorButton(elForm, elEditorNode, elButton);
        elForm.querySelector('#file-name')?.addEventListener('input', () => scheduleInit());
      }

      // the file name can be changed while editing, and the fence only means
      // anything in a file rendered as markdown
      elButton.style.display = isMarkdownFileName(editedFileName(elForm)) ? '' : 'none';
    }
  }

  const describeRect = (rect) =>
    (rect ? {x: rect.x, y: rect.y, w: rect.w, h: rect.h} : null);

  // Paste giteaDrawDebug() in the browser console to find out what this script
  // sees on a page where the button does not show up.
  window.giteaDrawDebug = () => {
    const report = {
      // one entry per file that loaded, newest install first: each is cached on
      // its own, so one can be stale, or missing, while the others are current
      scripts: draw.scripts,
      // empty means gitea-draw.css did not load, or a stale copy did
      cssRevision: getComputedStyle(document.documentElement)
        .getPropertyValue('--markup-draw-css').trim() || '(not loaded)',
      config: cfg,
      giteaAssetVersion: window.config?.assetVersionEncoded ?? '(window.config missing)',
      jsDrawLoaded: Boolean(window.jsdraw?.Editor),
      // false after a board has been opened means the "Align…" and "Fit…"
      // entries are missing
      alignmentHooked: alignDebug.hooked,
      alignmentProblem: alignDebug.why,
      // the ids to look for under "Shape" in the pen dropdown
      umlPens: cfg.umlPens ? UML_PENS.map((pen) => pen.id) : [],
      // the fill tool: whether its button is there, what it is set to, and why
      // the last click on the canvas filled nothing
      filling: draw.filling?.status() ?? 'gitea-draw-fill.js did not load',
      // what the recorder is doing, or why it is not recording
      history: boardHistory
        ? boardHistory.describe()
        : (draw.recording?.status() ?? 'gitea-draw-history.js did not load'),
      // With a board open: where the drawing sits on the canvas against where
      // the board is looking.  A drawing that is not inside the view is what a
      // replay that forgot to restore the canvas frame looks like -- the board
      // opens on empty canvas somewhere else, with the drawing off to one side.
      // With a player open: how far through the log it is, and what is on the
      // canvas there.
      player: draw.playback?.state() ?? null,
      boardCanvas: boardEditor ? {
        drawing: describeRect(boardEditor.image.getImportExportRect()),
        visible: describeRect(boardEditor.viewport.visibleRect),
        autoresize: boardEditor.image.getAutoresizeEnabled(),
      } : null,
      // how many rendered drawings on this page carry a recorded history
      drawingsWithHistory: draw.recording
        ? [...document.querySelectorAll(CODE_SELECTOR)]
          .filter((el) => draw.recording.hasHistory(el.textContent ?? '')).length
        : null,
      codeEditors: (window.codeEditors ?? []).length,
      comboEditors: document.querySelectorAll('.combo-markdown-editor').length,
      markdownToolbars: document.querySelectorAll('.combo-markdown-editor markdown-toolbar').length,
      monacoContainers: document.querySelectorAll('.monaco-editor-container').length,
      editArea: Boolean(document.querySelector('#edit_area')),
      fileNameInput: document.querySelector('#file-name')?.value ?? null,
      codeEditorOptions: document.querySelectorAll('.code-editor-options').length,
      repoEditorMenu: document.querySelectorAll('.repo-editor-menu').length,
      writeTab: document.querySelectorAll('[data-tab="write"]').length,
      ourButtons: document.querySelectorAll('.markup-draw-button, .markup-draw-button-file').length,
      renderedDrawings: document.querySelectorAll('.markup-draw').length,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return report;
  };

  // ---------------------------------------------------------------- what the other three use
  //
  // Assigned here rather than where each is defined, so that the whole of what
  // gitea-draw-history.js, gitea-draw-playback.js and gitea-draw-fill.js are
  // allowed to reach is one list.  They destructure it as they load, which is
  // why this file has to be the one loaded first.

  Object.assign(draw, {
    // reaching the markdown behind a rendered drawing, and writing a fence back
    sourceForMarkup,
    findFenceByIndex,
    makeFence,
    // the board's own questions, asked inside the overlay rather than in a
    // browser dialog
    askChoice,
    askConfirmation,
    // js-draw, fetched on first use
    loadJsDraw,
    // reading a drawing's frame out of its SVG, and putting an editor back into it
    parseSvgFrame,
    restoreCanvasFrame,
    describeRect,
    SVG_NS,
  });

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
