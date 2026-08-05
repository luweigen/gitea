// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// The edit history of a markdown-draw drawing: recording it, storing it in the
// drawing, and reading it back.  Part of contrib/markdown-draw, see
// contrib/markdown-draw/README.md; gitea-draw.js loads first and this file
// hangs itself off the namespace that one publishes.
//
// This file knows the log's format and nothing about how it is shown: the
// player and the animation export live in gitea-draw-playback.js and come
// through the API at the bottom.
//
// Every action Ctrl+Z can take back is written into the drawing itself, so the
// undo stack outlives the browser tab: reopening a drawing restores the stack
// it was closed with, and the same log is a script of how the drawing was made.
//
// What is recorded is what enters js-draw's UndoRedoHistory and stays there --
// panning and zooming dispatch with `addToHistory` false, so "undoable" and
// "recorded" are the same set by construction rather than by a rule kept in
// step by hand, and an action that is undone comes back out of the log rather
// than being cancelled by an entry in it.  So the log is what the drawing is
// made of, not a transcript of the session that made it: undo it and redo it
// and nothing is left behind either way.
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

(() => {
  'use strict';

  // bump when changing this file; the three files are cached separately, so
  // giteaDrawDebug() reports one revision per file
  const REVISION = '2';

  const draw = window.giteaDraw;
  if (!draw) {
    // eslint-disable-next-line no-console
    console.error('markdown-draw: gitea-draw-history.js loaded without gitea-draw.js, check header.tmpl');
    return;
  }
  draw.scripts.push({name: 'gitea-draw-history.js', revision: REVISION, url: document.currentScript?.src ?? '(unknown)'});

  const {askConfirmation, cfg, i18n} = draw;

  // Defaults for what this file does.  Applied here rather than in gitea-draw.js
  // so that an option sits next to the code it drives; the admin's own
  // giteaDrawConfig is re-applied on top so it still wins.
  Object.assign(cfg, {
    // record everything Ctrl+Z can take back into the drawing
    history: true,
    // size of the stored log, in characters of the fence, past which it is
    // collapsed back to a snapshot of the drawing
    historyMaxChars: 256 * 1024,
    // ask before an undo reaches back into an earlier editing session
    historyConfirmUndo: true,
  }, window.giteaDrawConfig ?? {});

  Object.assign(i18n, {
    undoAcross: 'Undo an earlier edit?',
    undoAcrossFrom: (when) => `The next undo takes back work from ${when}, not from this editing session.`,
    undoAcrossUnknown: 'The next undo takes back the drawing as it was before this editing session.',
    undoAcrossConfirm: 'Undo it',
    undoAcrossCancel: 'Keep it',
    // what a recorded command did, as the player names it
    stepStroke: 'a stroke',
    stepText: 'a piece of text',
    stepImage: 'an image',
    stepBackground: 'the background',
    stepShape: 'an imported shape',
    stepErase: 'an erase',
    stepMove: 'a move or resize',
    stepDuplicate: 'a duplicate',
    stepGroup: (n) => `a group of ${n} changes`,
    stepSomething: 'this step',
  });

  const HISTORY_VERSION = 1;
  const HISTORY_MARK = 'gitea-draw-history';

  // Entry shapes, kept numeric because an unsupported browser stores them as
  // plain base64 JSON with no compression to hide the verbosity.
  //
  // Only the first two are written any more: an action undone and left undone
  // is taken out of the log rather than cancelled by an entry in it (see the
  // recorder).  The other two are still read, because logs written before that
  // rule carry them, and replaying one is what turns it into the new shape.
  const OP_SESSION = 0; // [0, startedAt | null]  -- a board was opened
  const OP_DO = 1; //      [1, dt, commandJson]
  const OP_UNDO = 2; //    [2, dt]  -- historical, still replayed
  const OP_REDO = 3; //    [3, dt]  -- historical, still replayed

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

  // what the recorder is doing, for giteaDrawDebug(); a board that has been
  // closed leaves its last report here
  const status = {state: 'no drawing board opened yet'};

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

    // --- what an undo does to the log
    //
    // An action that was undone and left undone was never part of how the
    // drawing was made, so it is taken back out of the log rather than written
    // into it along with the undo that cancelled it.  One that was undone and
    // then redone is put back exactly as it was recorded, so a change of mind
    // and a change of mind about that leave no trace at all.
    //
    // The log's OP_DO entries therefore mirror the live undo stack, and the
    // last of them is its top.  Only the top matters here -- undo and redo act
    // nowhere else -- which is what keeps this right once js-draw has started
    // dropping the oldest entries off its own stack while the log keeps them
    // (see trim).
    //
    // The cost is that a redo cannot cross a save: what this session took back
    // is not in the file, so reopening the drawing has nothing to put back.
    // Undo still reaches through, because that work *is* in the file.

    // A stack, like the redo stack it shadows: a redo puts back whatever the
    // last undo took, so entries come out in the reverse order they went in and
    // land back in the order they were recorded.
    const undone = [];

    function retract() {
      // the last OP_DO, stepping over the session markers between it and the end
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i][0] !== OP_DO) continue;
        undone.push(entries.splice(i, 1)[0]);
        return;
      }
    }

    // Put back unchanged, gap and all: the entry says when the action was taken,
    // and taking it back and thinking better of it did not move that.  It lands
    // at the end because that is where it is on the undo stack now, which can
    // put an action from an earlier session after this session's marker -- that
    // only shifts which caption playback shows it under.
    function reinstate() {
      const entry = undone.pop();
      if (entry) entries.push(entry);
    }

    function record(command) {
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
        // a new command clears js-draw's redo stack, so nothing taken back
        // before it can ever come back
        redoSessions = [];
        undone.length = 0;
        if (recording) record(event.command);
      } else if (kind === jsdraw.UndoEventType.CommandUndone) {
        redoSessions.push(stackSessions.pop() ?? current);
        if (recording) retract();
      } else if (kind === jsdraw.UndoEventType.CommandRedone) {
        stackSessions.push(redoSessions.pop() ?? current);
        if (recording) reinstate();
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

    // A log written before undone work was taken out still carries its undos and
    // redos, and they are replayed into the editor as they always were -- but
    // the same cancellation is applied to `entries` on the way through, so what
    // comes back out on the next save is the surviving script.  Reading an old
    // log therefore normalizes it, and a new one has nothing to normalize.
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
            retract();
          } else if (op === OP_REDO) {
            await editor.history.redo();
            reinstate();
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
        status.state = problem ? `not recording: ${problem}` : 'recording';
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
        // what the log holds, which is what survived: an action undone and left
        // undone is not in it
        commands: entries.filter((e) => e[0] === OP_DO).length,
        // ... and how many are waiting on the redo stack to come back
        undone: undone.length,
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

  // --- what a step does, and what later steps need it to have happened
  //
  // Every recorded command names the components it works on by id, so what one
  // step needs from another can be read straight out of the log without applying
  // any of it.  The six command types js-draw registers each carry those ids
  // somewhere different; `union` and `inverse` wrap another command and are
  // walked into.

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
        return children.length === 1
          ? describeCommand(children[0], depth + 1)
          : i18n.stepGroup(children.length);
      }
      default: return i18n.stepSomething;
    }
  }

  // ---------------------------------------------------------------- the API
  //
  // The board (gitea-draw.js) records through `createHistory`; the player
  // (gitea-draw-playback.js) reads a stored log through the rest.  Everything
  // that knows the log's format is on this side of the line, so a change to the
  // format is a change to this file and no other.

  draw.recording = {
    // the payload inside an SVG: take it out, put it back, say whether one is there
    splitHistory,
    attachHistory,
    hasHistory: (text) => historyRegExp().test(text),

    // the stored form, which the player writes as well as reads
    HISTORY_VERSION,
    packHistory,
    unpackHistory,
    svgFingerprint,

    // one recorded action
    OP_SESSION,
    OP_DO,
    OP_UNDO,
    OP_REDO,
    sanitizeCommandJson,
    commandRefs,
    dependentsOf,
    describeCommand,

    // one recorder per drawing board
    createHistory,

    // for giteaDrawDebug(), which reports this whenever no board is open
    status: () => status.state,
    remember(report) {
      status.state = `last board: ${JSON.stringify(report)}`;
    },
  };
})();
