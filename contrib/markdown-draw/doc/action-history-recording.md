# How the edit history came out this way

Notes for whoever maintains this next. [README.md](../README.md) says what the
feature does and how to configure it; this says **why it is built the way it is**,
which decisions were forced rather than chosen, and which mistakes are already
paid for. Most of it is here because it is not visible from the code: a
constraint you cannot see looks like an arbitrary choice, and arbitrary-looking
choices get "simplified" away.

Line references are to **js-draw 1.33.0**, `dist/mjs/…`, which is what
`install.sh` pins. Re-check them after an upgrade -- there is a checklist at the
end.

## 0. Where the code is

Two files, plus the one they are built on:

| File | What is in it |
|---|---|
| `gitea-draw-history.js` | the log: its format, how it is stored in the SVG, how a recorded command is sanitized and read, and the recorder a board fills one in with |
| `gitea-draw-playback.js` | the player, the step controls and the animation export -- everything that turns a log into something on screen |
| `gitea-draw.js` | the buttons, the drawing board, and the namespace the other two hang off (`window.giteaDraw`) |

The split is along one line: **knowing the format** is on the history side and
**showing it** is on the playback side. §1's "the log is the source of truth"
lives in the first, §7's "stepping backwards rebuilds" in the second. If a
change has you reaching for `OP_DO` or a `commandType` string in the playback
file, the reading of it belongs in the history file, next to the rest of the
format.

The two files load *after* `gitea-draw.js` and read its API when they load, so
the order of the three `<script defer>` tags in `header.tmpl` is load-bearing.
It only goes one way: the board reaches the recorder and the player through
`draw.recording` / `draw.playback` when a reader clicks something, never while
it is being loaded, so either file can be missing and drawing still works.
`giteaDrawDebug().scripts` lists the ones that did load, with a revision each --
they are cached separately, so one can be stale while the others are current.

## 1. The decision everything else follows from

**The log is a complete script from an empty canvas. The SVG in the fence is a
derived rendering artifact.** Opening a drawing replays the log; it does not load
the SVG and apply a patch.

This is not a preference. It is forced by one fact:

> Component ids survive `serialize()` / `deserialize()`
> (`components/AbstractComponent.mjs:262`, which writes `json.id` back onto the
> instance) but **not an SVG round trip**. js-draw writes no per-element id into
> its SVG, and `SVGLoader` invents fresh ones on the way back.

So the obvious-looking design -- load the SVG as today, push the recorded
commands onto the undo stack, done -- is broken. A `transform-element` recorded
in one session names a component that, next session, does not exist. Undoing it
deletes the wrong thing or throws.

Replaying from JSON keeps every id, so the drawing that comes out is the drawing
that went in.

**Consequence to keep in mind:** the fence's SVG and the log must agree. Three
mechanisms defend that, and all three matter:

* a fingerprint of the SVG stored in the log, so an SVG edited by hand wins and
  the log is dropped (see §5);
* the SVG is regenerated from the replayed state on every save;
* a command that will not serialize stops recording rather than letting the log
  drift (see `giveUp` vs `reject` in the source -- conflating them was a bug,
  §9.1).

## 2. Why "recorded" and "undoable" are the same set for free

The recorder listens to one event, `EditorEventType.UndoRedoStackUpdated`. It
carries the command *and* which of done/undone/redone happened
(`types.d.ts:55-61`). `CommandDone` on its own cannot tell a fresh command from a
redone one, which is why it is not used.

Everything that reaches that event is by definition on the undo stack. Panning
and zooming dispatch with `addToHistory` false (`tools/PanZoom.mjs:300`), so they
never appear. That means "what Ctrl+Z can take back" and "what gets recorded"
coincide **by construction** -- there is no list of command types to keep in step
with js-draw, and adding a tool to js-draw does not require a change here.

Do not replace this with per-tool hooks. The property is the point.

Two smaller facts that shaped the code:

* `editor.history.push(command, apply)` applies *and* records without announcing
  to a screen reader. `dispatch` announces, which on a few hundred replayed
  strokes is a scream. Replay uses `push`.
* The live undo stack is capped at 700 (`UndoRedoHistory.mjs:22`) and drops from
  the front. The log is not capped by that, so the two lengths must be reconciled
  rather than assumed equal -- hence the trimming in the stack-session tracking.

## 3. Storage: an XML comment inside the SVG

`<!--gitea-draw-history:1:z:BASE64-->` immediately before `</svg>`.

Alternatives considered and rejected:

| | why not |
|---|---|
| a second ` ```js-draw-history ` fence | GitHub, the API, RSS and notification e-mails do not know it and would render a wall of base64 as a visible code block; and two blocks drift apart under editing |
| an HTML comment beside the fence | invisible everywhere, but tied to the drawing only by position, so it misassociates when a page holds several drawings |
| `<metadata>` inside the SVG | fine, marginally larger, and has to be stripped before `loadFromSVG`; the comment is simpler and equally inert |

Compression is `CompressionStream('deflate-raw')` plus base64 -- native, no
dependency. base64 cannot contain the `--` that would close the comment early.
Where `CompressionStream` is missing the payload is stored plain and the codec
letter says so, so either can be read back.

**Cost, measured, not estimated:** about **60%** of the drawing's SVG on a
twelve-stroke drawing; nearer 100% on a two-stroke one, where fixed overhead
dominates. That is close to the floor: js-draw serializes a stroke's geometry as
the same path string the SVG carries, so the log is essentially a compressed
second copy of the drawing. If that number ever jumps, look for something being
stored per component that need not be -- `loadSaveData` was exactly that, and is
now dropped on the way in (js-draw refuses to restore it anyway, and says why at
`components/AbstractComponent.mjs:272`).

The log has its own budget and is deliberately **not** counted against
`maxSourceChars`, which is about how much drawing a page is asked to rasterize.
Counting it would push drawings that were fine yesterday over the limit today.

## 4. Timing: relative gaps plus one absolute anchor per session

A question worth recording because the answer is not obvious: *if only relative
gaps are stored, how is the gap between one session's last action and the next
session's first computed?*

**It cannot be.** No action happens in between, so no `dt` covers it. Relative
timing alone genuinely cannot express it -- this is missing information, not
awkward arithmetic. Hence:

* gaps within a session come from `performance.now()` -- monotonic, so a clock
  adjustment cannot produce a negative one, and the "no timestamps" mode never
  touches a wall clock at all;
* each session start is one absolute `Date.now()` anchor, which is the only thing
  a cross-session gap can be computed from. Clocks on two machines need not
  agree, so that subtraction is clamped at zero.

Sessions are marked explicitly in the log rather than inferred from a large
`dt` -- precisely because the large `dt` does not exist. That marker pays for
itself twice: it is also what the undo confirmation uses to know it is about to
cross into somebody else's work.

On privacy, the two halves are not equally sensitive, and it is worth not
conflating them: intra-session gaps are behavioural (how long someone hesitated,
how fast they work), while a session anchor leaks strictly less than the commit
or comment timestamp the drawing already sits inside.

Playback never acts out a cross-session gap -- days would be unwatchable. It is
captioned ("3 days later") instead, which is what the anchors are *for*.

## 5. Three ways a stored log is refused, and one that loses it

Refusals are recoverable and must stay that way. Each falls back to loading the
SVG and starting a fresh log:

1. **The SVG was changed outside the board** -- hand edit, another tool, a merge.
   Caught by an FNV-1a fingerprint of the SVG stored in the log. The edit is what
   the author meant; replaying would quietly undo it.
2. **The log cannot be read** -- newer version, truncated, not decompressible.
3. **The log cannot be replayed** -- it parses but a command does not
   deserialize. Recovery is to throw the board away and open a fresh one from the
   SVG, because js-draw cannot empty an editor: `loadFromSVG` replaces the
   background and adds the rest *on top*, so recovering in place would show a
   mixture of the two.

Distinct from all three: a command that cannot be **serialized** mid-session. That
one is not recoverable -- everything after it would replay onto a different
picture -- so recording stops and the drawing is saved with no log at all.

Keeping those two categories apart is not cosmetic; see §9.1.

## 6. Security: the JSON route is guarded less than the SVG route

The README's security section states the rule. The reason it needed stating:

> `ImageComponent.deserializeFromJSON` assigns `image.src = data.src` with no
> scheme check (`components/ImageComponent.mjs:144`), while the SVG loader forces
> `data:image/` and re-encodes anything else through a canvas
> (`components/ImageComponent.mjs:58`).

So moving from "load the SVG" to "replay JSON" *bypassed an existing defence*. A
recorded drawing could have called home to a URL of its author's choosing from
every reader who opened the board -- a tracking pixel and an IP leak. Every
recorded command therefore goes through a sanitising pass before
`SerializableCommand.deserialize`, and the cleaned command is what gets written
back on save, so a hostile payload is defused once rather than on every open.

**Keep that pass in front of every deserialize.** There are three call sites now:
the board, the player, and the export.

Playback and export run the same content through the same pass, and only ever on
a click. Rendering a drawing must stay what it is -- an `<img>`, and not even a
fetch of js-draw -- because a page can carry many drawings from many authors and
none of them should get to run their content through a deserializer just by being
displayed. There is a test asserting exactly that.

## 7. The player: why stepping backwards rebuilds

Forward is the original replay algorithm. Backward rebuilds from the start, which
is slower and is the only correct option:

> `history.push` clears the redo stack. After "draw A, undo, draw B", command A is
> no longer anywhere the editor can reach, so stepping back over the undo cannot
> be done with `redo()`.

An O(1) scheme using the editor's own undo/redo was written first and is wrong for
that reason. If someone optimises this later, that is the case to break it on.

### Deleting a step

Reading ids out of the log gives a first guess at what must go with a step:
`add-element` says what a step brings into being; `transform-element`,
`selection-tool-transform`, `erase` and `duplicate` say what they need to already
exist; `union` and `inverse` wrap another command and are walked into. One forward
pass finds the whole chain, transitive cases included, because a step can only
depend on an earlier one.

That guess is then **replayed**, and anything that will not go through is added
and the replay tried again. The guess alone is not trustworthy, and the reason is
worth keeping in view: **js-draw does not fail uniformly on a missing
component.** `transform-element` throws
(`components/AbstractComponent.mjs:309`), while `selection-tool-transform` logs a
warning and carries on without it (`tools/SelectionTool/Selection.mjs:556-562`).
A guess that is wrong in either direction shows up to the user as a deletion that
is agreed to and then refused.

## 8. Export: why SVG and video, and no GIF

Both formats were chosen because **neither needs a library**, which keeps the
customization's only dependency js-draw.

* **GIF is not possible without one.** Browsers ship no GIF encoder:
  `toDataURL('image/gif')` and `toBlob(…, 'image/gif')` both quietly return a
  PNG. Verified, not assumed. A GIF means vendoring an encoder (or writing LZW
  plus palette quantisation), and that should be a deliberate decision, not a
  drive-by.
* **SMIL runs inside `<img>`.** Verified with a real displayed image, not from
  documentation -- a first attempt using `drawImage` said it did *not* animate,
  which was an artifact of `drawImage` sampling an SVG at t=0. Because SMIL is
  declarative, a self-playing drawing stays on the same rendering path and the
  same trust model as a still one.
* The SVG is built by rendering each component through `SVGRenderer.fromViewport`
  and giving it a `<set>` at the time it appeared, so it comes out roughly the
  size of the drawing rather than the size of a film of it. A component a step
  moves is drawn again and swapped for the old one -- more general than animating
  the change.
* The video is the replay canvas through `MediaRecorder`, with
  `captureStream(0)` and `requestFrame()` so each step is held for as long as it
  actually lasted. **There is no faster-than-real-time path**; `MediaRecorder`
  encodes a live stream.

Both replay in a second, off-screen editor so the one being watched is untouched,
and that editor's canvas is **pinned** to the finished drawing's frame. Left to
autoresize it grows as the replay adds strokes, which renders every component
against a different viewport and makes the video drift under the drawing.

### Downloads and the user-activation window

A browser acts on a programmatic download only while the click that asked for it
still counts as a user action -- roughly five seconds. Building the SVG takes
milliseconds and stays inside it; a recording usually does not. Safari therefore
dropped one of two files silently.

The answer is to read `navigator.userActivation.isActive` when the file is ready:
still live means download it, lapsed means offer it with a **Save it** button,
which makes the save a click of its own. An earlier attempt kept a permanent
second download button in the bar; that was redundant, because the case it
covered is one most exports never reach.

## 9. Bugs already paid for

These encode invariants. Each one is a place where the obvious code is wrong.

### 9.1 "Cannot use this log" and "cannot record any more" are different

Both were one `problem` flag. Result: one hand edit to an SVG made the
fingerprint mismatch, and that drawing **never recorded history again** -- the
recoverable case had silently taken the fatal path. They are now `reject`
(recoverable: drop the stored log, adopt the SVG, carry on) and `giveUp` (fatal:
save without a log).

### 9.2 A replay restores components; a drawing is more than its components

Reported as: reopening a drawing showed only its bottom-right corner, with an
incomplete grey box to the left.

`loadFromSVG` also sets three things the replay skipped -- the import/export rect
from the `viewBox`, autoresize from a `js-draw--autoresize` class on the root
(`SVGLoader/SVGLoader.mjs:22`), and the view, by zooming to that rect
(`Editor.mjs:1121-1124`). Without them the board opened on js-draw's default
`0 0 500 500` while the drawing sat at `518 310 244 212`; the grey box was the
default region's own border. Saving from there wrote that default back out.

All three are taken **from the SVG**, not from the log: the SVG is what the
drawing renders as, it is always present on the replay path, and taking them from
there also repaired drawings already saved with an incomplete log.

Recording them into the log instead would have been worse than it looks:
`setAutoresizeEnabled` returns the non-serializable `Command.empty` when the value
is unchanged (`image/EditorImage.mjs:309-310`), so `uniteCommands` would have
produced a union that cannot be serialized -- and the guard for that (§5) switches
recording off entirely.

### 9.3 Abandoning a playback does not stop it

Reported as: a deletion confirmed, then refused, with the step still present.

`abandon()` only asks the play loop to stop at its *next* checkpoint, and
`applyEntry` uses whichever editor is current when it runs, not when it was
queued. A step still in flight landed on the editor the deletion had just put in
its place, so the replay meant to *verify* the deletion ran on a canvas something
else was still drawing on.

Everything in the player that touches the editor now runs one at a time through a
small serializer. **Anything new that touches the editor must go through it too.**

### 9.4 A busy state that switches controls off must switch them all back on

Two bugs in one feature, both leaving buttons dead for good: `refresh()` re-enabled
only some of what the busy state disabled, and its early return for a transient
note skipped the button state as well as the caption it was meant to protect --
so the "is ready" note itself kept the bar disabled. A note now suppresses only
the caption.

### 9.5 Adoption has to include what `getAllComponents` leaves out

`getAllComponents()` excludes background components. A drawing adopted without
`getBackgroundComponents()` replays back transparent.

## 10. After a js-draw upgrade, re-check these

Each is a load-bearing fact rather than a nice-to-have. `giteaDrawDebug()`
reports `history`, `player` and `boardCanvas`, which is usually enough to tell
which one has moved.

1. `UndoRedoStackUpdated` still carries `command` and `stackUpdateType`.
2. Pan/zoom still dispatch outside the undo stack.
3. Component ids still survive `serialize`/`deserialize` and still do **not**
   survive an SVG round trip. *(If they ever do survive, most of §1 could be
   simplified -- that would be the moment.)*
4. Everything reaching the undo stack is still a `SerializableCommand`.
5. `loadFrom` still sets rect / zoom / autoresize, and the autoresize marker is
   still a class on the SVG root.
6. `ImageComponent.deserializeFromJSON` still needs the sanitising pass in front
   of it -- and no *other* component type has grown a URL that needs the same.
7. The six command types the dependency analysis knows about are still the ones
   registered (`grep "SerializableCommand.register"`). A new one only degrades
   the first guess, because the replay catches what the guess misses -- but the
   guess is what makes the confirmation honest.
8. `SVGRenderer.fromViewport` and `AbstractComponent.render` are still public.
9. `renderAll` still renders everything rather than clipping to the viewport
   (`image/EditorImage.mjs:130`) -- the export and the "nothing is lost when the
   frame is wrong" recovery both rely on it.

## 11. Testing: instruments that were tried and dropped

* **Screenshot equality is the wrong instrument for "same state".** Comparing the
  canvas after stepping back and forward failed on a 0.4% byte difference that
  survived a 1.5s settle: a stroke pushed a moment ago sits on js-draw's wet-ink
  layer and composites slightly differently from one already flattened. Two
  identical drawings need not be identical images. `giteaDrawDebug().player`
  exposes component count and the export rect instead, and those compare exactly.
* **Page errors must fail the run.** A stray call threw a `TypeError` after doing
  its work while 101 checks passed and nobody looked at the console. `watchPage`
  now records them and `finish()` fails on them; that gate was verified by
  reintroducing the bug.
* **Do not time the user-activation window.** Under Playwright the same logic fell
  both ways -- a 9.4s export asked while a 12s one did not, because polling the
  page during a recording appears to keep activation alive. The branch is driven
  by `exportAskBeforeSaving` instead, which is a real setting rather than a test
  hook.
* **Assert on the artifact, not the click.** The export tests read the downloaded
  files: the SVG must carry timed SMIL, keep the drawing's size, contain no
  script and actually animate in an `<img>`; the video must be a non-empty file of
  a type the browser named.
* Two test-premise failures are worth remembering because they looked like product
  bugs: comparing the canvas frame *after* the undo tests had emptied the drawing
  (an emptied autoresizing canvas legitimately shrinks), and asserting a fixed
  overhead percentage against a two-stroke drawing where fixed cost dominates.

## 12. Deliberately not done

* **No GIF** -- §8.
* **No authorship.** The log records what and when, not who. A drawing edited by
  three people is one log. Gitea's own commit and comment history is where that
  lives.
* **No scrubbing timeline in the board.** The player steps; the board does not.
* **Keeping a later step while deleting the one it builds on** -- that is not a
  history that can be replayed, so the confirmation offers all-or-nothing.
* **Faster-than-real-time video.** `WebCodecs` could encode faster, but muxing to
  MP4 or WebM without a library is its own project.
