// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Watching a markdown-draw drawing being made: the player, the step controls
// and the animation export.  Part of contrib/markdown-draw, see
// contrib/markdown-draw/README.md; gitea-draw.js and gitea-draw-history.js load
// first and this file hangs itself off the namespace they publish.
//
// The same log the board replays to restore an undo stack is a script of how
// the drawing was made, so a rendered drawing can play it back.  Nothing here
// knows how that log is stored -- gitea-draw-history.js owns the format and
// hands over the entries; this file only decides what they look like on screen
// and how long each one is held.
//
// Playback runs only on a click, never on its own: it deserializes the same
// attacker-written JSON the board does, and a page full of drawings must not
// do that merely by being looked at.  It goes through the same sanitizer.

(() => {
  'use strict';

  // bump when changing this file; the three files are cached separately, so
  // giteaDrawDebug() reports one revision per file
  const REVISION = '1';

  const draw = window.giteaDraw;
  if (!draw?.recording) {
    // eslint-disable-next-line no-console
    console.error('markdown-draw: gitea-draw-playback.js loaded without gitea-draw.js and gitea-draw-history.js, check header.tmpl');
    return;
  }
  draw.scripts.push({name: 'gitea-draw-playback.js', revision: REVISION, url: document.currentScript?.src ?? '(unknown)'});

  const {
    askChoice, askConfirmation, cfg, describeRect, findFenceByIndex, i18n,
    loadJsDraw, makeFence, parseSvgFrame, restoreCanvasFrame, sourceForMarkup, SVG_NS,
  } = draw;
  const {
    attachHistory, commandRefs, dependentsOf, describeCommand, HISTORY_VERSION,
    OP_SESSION, OP_DO, OP_UNDO, OP_REDO, packHistory, sanitizeCommandJson,
    splitHistory, svgFingerprint, unpackHistory,
  } = draw.recording;

  // Defaults for what this file does.  Applied here rather than in gitea-draw.js
  // so that an option sits next to the code it drives; the admin's own
  // giteaDrawConfig is re-applied on top so it still wins.
  Object.assign(cfg, {
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
  }, window.giteaDrawConfig ?? {});

  Object.assign(i18n, {
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
  });

  // the open player, so that giteaDrawDebug() can report on it
  let playerState = null;

  // ---------------------------------------------------------------- timing

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

  // ---------------------------------------------------------------- the player

  // how many times a deletion may be replayed while working out what goes with
  // it; past this something is wrong with the log rather than with the deletion
  const MAX_DELETE_PROBES = 50;

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

  // ---------------------------------------------------------------- the API

  draw.playback = {
    // what the "▶ Play the edit history" button under a rendered drawing calls.
    // `target` is the markdown behind the drawing where there is one, which is
    // what makes the steps editable rather than only watchable.
    open: playDrawing,

    // for giteaDrawDebug(), which reports null while no player is open
    state: () => playerState,
  };
})();
