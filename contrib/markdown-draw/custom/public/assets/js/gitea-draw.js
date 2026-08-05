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

  // bump when changing this file, giteaDrawDebug() reports it so that a stale
  // browser cache can be told apart from a real problem
  const SCRIPT_REVISION = '24';
  const scriptUrl = document.currentScript?.src ?? '(unknown)';

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
    // record everything Ctrl+Z can take back into the drawing, see the edit
    // history section
    history: true,
    // size of the stored log, in characters of the fence, past which it is
    // collapsed back to a snapshot of the drawing
    historyMaxChars: 256 * 1024,
    // ask before an undo reaches back into an earlier editing session
    historyConfirmUndo: true,
    // offer a play button on drawings that carry a recorded history
    playback: true,
    // longest pause, in ms, that playback acts out; a real one can be an hour
    playbackMaxGap: 1200,
    // beat inserted where one editing session ends and the next begins -- the
    // real gap there is days, and is captioned rather than waited out
    playbackSessionGap: 900,
    // floor, so a burst of fast commands is still something the eye can follow
    playbackMinStep: 40,
    // divides every wait, so 2 plays back twice as fast
    playbackSpeed: 1,
    // the export button: a self-playing SVG plus a video, both library-free
    exportAnimation: true,
    // video bitrate, and how long the finished drawing is held at the end
    exportBitrate: 4_000_000,
    exportTailMs: 1200,
    // base name for the two downloaded files
    exportName: 'drawing-history',
    // whether a finished export is offered with a question rather than simply
    // downloaded: 'auto' asks only once the click that started it has lapsed,
    // which is when a browser stops acting on a download by itself; 'always'
    // asks every time, 'never' relies on the download alone
    exportAskBeforeSaving: 'auto',
    ...(window.giteaDrawConfig ?? {}),
  };

  const TICKS = '```';
  const CODE_SELECTOR = `.markup code.language-${cfg.lang}`;
  const ATTR_RENDERED = 'data-markup-draw-rendered';
  const ATTR_BUTTON = 'data-markup-draw-button';
  const ATTR_ALIGN_MENU = 'data-markup-draw-align';
  const TOOLBAR_STATE_KEY = 'gitea-draw-toolbar-state';

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
    undoAcross: 'Undo an earlier edit?',
    undoAcrossFrom: (when) => `The next undo takes back work from ${when}, not from this editing session.`,
    undoAcrossUnknown: 'The next undo takes back the drawing as it was before this editing session.',
    undoAcrossConfirm: 'Undo it',
    undoAcrossCancel: 'Keep it',
    play: 'Play the edit history',
    // The control bar has to fit a phone, so everything that can be a glyph is
    // one; the words move into the tooltip and the accessible name.  U+FE0E asks
    // for the text rendering of glyphs a browser would otherwise turn into a
    // colour emoji.
    playPauseIcon: '\u23F8\uFE0E',
    playPause: 'Pause',
    playIcon: '\u25B6\uFE0E',
    playResume: 'Play',
    playRestartIcon: '\u21BA',
    playRestart: 'Restart',
    playCloseIcon: '\u238B',
    playClose: 'Close',
    playFailed: 'This drawing\'s edit history could not be played back',
    playFound: 'The drawing as it was found',
    playNextSession: 'A later editing session',
    playMoments: 'Moments later',
    playDone: 'End of the recorded history',
    playBackIcon: '\u23EE\uFE0E',
    playBack: 'Back one step',
    playForwardIcon: '\u23ED\uFE0E',
    playForward: 'Forward one step',
    playStep: (at, total) => `${at} / ${total}`,
    playDeleteIcon: '\u2702\uFE0EStep',
    playDelete: 'Delete this step',
    playDeleteBlocked: (why) => `This step cannot be removed: ${why}`,
    playDeletedWith: (n) => `${n} steps removed`,
    stepStroke: 'a stroke',
    stepText: 'a piece of text',
    stepImage: 'an image',
    stepBackground: 'the background',
    stepShape: 'an imported shape',
    stepErase: 'an erase',
    stepMove: 'a move or resize',
    stepDuplicate: 'a duplicate',
    stepReshape: 'a reshaped element',
    stepGroup: (n) => `a group of ${n} changes`,
    stepSomething: 'this step',
    deleteStepWithDeps: (what, n) =>
      `Delete ${what} and the ${n === 1 ? 'one' : n} that ${n === 1 ? 'builds' : 'build'} on it?`,
    deleteStepWithDepsBody: (n, list) =>
      `${n === 1 ? 'Step' : 'Steps'} ${list} ${n === 1 ? 'uses' : 'use'} what this one draws, and cannot be replayed without it, so ${n === 1 ? 'it goes' : 'they go'} too. Nothing reaches the markdown until you save.`,
    deleteConfirm: 'Delete',
    deleteCancel: 'Keep it',
    playSaveIcon: 'Save',
    playExportIcon: '\u2913',
    playExport: 'Download the animation',
    playExportBody: 'Both are built here in the browser, with no server and no library.',
    playExportSvg: 'Animated SVG',
    playExportSvgHint: 'Plays by itself wherever an image can go. Ready at once.',
    playExportVideo: 'Video (MP4 or WebM)',
    playExportVideoHint: (seconds) =>
      `Plays anywhere. Recorded as it plays, so it takes about ${seconds}s.`,
    playExportVideoUnavailable: 'This browser cannot record video',
    playExportCancel: 'Not now',
    playBuildingSvg: 'Building the SVG',
    playRecording: 'Recording',
    playExportSaved: (name) => `${name} downloaded`,
    playExportReady: (name) => `${name} is ready`,
    playExportReadyBody: 'It took long enough to build that the browser will not save it on its own any more.',
    playExportSaveNow: 'Save it',
    playExportSaveNowHint: 'Downloads the file you just built.',
    playExportDiscard: 'Throw it away',
    playExportStopped: 'Export stopped',
    playExportFailed: (why) => `The animation could not be exported: ${why}`,
    playSave: 'Save to markdown',
    playSaved: 'Saved to the markdown',
    playSaveGone: 'This drawing is no longer in the text, so it was not saved',
    playDiscard: 'Discard the changes?',
    playDiscardBody: 'This drawing\'s history has been edited but not saved. Closing now leaves the markdown as it was.',
    playDiscardConfirm: 'Discard them',
    playDiscardCancel: 'Keep editing',
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

  // ---------------------------------------------------------------- edit history
  //
  // Every action Ctrl+Z can take back is written into the drawing itself, so the
  // undo stack outlives the browser tab: reopening a drawing restores the stack
  // it was closed with, and the same log is a script of how the drawing was made.
  //
  // What is recorded is exactly what enters js-draw's UndoRedoHistory -- panning
  // and zooming dispatch with `addToHistory` false, so "undoable" and "recorded"
  // are the same set by construction rather than by a rule kept in step by hand.
  // `UndoRedoStackUpdated` carries the command *and* which of done/undone/redone
  // happened, so one listener sees all three; `CommandDone` on its own cannot
  // tell a fresh command from a redone one.
  //
  // The log is a complete script starting from an empty canvas, never a patch on
  // top of the SVG.  js-draw forces that: component ids survive
  // serialize/deserialize but not an SVG round trip -- js-draw writes no ids into
  // its SVG and SVGLoader makes fresh ones on the way back -- so a command
  // recorded against an SVG-loaded image would, next time, name a component that
  // no longer exists.  Replaying from JSON keeps every id, and the drawing that
  // comes out is the drawing that went in.  The SVG in the fence stays the thing
  // that renders, and is regenerated from the replayed state on every save.

  const HISTORY_VERSION = 1;
  const HISTORY_MARK = 'gitea-draw-history';

  // entry shapes, kept numeric because an unsupported browser stores them as
  // plain base64 JSON with no compression to hide the verbosity
  const OP_SESSION = 0; // [0, startedAt | null]  -- a board was opened
  const OP_DO = 1; //      [1, dt, commandJson]
  const OP_UNDO = 2; //    [2, dt]
  const OP_REDO = 3; //    [3, dt]

  const historyRegExp = () =>
    new RegExp(`<!--${HISTORY_MARK}:(\\d+):([a-z]):([A-Za-z0-9+/=]*)-->`);

  // --- payload framing
  //
  // The log rides inside the SVG, as an XML comment just before </svg>.  That
  // keeps one fence equal to one self-contained drawing: copying the fence takes
  // the history with it, and every renderer -- Gitea's, GitHub's, an e-mail
  // client's -- ignores a comment, so nothing anywhere shows a wall of base64.
  // The payload is base64, which cannot contain the "--" that would end the
  // comment early.

  function splitHistory(svgText) {
    const match = historyRegExp().exec(svgText);
    if (!match) return {svg: svgText, stored: null};
    return {
      svg: svgText.slice(0, match.index) + svgText.slice(match.index + match[0].length),
      stored: {version: Number(match[1]), codec: match[2], data: match[3]},
    };
  }

  function attachHistory(svgText, stored) {
    const close = svgText.lastIndexOf('</svg>');
    if (close < 0) return svgText;
    const comment = `<!--${HISTORY_MARK}:${HISTORY_VERSION}:${stored.codec}:${stored.data}-->`;
    return svgText.slice(0, close) + comment + svgText.slice(close);
  }

  const bytesToBase64 = (bytes) => {
    let binary = '';
    // in chunks: String.fromCharCode(...bytes) blows the argument limit on a
    // drawing of any size
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  const base64ToBytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  // CompressionStream is native everywhere this matters; where it is missing the
  // log is still written, just uncompressed, and the codec letter says which.
  async function packHistory(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof CompressionStream !== 'function') return {codec: 'p', data: bytesToBase64(bytes)};
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return {codec: 'z', data: bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()))};
  }

  async function unpackHistory(codec, data) {
    const bytes = base64ToBytes(data);
    if (codec === 'p') return new TextDecoder().decode(bytes);
    if (codec !== 'z') throw new Error(`unknown history encoding "${codec}"`);
    if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot decompress the history');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }

  // FNV-1a.  Only ever compared against itself, and only to notice that the SVG
  // was changed by something that is not this script -- a hand edit in the
  // markdown, another tool, a merge resolution.  Replaying a log against a
  // drawing it did not produce would quietly throw that edit away, so a mismatch
  // drops the log and keeps the text.
  function svgFingerprint(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  // --- sanitising a recorded command
  //
  // A log is markdown written by whoever wrote the drawing, so it is exactly as
  // hostile as the SVG beside it -- and the JSON way into js-draw is guarded
  // *less* than the SVG way: ImageComponent.deserializeFromJSON assigns `src`
  // straight through, while its SVG loader forces `data:image/` and re-encodes
  // anything else through a canvas.  Left alone, a recorded drawing would fetch
  // a URL of its author's choosing from every reader who opened the board.

  const SAFE_IMAGE_SRC = /^data:image\//i;
  // 1x1 transparent PNG, so a blocked image leaves a hole rather than an error
  const BLANK_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function sanitizeCommandJson(value, report, depth = 0) {
    if (depth > 64) throw new Error('recorded command is nested too deeply');
    if (Array.isArray(value)) return value.map((item) => sanitizeCommandJson(item, report, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // js-draw refuses to restore loadSaveData -- AbstractComponent.deserialize
      // says why -- so carrying it is pure weight, and for a drawing adopted from
      // an SVG it is a second copy of every source attribute.
      if (key === 'loadSaveData') continue;
      if ((key === 'src' || key === 'base64Url') && typeof item === 'string' && !SAFE_IMAGE_SRC.test(item)) {
        report.blockedImages++;
        out[key] = BLANK_IMAGE;
        continue;
      }
      out[key] = sanitizeCommandJson(item, report, depth + 1);
    }
    return out;
  }

  // --- the recorder
  //
  // One of these is built per board.  It owns the log, replays a stored one into
  // the editor, keeps track of which editing session every command on the live
  // undo stack came from, and writes the log back out on save.

  const historyDebug = {state: 'no drawing board opened yet'};

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

  function createHistory(jsdraw, editor, elOverlay) {
    const entries = []; // the whole log, oldest first
    const sessions = []; // when each session started; null means "not known"
    const report = {blockedImages: 0};
    const confirmed = new Set(); // sessions the reader already agreed to undo into
    let stackSessions = []; // which session each command on the live undo stack came from
    let redoSessions = []; // ... and on the redo stack
    let current = -1; // the session commands are being attributed to right now
    let live = -1; // this board's own session
    let liveEmitted = false; // its OP_SESSION entry is written on first use, not on open
    let recording = false;
    let replaying = false;
    let compact = false; // the stored log was over budget: start again from a snapshot
    let problem = null; // recording is off and the drawing will be saved without a log
    let note = null; // a stored log was rejected; recording carries on from scratch
    let lastAt = 0;

    const now = () => performance.now();

    // Two very different failures, and conflating them loses drawings' histories.
    //
    // A stored log that cannot be used -- wrong version, corrupt, or describing
    // some other SVG -- is recoverable: the drawing loads from its SVG and a
    // fresh log starts from there, exactly as it does for a drawing made before
    // any of this existed.  Only the reason is worth reporting.
    function reject(why) {
      note ??= why;
    }

    // A command that cannot be serialized is not recoverable: everything after it
    // would replay onto a different picture.  The log stops dead rather than
    // drifting, the drawing is saved without one, and the next open adopts it.
    function giveUp(why) {
      problem ??= why;
    }

    function record(op, command) {
      if (problem) return;
      if (!liveEmitted) {
        entries.push([OP_SESSION, sessions[live]]);
        liveEmitted = true;
      }
      const at = now();
      // rounded: 10ms is finer than anyone draws, and fewer distinct values
      // compress much better
      const dt = Math.max(0, Math.round((at - lastAt) / 10) * 10);
      lastAt = at;
      if (op !== OP_DO) {
        entries.push([op, dt]);
        return;
      }
      let json;
      try {
        json = command.serialize();
      } catch (err) {
        giveUp(`a command could not be recorded (${err.message || err})`);
        return;
      }
      entries.push([OP_DO, dt, json]);
    }

    // js-draw caps its own undo stack at 700 and drops the oldest; the log keeps
    // them, so the two lengths have to be reconciled rather than assumed equal.
    function trim(undoSize, redoSize) {
      if (stackSessions.length > undoSize) stackSessions = stackSessions.slice(-undoSize);
      if (redoSessions.length > redoSize) redoSessions = redoSessions.slice(-redoSize);
    }

    editor.notifier.on(jsdraw.EditorEventType.UndoRedoStackUpdated, (event) => {
      const kind = event.stackUpdateType;
      if (kind === jsdraw.UndoEventType.CommandDone) {
        stackSessions.push(current);
        redoSessions = [];
        if (recording) record(OP_DO, event.command);
      } else if (kind === jsdraw.UndoEventType.CommandUndone) {
        redoSessions.push(stackSessions.pop() ?? current);
        if (recording) record(OP_UNDO);
      } else if (kind === jsdraw.UndoEventType.CommandRedone) {
        stackSessions.push(redoSessions.pop() ?? current);
        if (recording) record(OP_REDO);
      }
      trim(event.undoStackSize, event.redoStackSize);
    });

    // Everything on the canvas as one command, without applying it: used both to
    // adopt a drawing made before there was any recording, and to restart a log
    // that has outgrown its budget.  getAllComponents leaves the background out,
    // so it is fetched separately -- otherwise a replayed drawing would come back
    // transparent.  Each component carries its own z-index through serialization,
    // so the order here only has to be complete, not sorted.
    function snapshot() {
      const components = [
        ...editor.image.getBackgroundComponents(),
        ...editor.image.getAllComponents(),
      ];
      if (!components.length) return null;
      return jsdraw.uniteCommands(components.map((c) => jsdraw.EditorImage.addComponent(c)));
    }

    function adopt() {
      const command = snapshot();
      if (!command) return;
      let json;
      try {
        json = command.serialize();
      } catch (err) {
        giveUp(`this drawing could not be recorded (${err.message || err})`);
        return;
      }
      // Its own session, with no time: this is the drawing as it was found, and
      // when it was actually made is not something the file can say.
      sessions.push(null);
      current = sessions.length - 1;
      entries.push([OP_SESSION, null], [OP_DO, 0, json]);
      // The components are already on the canvas, so this only puts the command
      // on the undo stack.  Without it, "undo past the start of this session"
      // would do nothing in the session that adopts a drawing and everything in
      // every later one.
      editor.history.push(command, false);
    }

    async function replay(journal) {
      replaying = true;
      try {
        for (const entry of journal.e) {
          const op = entry?.[0];
          if (op === OP_SESSION) {
            sessions.push(typeof entry[1] === 'number' ? entry[1] : null);
            current = sessions.length - 1;
            entries.push([OP_SESSION, sessions[current]]);
          } else if (op === OP_DO) {
            // sanitised on the way in and kept that way: what is written back is
            // the cleaned command, so a hostile payload is defused once and for all
            const json = sanitizeCommandJson(entry[2], report);
            // push, not dispatch: dispatch announces every command to a screen
            // reader, and a few hundred replayed strokes would be a scream
            editor.history.push(jsdraw.SerializableCommand.deserialize(json, editor), true);
            entries.push([OP_DO, entry[1] ?? 0, json]);
          } else if (op === OP_UNDO) {
            await editor.history.undo();
            entries.push([OP_UNDO, entry[1] ?? 0]);
          } else if (op === OP_REDO) {
            await editor.history.redo();
            entries.push([OP_REDO, entry[1] ?? 0]);
          }
        }
      } finally {
        replaying = false;
      }
    }

    // Reads a stored payload, or explains why it will not be used.  Returning
    // null is never fatal: the caller falls back to loading the SVG, which is
    // what happened before any of this existed.
    async function load(stored, baseSvg) {
      if (stored.version !== HISTORY_VERSION) {
        reject(`the recorded history is version ${stored.version}, this script reads ${HISTORY_VERSION}`);
        return null;
      }
      let journal;
      try {
        journal = JSON.parse(await unpackHistory(stored.codec, stored.data));
      } catch (err) {
        reject(`the recorded history could not be read (${err.message || err})`);
        return null;
      }
      if (!journal || !Array.isArray(journal.e)) {
        reject('the recorded history is not in the expected shape');
        return null;
      }
      if (journal.h && journal.h !== svgFingerprint(baseSvg)) {
        reject('the drawing was edited outside the board, so its history no longer describes it');
        return null;
      }
      // Over budget already: this session's edits are kept, everything older is
      // replaced by a snapshot when it is saved.
      if (stored.data.length > cfg.historyMaxChars) compact = true;
      return journal;
    }

    // --- undoing past the start of this session
    //
    // Restoring the stack means a reader can Ctrl+Z away work somebody else did
    // days ago, which was simply impossible before.  Asking once per session
    // crossed keeps that deliberate without nagging.

    function askBeforeUndo(session, proceed) {
      const at = sessions[session];
      askConfirmation(elOverlay, {
        title: i18n.undoAcross,
        body: typeof at === 'number'
          ? i18n.undoAcrossFrom(new Date(at).toLocaleString())
          : i18n.undoAcrossUnknown,
        confirm: i18n.undoAcrossConfirm,
        cancel: i18n.undoAcrossCancel,
        onConfirm: () => {
          confirmed.add(session);
          proceed();
        },
      });
    }

    // Both the toolbar button and Ctrl+Z call editor.history.undo(), so shadowing
    // it on the instance covers both.  It is a prototype method, replaced here
    // only on this board's own history object.
    function guardUndo() {
      const original = editor.history.undo.bind(editor.history);
      editor.history.undo = () => {
        if (replaying || !cfg.historyConfirmUndo) return original();
        const owner = stackSessions[stackSessions.length - 1];
        if (owner === undefined || owner === live || confirmed.has(owner)) return original();
        askBeforeUndo(owner, original);
        return undefined;
      };
    }

    return {
      load,
      replay,
      adopt,
      rejectStored: reject,

      // Starts recording.  Everything before this -- replaying a stored log,
      // adopting an SVG -- is setup, and must not be recorded as if the reader
      // had just done it.
      start() {
        sessions.push(Date.now());
        live = sessions.length - 1;
        current = live;
        lastAt = now();
        recording = true;
        guardUndo();
        historyDebug.state = problem ? `not recording: ${problem}` : 'recording';
      },

      // Called with the SVG js-draw just produced; returns it with the log
      // attached, or unchanged when there is nothing trustworthy to attach.
      async attach(svgText) {
        if (problem) {
          // eslint-disable-next-line no-console
          console.warn(`markdown-draw: saved without an edit history -- ${problem}`);
          return svgText;
        }
        let list = entries;
        if (compact) {
          // Collapse to the drawing as it stands.  Keeping only this session's
          // entries on top of a snapshot taken at open would be nicer, but an
          // undo from this session can reach back past that snapshot, and a log
          // that cannot be replayed is worse than a short one.
          const command = snapshot();
          if (!command) return svgText;
          try {
            list = [[OP_SESSION, null], [OP_DO, 0, command.serialize()]];
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`markdown-draw: saved without an edit history -- ${err.message || err}`);
            return svgText;
          }
        }
        if (!list.length) return svgText;
        const stored = await packHistory(JSON.stringify({
          v: HISTORY_VERSION, h: svgFingerprint(svgText), e: list,
        }));
        // Still too big after collapsing: the drawing itself is the size problem,
        // and doubling the fence to say so helps nobody.
        if (compact && stored.data.length > cfg.historyMaxChars) {
          // eslint-disable-next-line no-console
          console.warn('markdown-draw: this drawing is too large to carry an edit history');
          return svgText;
        }
        return attachHistory(svgText, stored);
      },

      describe: () => ({
        entries: entries.length,
        sessions: sessions.length,
        commands: entries.filter((e) => e[0] === OP_DO).length,
        undoStack: stackSessions.length,
        blockedImages: report.blockedImages,
        compacted: compact,
        // why a stored log was not used; recording carries on regardless
        rejected: note,
        // set only when this drawing will be saved without any log at all
        problem,
      }),
    };
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
    // wherever it is rendered -- there is no editor involved.
    if (stored && cfg.playback) {
      const elPlay = document.createElement('button');
      elPlay.type = 'button';
      elPlay.className = 'ui tiny basic button markup-draw-play';
      elPlay.textContent = `▶ ${i18n.play}`;
      // elMarkup is passed so the player can find the text behind the drawing:
      // where there is one, its steps can be edited and written back.
      elPlay.addEventListener('click', () => void playDrawing(source, elMarkup ? {elMarkup, elContainer} : null));
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
  // ... and the open player
  let playerState = null;

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
      if (boardHistory) historyDebug.state = `last board: ${JSON.stringify(boardHistory.describe())}`;
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
    });
    setupAlignment(jsdraw, editor, elOverlay);

    // js-draw's edge toolbar is the one built for thumbs, so use it on narrow
    // screens and on any touch-first device regardless of its width
    const useEdgeToolbar = window.matchMedia(
      `(max-width: ${cfg.edgeToolbarMaxWidth}px), (pointer: coarse)`,
    ).matches;
    toolbar = useEdgeToolbar ? jsdraw.makeEdgeToolbar(editor) : jsdraw.makeDropdownToolbar(editor);
    toolbar.addDefaults();
    restoreToolbarState(toolbar);
    toolbar.addExitButton(() => close());

    const {svg: baseSvg, stored} = splitHistory(initialSvg);
    const history = cfg.history ? createHistory(jsdraw, editor, elOverlay) : null;

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

  // ---------------------------------------------------------------- playback
  //
  // The same log the board replays to restore an undo stack is a script of how
  // the drawing was made, so a rendered drawing can play it back.
  //
  // Playback runs only on a click, never on its own: it deserializes the same
  // attacker-written JSON the board does, and a page full of drawings must not
  // do that merely by being looked at.  It goes through the same sanitizer.

  const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  // The gap between two sessions is real time -- days, sometimes weeks -- and is
  // never played out; it is said instead, which is what the absolute anchors in
  // the log are for.
  function describeGap(ms) {
    const say = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} later`;
    if (ms < 2 * MINUTE) return i18n.playMoments;
    if (ms < HOUR) return say(Math.round(ms / MINUTE), 'minute');
    if (ms < DAY) return say(Math.round(ms / HOUR), 'hour');
    if (ms < 30 * DAY) return say(Math.round(ms / DAY), 'day');
    return say(Math.round(ms / (30 * DAY)), 'month');
  }

  // How long each session lasted, so a gap can be measured from the end of one
  // to the start of the next rather than from start to start.
  function sessionGaps(entries) {
    const gaps = new Map();
    let index = -1, startedAt = null, elapsed = 0, previousEnd = null;
    for (const entry of entries) {
      if (entry[0] !== OP_SESSION) {
        elapsed += entry[1] ?? 0;
        continue;
      }
      if (startedAt !== null) previousEnd = startedAt + elapsed;
      index++;
      startedAt = typeof entry[1] === 'number' ? entry[1] : null;
      elapsed = 0;
      if (index === 0 || startedAt === null || previousEnd === null) continue;
      // clocks on two machines need not agree, so a gap can come out negative
      gaps.set(index, Math.max(0, startedAt - previousEnd));
    }
    return gaps;
  }

  // ---------------------------------------------------------------- export
  //
  // One click, two files: a self-playing SVG and a video.  Neither needs a
  // library, which is why they are the two on offer.
  //
  // SMIL animation is declarative and, unlike script, it runs inside an <img> --
  // checked, not assumed -- so a self-playing drawing stays on exactly the
  // rendering path and trust model a still one is on.  The video comes off a
  // canvas through MediaRecorder, which needs nothing either.  A GIF would be
  // the odd one out: browsers ship no GIF encoder at all (toBlob('image/gif')
  // quietly hands back a PNG), so it would mean vendoring one, and this
  // customization deliberately carries no dependency but js-draw.

  // How long each step is held, mirroring the player exactly so that what was
  // watched is what comes out.
  function stepDurations(entries) {
    return entries.map((entry, at) => {
      if (at >= entries.length - 1) return 0;
      const gap = entry[0] === OP_SESSION
        ? cfg.playbackSessionGap
        : Math.max(cfg.playbackMinStep, Math.min(entry[1] ?? 0, cfg.playbackMaxGap));
      return gap / cfg.playbackSpeed;
    });
  }

  // A second editor to replay into, so exporting does not disturb the one being
  // watched.  Off to the side rather than display:none, because js-draw measures
  // its container and a box of no size renders nothing.
  async function withScratchEditor(jsdraw, svgText, work) {
    const elHost = document.createElement('div');
    elHost.className = 'markup-draw-export-host';
    document.body.append(elHost);
    let editor = null;
    try {
      editor = new jsdraw.Editor(elHost, {wheelEventsEnabled: false});
      restoreCanvasFrame(jsdraw, editor, svgText);
      // Pin the canvas to the finished drawing.  Left to autoresize it would
      // grow as the replay adds strokes, so every component would be rendered
      // against a different viewport and the video would shift about under the
      // drawing.  The stored SVG already describes the frame we want.
      try {
        const {viewBox} = parseSvgFrame(svgText);
        if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
          const rect = new jsdraw.Rect2(viewBox.x, viewBox.y, viewBox.width, viewBox.height);
          // setImportExportRect turns autoresize off, which is the point
          editor.dispatchNoAnnounce(editor.image.setImportExportRect(rect), false);
          editor.dispatchNoAnnounce(editor.viewport.zoomTo(rect), false);
        }
      } catch {
        // no usable frame in the SVG; the export still works, just unpinned
      }
      return await work(editor);
    } finally {
      editor?.remove();
      elHost.remove();
    }
  }

  // Replays the log a step at a time, telling the caller which components each
  // step touched.  The ids come from the commands themselves rather than from
  // comparing the whole image every step, which keeps it linear.
  const EXPORT_STOPPED = 'markdown-draw:export-stopped';

  async function replayForExport(jsdraw, editor, entries, onStep) {
    const report = {blockedImages: 0};
    let taken = [];
    const listener = editor.notifier.on(jsdraw.EditorEventType.UndoRedoStackUpdated, (event) => {
      if (event.command) taken.push(event.command);
    });
    try {
      for (const [at, entry] of entries.entries()) {
        taken = [];
        if (entry[0] === OP_DO) {
          editor.history.push(
            jsdraw.SerializableCommand.deserialize(sanitizeCommandJson(entry[2], report), editor), true,
          );
        } else if (entry[0] === OP_UNDO) {
          await editor.history.undo();
        } else if (entry[0] === OP_REDO) {
          await editor.history.redo();
        }
        const touched = new Set();
        for (const command of taken) {
          try {
            const refs = commandRefs(command.serialize());
            for (const id of [...refs.makes, ...refs.needs]) touched.add(id);
          } catch {
            // a command that will not serialize tells us nothing; the membership
            // check below still catches what it added or removed
          }
        }
        await onStep(at, touched);
      }
    } finally {
      listener?.remove?.();
    }
  }

  const componentsById = (editor) => new Map(
    [...editor.image.getBackgroundComponents(), ...editor.image.getAllComponents()]
      .map((component) => [component.getId(), component]),
  );

  // Builds one SVG in which every element appears (and disappears) at the time it
  // did.  A component is drawn again whenever a step touches it -- a move changes
  // the path itself, so the old drawing is hidden and a new one shown, which is
  // both simpler and more general than trying to animate the change.
  function buildAnimatedSvg(jsdraw, editor, entries, durations, finalSvg) {
    const viewport = editor.image.getImportExportViewport();
    const doc = new DOMParser().parseFromString(finalSvg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error(i18n.invalidSvg);
    const root = doc.documentElement;
    // keep the attributes and any stylesheet js-draw emitted, drop the picture
    for (const node of [...root.childNodes]) {
      if (node.nodeType !== 1 || !['style', 'defs'].includes(node.nodeName.toLowerCase())) node.remove();
    }

    const at = (ms) => `${(ms / 1000).toFixed(2)}s`;
    const marker = (to, ms) => {
      const el = doc.createElementNS(SVG_NS, 'set');
      el.setAttribute('attributeName', 'display');
      el.setAttribute('to', to);
      el.setAttribute('begin', at(ms));
      return el;
    };

    const groups = new Map();
    let previous = new Map();
    let clock = 0;

    const render = (component) => {
      const {element, renderer} = jsdraw.SVGRenderer.fromViewport(viewport, {
        sanitize: true, useViewBoxForPositioning: true,
      });
      component.render(renderer);
      return [...element.childNodes].map((node) => doc.importNode(node, true));
    };

    return {
      step(index, touched, current) {
        const ids = new Set(touched);
        for (const id of current.keys()) if (!previous.has(id)) ids.add(id);
        for (const id of previous.keys()) if (!current.has(id)) ids.add(id);
        for (const id of ids) {
          const open = groups.get(id);
          if (open) {
            open.append(marker('none', clock));
            groups.delete(id);
          }
          const component = current.get(id);
          if (!component) continue;
          const group = doc.createElementNS(SVG_NS, 'g');
          // at time zero there is nothing to wait for, and a hidden-then-shown
          // group would flash on browsers that paint before the timeline starts
          if (clock > 0) {
            group.setAttribute('display', 'none');
            group.append(marker('inline', clock));
          }
          group.append(...render(component));
          groups.set(id, group);
          root.append(group);
        }
        previous = current;
        clock += durations[index] ?? 0;
      },
      finish: () => new XMLSerializer().serializeToString(doc),
    };
  }

  // The video is the editor's own canvas, recorded as it is replayed.  There is
  // no faster-than-real-time path: MediaRecorder encodes a live stream, so this
  // takes about as long as watching it does.
  async function recordAnimation(elCanvas, durations, onFrame, onProgress) {
    if (typeof MediaRecorder === 'undefined' || typeof elCanvas.captureStream !== 'function') return null;
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mime) return null;

    // 0 frames a second means "only the ones asked for", so the recording holds
    // each step for as long as the drawing did rather than however long a render
    // happened to take
    const stream = elCanvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: cfg.exportBitrate});
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();

    await onFrame(async (index) => {
      // js-draw paints on an animation frame, so the canvas is a frame behind
      // until one has gone by
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      track.requestFrame();
      const hold = durations[index] ?? 0;
      onProgress?.(index);
      if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    });

    // hold the finished drawing, so it does not end the instant the last stroke lands
    await new Promise((resolve) => setTimeout(resolve, cfg.exportTailMs));
    track.requestFrame();
    await new Promise((resolve) => setTimeout(resolve, 200));
    recorder.stop();
    await stopped;
    if (!chunks.length) return null;
    return new Blob(chunks, {type: mime});
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const elLink = document.createElement('a');
    elLink.href = url;
    elLink.download = name;
    document.body.append(elLink);
    elLink.click();
    elLink.remove();
    // long enough for the browser to have taken it; revoking at once loses the file
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // --- what a step does, and what later steps need it to have happened
  //
  // Every recorded command names the components it works on by id, so what one
  // step needs from another can be read straight out of the log without applying
  // any of it.  The six command types js-draw registers each carry those ids
  // somewhere different; `union` and `inverse` wrap another command and are
  // walked into.

  // how many times a deletion may be replayed while working out what goes with
  // it; past this something is wrong with the log rather than with the deletion
  const MAX_DELETE_PROBES = 50;

  const COMPONENT_WORDS = {
    'stroke': 'stepStroke',
    'text': 'stepText',
    'image-component': 'stepImage',
    'image-background': 'stepBackground',
    'unknown-svg-object': 'stepShape',
    'svg-global-attributes': 'stepShape',
  };

  function commandRefs(json, into = {makes: new Set(), needs: new Set()}, depth = 0) {
    if (depth > 32 || !json || typeof json !== 'object') return into;
    const data = json.data;
    switch (json.commandType) {
      case 'union':
        for (const child of Array.isArray(data?.data) ? data.data : []) {
          commandRefs(child, into, depth + 1);
        }
        break;
      case 'inverse': {
        // An inverse undoes what it wraps, so what that one makes, this one
        // needs.  Counting both as "needs" keeps the analysis on the safe side:
        // it can flag a step as dependent that would have survived, never the
        // other way round.
        const inner = commandRefs(data, {makes: new Set(), needs: new Set()}, depth + 1);
        for (const id of [...inner.makes, ...inner.needs]) into.needs.add(id);
        break;
      }
      case 'add-element':
        if (data?.elemData?.id) into.makes.add(String(data.elemData.id));
        break;
      case 'transform-element':
        if (data?.id) into.needs.add(String(data.id));
        break;
      case 'selection-tool-transform':
        for (const id of Array.isArray(data?.elems) ? data.elems : []) into.needs.add(String(id));
        break;
      case 'erase':
        for (const elem of Array.isArray(data) ? data : []) {
          const id = typeof elem === 'string' ? elem : elem?.id;
          if (id) into.needs.add(String(id));
        }
        break;
      case 'duplicate':
        for (const id of Array.isArray(data?.originalIds) ? data.originalIds : []) into.needs.add(String(id));
        for (const id of Array.isArray(data?.cloneIds) ? data.cloneIds : []) into.makes.add(String(id));
        break;
      default:
        break;
    }
    return into;
  }

  // The steps after `at` that could not stand without it.  One forward pass is
  // enough for the whole chain: a step can only depend on an earlier one, so
  // anything a doomed step made is already known to be going by the time the
  // steps that use it are reached.
  function dependentsOf(entries, at) {
    if (entries[at]?.[0] !== OP_DO) return [];
    const gone = commandRefs(entries[at][2]).makes;
    if (!gone.size) return [];
    const found = [];
    for (let i = at + 1; i < entries.length; i++) {
      if (entries[i][0] !== OP_DO) continue;
      const refs = commandRefs(entries[i][2]);
      if (![...refs.needs].some((id) => gone.has(id))) continue;
      found.push(i);
      for (const id of refs.makes) gone.add(id);
    }
    return found;
  }

  function describeCommand(json, depth = 0) {
    if (depth > 8 || !json || typeof json !== 'object') return i18n.stepSomething;
    const data = json.data;
    switch (json.commandType) {
      case 'add-element':
        return i18n[COMPONENT_WORDS[data?.elemData?.name]] ?? i18n.stepSomething;
      case 'erase': return i18n.stepErase;
      case 'transform-element':
      case 'selection-tool-transform': return i18n.stepMove;
      case 'duplicate': return i18n.stepDuplicate;
      case 'inverse': return describeCommand(data, depth + 1);
      case 'union': {
        const children = Array.isArray(data?.data) ? data.data : [];
        if (children.length === 1) return describeCommand(children[0], depth + 1);
        // an erase and an add together are one element replaced by another,
        // which is what "Fit…" dispatches; calling that "a group of 2 changes"
        // would hide the one thing about the step worth reading
        const kinds = children.map((child) => child?.commandType);
        if (kinds.length === 2 && kinds.includes('erase') && kinds.includes('add-element')) {
          return i18n.stepReshape;
        }
        return i18n.stepGroup(children.length);
      }
      default: return i18n.stepSomething;
    }
  }

  // "4", "4 and 6", "4, 6 and 9" -- step numbers as the bar counts them
  const listSteps = (indexes) => {
    const numbers = indexes.map((i) => i + 1);
    if (numbers.length === 1) return String(numbers[0]);
    return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
  };

  // `title` is given for the symbol-only buttons, which need a name for a screen
  // reader and a tooltip for everyone else.
  function makePlayerButton(className, label, title = '') {
    const elButton = document.createElement('button');
    elButton.type = 'button';
    elButton.className = className;
    elButton.textContent = label;
    if (title) {
      elButton.title = title;
      elButton.setAttribute('aria-label', title);
    }
    return elButton;
  }

  async function playDrawing(fenceSource, target = null) {
    const {svg: svgText, stored} = splitHistory(fenceSource.trim());
    if (!stored) return;

    // Changing the history means writing a new fence back, which is only
    // possible where the markdown behind the drawing can be reached -- the same
    // condition the "Edit drawing" button already goes by.  Elsewhere (a posted
    // comment, a file view) the player is a viewer with step controls.
    const source = target ? sourceForMarkup(target.elMarkup) : null;
    const fenceIndex = source
      ? [...target.elMarkup.querySelectorAll('.markup-draw')].indexOf(target.elContainer)
      : -1;
    const editable = Boolean(source) && fenceIndex >= 0;

    const elOverlay = document.createElement('div');
    elOverlay.className = 'markup-draw-overlay markup-draw-player';
    const elHost = document.createElement('div');
    elHost.className = 'markup-draw-host markup-draw-player-host';
    elHost.textContent = i18n.loading;
    const elBar = document.createElement('div');
    elBar.className = 'markup-draw-player-bar';
    const elBack = makePlayerButton('markup-draw-player-back', i18n.playBackIcon, i18n.playBack);
    const elPlay = makePlayerButton('markup-draw-player-play', i18n.playIcon, i18n.playResume);
    const elForward = makePlayerButton('markup-draw-player-forward', i18n.playForwardIcon, i18n.playForward);
    const elRestart = makePlayerButton('markup-draw-player-restart', i18n.playRestartIcon, i18n.playRestart);
    const elDelete = makePlayerButton('markup-draw-player-delete', i18n.playDeleteIcon, i18n.playDelete);
    const elExport = makePlayerButton('markup-draw-player-export', i18n.playExportIcon, i18n.playExport);
    const elSave = makePlayerButton('markup-draw-player-save', i18n.playSaveIcon, i18n.playSave);
    const elClose = makePlayerButton('markup-draw-player-close', i18n.playCloseIcon, i18n.playClose);
    const elProgress = document.createElement('div');
    elProgress.className = 'markup-draw-player-progress';
    const elFill = document.createElement('div');
    elFill.className = 'markup-draw-player-fill';
    elProgress.append(elFill);
    const elStep = document.createElement('div');
    elStep.className = 'markup-draw-player-step';
    const elCaption = document.createElement('div');
    elCaption.className = 'markup-draw-player-caption';
    elBar.append(elBack, elPlay, elForward, elRestart, elProgress, elStep, elCaption);
    if (cfg.exportAnimation) elBar.append(elExport);
    if (editable) elBar.append(elDelete, elSave);
    elBar.append(elClose);
    elOverlay.append(elHost, elBar);
    document.body.append(elOverlay);
    document.body.classList.add('markup-draw-open');

    let editor = null;
    let entries = null; // the log, which the step controls may edit
    let captions = [];
    let position = 0; // how many entries have been applied
    let dirty = false; // entries differ from what is in the markdown
    let playing = false;
    let run = 0; // bumped to abandon a playback in flight
    let paused = false;
    let waiting = null; // resolves when playback is let go again
    let noteTimer = null;
    let busy = null; // {label, done, total} while an export is running
    let stopping = false; // an export was abandoned and should unwind
    // waits in flight, so that pausing can cut one short instead of letting it
    // run out first -- a wait here can be a second and a bit long, and a button
    // that takes that long to answer reads as broken
    const sleepers = new Set();
    const report = {blockedImages: 0};

    // a declaration, not a const: Escape can close the player while js-draw is
    // still loading, which reaches this from above
    function setPaused(value) {
      paused = value;
      if (paused) {
        for (const stop of [...sleepers]) stop();
      } else if (waiting) {
        const resume = waiting;
        waiting = null;
        resume();
      }
      refresh();
    }

    const fail = (message) => {
      elHost.textContent = message;
      elBar.classList.add('markup-draw-player-dead');
    };
    // Abandons the playback in flight: bumping `run` makes it return at its next
    // checkpoint, but a paused one is parked on a promise nobody would ever
    // resolve, so it has to be let go as well or it keeps the editor alive.
    const abandon = () => {
      run++;
      playing = false;
      setPaused(false);
    };
    const setBusy = (label, done, total) => {
      busy = {label, done, total};
      refresh();
    };
    const clearBusy = () => {
      busy = null;
      refresh();
    };
    // an export unwinds by throwing this out of its replay
    const stopIfAsked = () => {
      if (stopping) throw new Error(EXPORT_STOPPED);
    };
    const shutDown = () => {
      abandon();
      stopping = true; // let an export in flight unwind instead of finishing
      playerState = null;
      clearTimeout(noteTimer);
      editor?.remove();
      elOverlay.remove();
      document.body.classList.remove('markup-draw-open');
    };
    // Edits live in the player until they are saved, so leaving with unsaved
    // ones is the moment to ask -- there is nowhere else they are kept.
    const close = () => {
      if (!dirty) {
        shutDown();
        return;
      }
      askConfirmation(elOverlay, {
        title: i18n.playDiscard,
        body: i18n.playDiscardBody,
        confirm: i18n.playDiscardConfirm,
        cancel: i18n.playDiscardCancel,
        onConfirm: shutDown,
      });
    };
    elClose.addEventListener('click', close);
    elOverlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (elOverlay.querySelector('dialog[open]')) return;
      close();
    });
    elOverlay.tabIndex = -1;
    elOverlay.focus();

    let journal;
    try {
      journal = JSON.parse(await unpackHistory(stored.codec, stored.data));
      if (!journal || !Array.isArray(journal.e)) throw new Error('unexpected shape');
    } catch (err) {
      fail(`${i18n.playFailed} (${err.message || err})`);
      return;
    }
    entries = journal.e;

    let jsdraw;
    try {
      jsdraw = await loadJsDraw();
    } catch (err) {
      fail(String(err.message || err));
      return;
    }

    // What to say once entry n has been applied.  Worked out up front so that
    // stepping to any position says the same thing playing to it would.
    function buildCaptions(list) {
      const gaps = sessionGaps(list);
      const out = new Array(list.length).fill('');
      let sessionIndex = -1;
      let current = '';
      for (const [at, entry] of list.entries()) {
        if (entry[0] === OP_SESSION) {
          sessionIndex++;
          if (sessionIndex === 0) {
            current = typeof entry[1] === 'number' ? '' : i18n.playFound;
          } else {
            current = gaps.has(sessionIndex) ? describeGap(gaps.get(sessionIndex)) : i18n.playNextSession;
          }
        }
        out[at] = current;
      }
      return out;
    }
    captions = buildCaptions(entries);

    function note(text) {
      elCaption.textContent = text;
      elCaption.classList.add('markup-draw-player-note');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        elCaption.classList.remove('markup-draw-player-note');
        refresh();
      }, 4000);
    }

    const controls = () => [elBack, elPlay, elForward, elRestart, elDelete, elSave, elExport];

    function refresh() {
      const total = entries.length;
      if (busy) {
        // Nothing else may touch the log or the canvas while an export is
        // replaying it: the buttons go dead rather than queueing up behind it.
        elFill.style.width = `${Math.round((busy.done / Math.max(1, busy.total)) * 100)}%`;
        elStep.textContent = `${busy.done} / ${busy.total}`;
        elCaption.classList.remove('markup-draw-player-note');
        elCaption.textContent = busy.label;
        for (const el of controls()) el.disabled = true;
        return;
      }
      playerState = {
        position,
        total,
        dirty,
        editable,
        // what is actually on the canvas at this step, so that where the player
        // has got to can be checked exactly rather than guessed from pixels
        components: editor ? editor.image.getAllComponents().length : 0,
        drawing: describeRect(editor?.image.getImportExportRect()),
      };
      elFill.style.width = `${total ? Math.round((position / total) * 100) : 0}%`;
      elStep.textContent = i18n.playStep(position, total);
      // A note -- "saved", "is ready" -- borrows the caption for a few seconds.
      // Only the caption: letting it skip the rest of this left every button the
      // busy state had switched off dead until the note timed out.
      if (!elCaption.classList.contains('markup-draw-player-note')) {
        elCaption.textContent = position >= total
          ? i18n.playDone
          : (position > 0 ? captions[position - 1] : '');
      }
      // the same button pauses and resumes, so its name has to follow it -- a
      // glyph alone would leave a screen reader saying "button"
      const willPause = playing && !paused;
      elPlay.textContent = willPause ? i18n.playPauseIcon : i18n.playIcon;
      elPlay.title = willPause ? i18n.playPause : i18n.playResume;
      elPlay.setAttribute('aria-label', willPause ? i18n.playPause : i18n.playResume);
      // every control the busy state switched off has to be switched back on
      // here, or an export leaves them dead for good
      elPlay.disabled = false;
      elRestart.disabled = false;
      elExport.disabled = false;
      elBack.disabled = position === 0;
      elForward.disabled = position >= total;
      // a session marker is a place in the log, not an action; there is nothing
      // in the drawing to take away
      elDelete.disabled = position === 0 || entries[position - 1][0] === OP_SESSION;
      elSave.disabled = !dirty;
    }

    // Applying entry n is exactly what opening a drawing does.  There is no
    // matching "unapply": js-draw's push clears the redo stack, so after
    // "do A, undo, do B" the command A is no longer anywhere the editor can
    // reach, and stepping back over the undo cannot be done with redo alone.
    // Going backwards therefore rebuilds from the start -- slower, but it cannot
    // drift away from what playing to the same point would have shown.
    async function applyEntry(entry) {
      if (entry[0] === OP_DO) {
        editor.history.push(
          jsdraw.SerializableCommand.deserialize(sanitizeCommandJson(entry[2], report), editor),
          true,
        );
      } else if (entry[0] === OP_UNDO) {
        await editor.history.undo();
      } else if (entry[0] === OP_REDO) {
        await editor.history.redo();
      }
    }

    function freshEditor() {
      // js-draw cannot empty an editor, so starting over means a new one
      editor?.remove();
      elHost.textContent = '';
      editor = new jsdraw.Editor(elHost, {wheelEventsEnabled: 'only-if-focused'});
      restoreCanvasFrame(jsdraw, editor, svgText);
      position = 0;
    }

    async function rebuildTo(count) {
      freshEditor();
      while (position < count) {
        await applyEntry(entries[position]);
        position++;
      }
    }

    // Replays a candidate log and reports the first entry that will not go
    // through, or null if it all does.  Used to work out what a deletion really
    // takes with it; it leaves the canvas on the candidate, so the caller has to
    // put it back.
    async function probe(list) {
      freshEditor();
      for (let i = 0; i < list.length; i++) {
        try {
          await applyEntry(list[i]);
        } catch (err) {
          return {index: i, error: String(err?.message || err)};
        }
      }
      return null;
    }

    async function seek(to) {
      const wanted = Math.max(0, Math.min(to, entries.length));
      if (wanted < position) {
        await rebuildTo(wanted);
      } else {
        while (position < wanted) {
          await applyEntry(entries[position]);
          position++;
        }
      }
      refresh();
    }

    const guard = async (work) => {
      try {
        await work();
        return true;
      } catch (err) {
        fail(`${i18n.playFailed} (${err.message || err})`);
        return false;
      }
    };

    // Everything that touches the editor goes through here, one at a time.
    // Abandoning a playback only asks it to stop at its *next* checkpoint, so a
    // step already in flight keeps running -- and applyEntry reads the current
    // editor when it runs, not when it was queued.  Without this, that stray step
    // lands on the editor a delete or a rebuild has just put in its place, which
    // surfaces as a deletion that is agreed to and then refused: the replay that
    // was meant to verify it runs on a canvas somebody else was still drawing on.
    let chain = Promise.resolve();
    const exclusive = (work) => {
      const next = chain.then(work, work);
      chain = next.then(() => {}, () => {});
      return next;
    };

    const gate = () => (paused ? new Promise((resolve) => { waiting = resolve; }) : null);

    // Pausing cuts the current wait short; the gate right behind it is what
    // actually holds playback until it is let go again.
    const wait = (ms) => new Promise((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        sleepers.delete(stop);
        resolve();
      };
      const timer = setTimeout(stop, ms);
      sleepers.add(stop);
    });
    const pace = async (ms) => {
      await wait(ms);
      await gate();
    };

    async function play() {
      const mine = ++run;
      playing = true;
      setPaused(false);
      // at the end, Play means "again"
      if (position >= entries.length && !await exclusive(() => guard(() => seek(0)))) return;
      while (position < entries.length) {
        await gate();
        if (mine !== run) return;
        const entry = entries[position];
        if (!await exclusive(() => guard(() => seek(position + 1)))) return;
        if (mine !== run) return;
        // no wait after the last one: there is nothing left to pace, and it would
        // only delay saying that the recording has run out
        if (position < entries.length) {
          // a real pause is capped: nobody wants to watch somebody's lunch break
          const gap = entry[0] === OP_SESSION
            ? cfg.playbackSessionGap
            : Math.max(cfg.playbackMinStep, Math.min(entry[1] ?? 0, cfg.playbackMaxGap));
          await pace(gap / cfg.playbackSpeed);
        }
      }
      if (mine !== run) return;
      playing = false;
      refresh();
    }

    elPlay.addEventListener('click', () => {
      if (playing) {
        setPaused(!paused);
      } else {
        void play();
      }
    });
    elBack.addEventListener('click', () => {
      abandon();
      void exclusive(() => guard(() => seek(position - 1)));
    });
    elForward.addEventListener('click', () => {
      abandon();
      void exclusive(() => guard(() => seek(position + 1)));
    });
    elRestart.addEventListener('click', () => {
      abandon();
      // play() takes the lock a step at a time, so it must not be held across it
      void exclusive(() => guard(() => seek(0))).then(() => play());
    });

    // Removing a step that later ones build on takes those with it -- leaving
    // them behind would mean a history that cannot be replayed.  Which is why
    // every deletion asks first, and one that carries others away says so and
    // names them.
    // Everything that has to go along with the step at `at`.
    //
    // Reading ids out of the log is only a first guess.  js-draw does not fail
    // uniformly on a missing component -- `transform-element` throws,
    // `selection-tool-transform` warns and carries on without it -- and a way of
    // depending on a step that this does not model would otherwise show up as a
    // deletion that is agreed to and then refused.  So the guess is *replayed*,
    // and whatever will not go through is added and the replay tried again. That
    // makes the answer right whatever the dependency turns out to be.
    async function planDelete(at) {
      const doomed = new Set([at, ...dependentsOf(entries, at)]);
      let error = null;
      for (let attempt = 0; attempt < MAX_DELETE_PROBES; attempt++) {
        const keep = entries.map((_, i) => i).filter((i) => !doomed.has(i));
        const failure = await probe(keep.map((i) => entries[i]));
        if (!failure) return {steps: [...doomed].sort((a, b) => a - b), error: null};
        error = failure.error;
        doomed.add(keep[failure.index]);
      }
      return {steps: [...doomed].sort((a, b) => a - b), error};
    }

    async function applyDelete(steps) {
      abandon();
      const at = steps[0];
      const doomed = [...steps].sort((a, b) => b - a); // last first, so the indexes hold
      const removed = doomed.map((i) => [i, entries[i]]);
      for (const i of doomed) entries.splice(i, 1);
      captions = buildCaptions(entries);
      try {
        await rebuildTo(entries.length);
      } catch (err) {
        for (const [i, entry] of [...removed].reverse()) entries.splice(i, 0, entry);
        captions = buildCaptions(entries);
        if (!await guard(() => rebuildTo(at + 1))) return;
        note(i18n.playDeleteBlocked(String(err?.message || err)));
        return;
      }
      dirty = true;
      // back to the step the reader was looking at, which is now the one before
      // the deleted step
      if (!await guard(() => rebuildTo(at))) return;
      refresh();
      if (steps.length > 1) note(i18n.playDeletedWith(steps.length));
    }

    elDelete.addEventListener('click', () => {
      if (elDelete.disabled) return;
      const at = position - 1;
      const was = position;
      elDelete.disabled = true;
      // abandon first, so a playback in flight stops at its next checkpoint, then
      // queue behind whatever step it was already running
      abandon();
      void exclusive(async () => {
        const plan = await planDelete(at);
        // planning replays candidate logs through the canvas, so put it back
        if (!await guard(() => rebuildTo(was))) return;
        refresh();
        if (plan.error) {
          note(i18n.playDeleteBlocked(plan.error));
          return;
        }
        const others = plan.steps.filter((i) => i !== at);
        // Deleting one step on its own needs no question: nothing reaches the
        // markdown until Save, so the way back from a mis-aimed click is to close
        // the player.  Taking other steps down with it is the case worth stopping
        // for, because that is not visible from the button.
        if (!others.length) {
          void exclusive(() => applyDelete(plan.steps));
          return;
        }
        askConfirmation(elOverlay, {
          title: i18n.deleteStepWithDeps(describeCommand(entries[at][2]), others.length),
          body: i18n.deleteStepWithDepsBody(others.length, listSteps(others)),
          confirm: i18n.deleteConfirm,
          cancel: i18n.deleteCancel,
          onConfirm: () => void exclusive(() => applyDelete(plan.steps)),
        });
      });
    });

    // A browser only acts on a download while the click that asked for it is
    // still counted as a user action, and that lapses after a few seconds.
    // Building the SVG takes milliseconds, so it is still inside that window and
    // just downloads; a recording takes far longer than the window, so asking
    // once at the end makes the save a click of its own.  Reading the window
    // rather than guessing at it means no second button sitting in the bar for
    // a case that usually does not arise.
    const offerFile = (name, blob) => {
      const ask = cfg.exportAskBeforeSaving === 'always' ? true
        : cfg.exportAskBeforeSaving === 'never' ? false
          // no userActivation to read means no way to tell, so ask rather than
          // hand the file to a browser that may drop it without a word
          : !(navigator.userActivation?.isActive ?? false);
      if (!ask) {
        downloadBlob(name, blob);
        note(i18n.playExportSaved(name));
        return;
      }
      askChoice(elOverlay, {
        title: i18n.playExportReady(name),
        body: i18n.playExportReadyBody,
        cancel: i18n.playExportDiscard,
        choices: [{
          label: i18n.playExportSaveNow,
          hint: i18n.playExportSaveNowHint,
          onPick: () => downloadBlob(name, blob),
        }],
      });
    };

    // The SVG is only as slow as replaying the log; the video is recorded live
    // and so takes as long as watching it. Bundling them made the quick one wait
    // for the slow one -- and two downloads from one click is exactly what
    // Safari refuses, since by then neither is tied to the click any more.
    async function exportAnimatedSvg() {
      const durations = stepDurations(entries);
      setBusy(i18n.playBuildingSvg, 0, entries.length);
      const animated = await withScratchEditor(jsdraw, svgText, async (scratch) => {
        const builder = buildAnimatedSvg(jsdraw, scratch, entries, durations, svgText);
        await replayForExport(jsdraw, scratch, entries, async (at, touched) => {
          stopIfAsked();
          builder.step(at, touched, componentsById(scratch));
          setBusy(i18n.playBuildingSvg, at + 1, entries.length);
        });
        return builder.finish();
      });
      offerFile(`${cfg.exportName}.svg`, new Blob([animated], {type: 'image/svg+xml'}));
    }

    async function exportVideo() {
      const durations = stepDurations(entries);
      setBusy(i18n.playRecording, 0, entries.length);
      const video = await withScratchEditor(jsdraw, svgText, async (scratch) => {
        const elCanvas = scratch.getRootElement().querySelector('canvas:not(.wetInkCanvas)');
        if (!elCanvas) return null;
        return await recordAnimation(elCanvas, durations, async (frame) => {
          await replayForExport(jsdraw, scratch, entries, async (at) => {
            stopIfAsked();
            await frame(at);
          });
        }, (at) => setBusy(i18n.playRecording, at + 1, entries.length));
      });
      if (!video) {
        note(i18n.playExportVideoUnavailable);
        return;
      }
      offerFile(`${cfg.exportName}.${video.type.includes('mp4') ? 'mp4' : 'webm'}`, video);
    }

    const runExport = (work) => {
      abandon();
      void exclusive(async () => {
        try {
          await work();
        } catch (err) {
          if (String(err?.message) === EXPORT_STOPPED) return; // the player is closing
          note(i18n.playExportFailed(String(err?.message || err)));
        } finally {
          clearBusy();
        }
      });
    };

    elExport.addEventListener('click', () => {
      if (elExport.disabled) return;
      const seconds = Math.max(1, Math.round(
        (stepDurations(entries).reduce((sum, ms) => sum + ms, 0) + cfg.exportTailMs) / 1000,
      ));
      askChoice(elOverlay, {
        title: i18n.playExport,
        body: i18n.playExportBody,
        cancel: i18n.playExportCancel,
        choices: [
          {label: i18n.playExportSvg, hint: i18n.playExportSvgHint,
            onPick: () => runExport(exportAnimatedSvg)},
          {label: i18n.playExportVideo, hint: i18n.playExportVideoHint(seconds),
            onPick: () => runExport(exportVideo)},
        ],
      });
    });

    elSave.addEventListener('click', () => {
      if (elSave.disabled) return;
      abandon();
      void exclusive(() => guard(async () => {
        // The SVG is regenerated from the end of the edited log, so the picture
        // in the markdown is the picture the log now produces.
        await seek(entries.length);
        const svgElem = await editor.toSVGAsync();
        const packed = await packHistory(JSON.stringify({
          v: HISTORY_VERSION, h: svgFingerprint(new XMLSerializer().serializeToString(svgElem)), e: entries,
        }));
        const out = attachHistory(new XMLSerializer().serializeToString(svgElem), packed);
        // the markdown may have been edited while the player was open
        const fence = findFenceByIndex(source.getValue(), fenceIndex);
        if (!fence) {
          note(i18n.playSaveGone);
          return;
        }
        source.replaceRange(fence.start, fence.end, makeFence(out));
        dirty = false;
        refresh();
        note(i18n.playSaved);
      }));
    });

    if (!await guard(() => rebuildTo(0))) return;
    await play();
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
      scriptRevision: SCRIPT_REVISION,
      // empty means gitea-draw.css did not load, or a stale copy did
      cssRevision: getComputedStyle(document.documentElement)
        .getPropertyValue('--markup-draw-css').trim() || '(not loaded)',
      scriptUrl,
      config: cfg,
      giteaAssetVersion: window.config?.assetVersionEncoded ?? '(window.config missing)',
      jsDrawLoaded: Boolean(window.jsdraw?.Editor),
      // false after a board has been opened means the "Align…" and "Fit…"
      // entries are missing
      alignmentHooked: alignDebug.hooked,
      alignmentProblem: alignDebug.why,
      // the ids to look for under "Shape" in the pen dropdown
      umlPens: cfg.umlPens ? UML_PENS.map((pen) => pen.id) : [],
      // what the recorder is doing, or why it is not recording
      history: boardHistory ? boardHistory.describe() : historyDebug.state,
      // With a board open: where the drawing sits on the canvas against where
      // the board is looking.  A drawing that is not inside the view is what a
      // replay that forgot to restore the canvas frame looks like -- the board
      // opens on empty canvas somewhere else, with the drawing off to one side.
      // With a player open: how far through the log it is, and what is on the
      // canvas there.
      player: playerState,
      boardCanvas: boardEditor ? {
        drawing: describeRect(boardEditor.image.getImportExportRect()),
        visible: describeRect(boardEditor.viewport.visibleRect),
        autoresize: boardEditor.image.getAutoresizeEnabled(),
      } : null,
      // how many rendered drawings on this page carry a recorded history
      drawingsWithHistory: [...document.querySelectorAll(CODE_SELECTOR)]
        .filter((el) => historyRegExp().test(el.textContent ?? '')).length,
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
