# markdown-draw

Freehand drawing inside Gitea markdown, with mouse, pen or finger, powered by
[js-draw](https://github.com/personalizedrefrigerator/js-draw) (MIT).

This is a **drop-in customization**: everything lives in Gitea's `CUSTOM_PATH`,
no Gitea source file is touched and no rebuild is needed.

A drawing is stored inline in the markdown source as a fenced code block:

````markdown
```js-draw
<svg viewBox="0 0 500 300" ...>...</svg>
```
````

so it is plain text -- it travels with the markdown, lands in the same commit or
the same issue comment, and shows up in `git diff`.

## Install

```sh
./install.sh /path/to/gitea/custom     # or: GITEA_CUSTOM=... ./install.sh
```

The script copies the customization and downloads js-draw's prebuilt bundle
(checksum-pinned) into `<custom>/public/assets/js-draw/`. Restart Gitea and
hard-reload the page.

Resulting layout:

```
<custom>/templates/custom/header.tmpl        loads the four files below
<custom>/public/assets/js/gitea-draw.js               the integration
<custom>/public/assets/js/gitea-draw-history.js       recording a drawing as it is made
<custom>/public/assets/js/gitea-draw-playback.js      watching that back, and exporting it
<custom>/public/assets/css/gitea-draw.css    styles
<custom>/public/assets/js-draw/bundle.js     js-draw itself (~500 KB, lazy-loaded)
<custom>/public/assets/js-draw/bundledStyles.js
```

The three scripts are one program in three files and load in that order:
`gitea-draw.js` publishes what the other two are built on, and the player reads
a log the recorder knows how to unpack. Either of the last two can be left out
-- drawing, editing and rendering carry on without it, which is what they did
before the edit history existed.

To uninstall, delete those files (and the `<script>`/`<link>` lines from
`header.tmpl` if you had one already) and restart.

## Use

Gitea has two unrelated markdown editors and both are covered, but the button
lands in a different place in each:

* **Issues, PRs, comments, wiki, releases** -- the shared markdown editor: a
  pencil button at the end of the markdown toolbar.
* **The repository file editor** (`/_edit/...`) -- Monaco, which has no markdown
  toolbar at all: an **Insert drawing** button above the editor. Where exactly
  depends on your Gitea version: next to the indent/line-wrap controls if it has
  them, otherwise after the write/preview tabs, otherwise directly above the
  editor. It only shows for file names Gitea renders as markdown, and follows
  you if you rename the file while editing.

From there the behaviour is the same:

* **Draw**: click the button, the board opens full-screen; on narrow screens or
  any touch device it uses js-draw's touch-friendly edge toolbar. Hit save and a
  `js-draw` fence is inserted at the cursor.
* **Edit**: put the cursor anywhere inside an existing `js-draw` fence and click
  the button again -- the drawing loads back into the board and the fence is
  replaced on save. In the *Preview* tab every drawing also carries its own
  **Edit drawing** button.
* **Align**: pick the selection tool and drag what you drew -- it snaps onto the
  edges and centres of the elements around it, with guides showing what it
  lined up with. For an exact alignment, open the menu behind the **…** button
  at the corner of the selection: next to js-draw's own *Duplicate* / *Delete* /
  *Copy* there is an **Align…** entry. See
  [Aligning what you drew](#aligning-what-you-drew).
* **Draw a UML relationship**: the pen's *Shape* list has the six class-diagram
  arrows -- generalization, realization, composition, aggregation, association
  and dependency -- next to js-draw's own arrow and line. See
  [UML relationship arrows](#uml-relationship-arrows).
* **Undo**: everything Ctrl+Z can take back is recorded into the drawing, so the
  undo stack survives closing the board, the tab and the browser. Reopening a
  drawing days later and pressing Ctrl+Z takes back the stroke drawn before it
  was last saved. Because that can reach into work somebody else did, the board
  asks before the first undo that crosses out of the current editing session, and
  says when the work it is about to take back was done. See
  [The edit history](#the-edit-history).
* **Read**: drawings render as images wherever markdown renders.
* **Watch**: a drawing that carries a recorded history gets a **▶ Play the edit
  history** button under it, which replays how it was made -- in an issue, in a
  file preview, anywhere it renders, with no editor involved. The player also
  steps through the history one action at a time, and where the markdown behind
  the drawing can be reached it can delete a step and write the result back, and
  it exports the whole thing as a self-playing SVG and a video.

In the file editor the insertion goes through Monaco's `executeEdits`, so a
single Ctrl+Z undoes it.

Pen pressure, touch input and palm rejection are js-draw's own; toolbar state
(pen, colour, thickness) is remembered in `localStorage`.

## Aligning what you drew

js-draw moves a selection as one block; it has nothing that lines the members of
a selection up with *each other*. That is what this adds, in two halves: guides
that snap a drag onto what is around it, and an **Align…** menu for saying
exactly what should line up with what.

### While dragging

Drag a selection and it snaps onto the edges and centres of the other elements
as it comes within 8 screen pixels of them, drawing a guide from the element it
matched to the one in your hand. Both axes snap independently, so a drag can
land on one element's left edge and another's centre line at once.

Only moving snaps -- the resize and rotate handles are untouched -- and holding
**Ctrl** (**Cmd**) hands over to js-draw's own snap-to-grid, which is what that
key already does there.

Set `snapDistance` to `0` in `giteaDrawConfig` to switch this off and keep only
the menu, or raise it to make the snap grabbier.

### From the menu

**Align…** hangs off the menu the selection's own **…** button already opens, so
it sits next to the drawing rather than in a toolbar at the top of the screen,
and it is a plain button on a touch screen as much as on a desktop.

The panel replaces the menu until you go **◀ Back**, and stays up after an
action so alignments can be chained. The menu opens at the corner of the
selection, on top of the very elements it acts on, so it is drawn see-through:
the selection and the outlined base object stay visible underneath while an
action is picked, and each result is visible as soon as it is clicked. Escape
closes the menu.

To change how see-through it is, override `--markup-draw-menu-opacity` on
`.markup-draw-overlay` -- `100%` gives back js-draw's opaque menu.

|  | | |
|---|---|---|
| align left | align horizontal centres | align right |
| align top | align vertical centres | align bottom |
| space out horizontally | space out vertically | snap to grid |
| match width | match height | match width and height |

Greyed out means the action needs more elements than are selected: spacing out
needs three, matching sizes needs two.

**What things line up against** depends on how many elements are selected:

* **One** -- the bounding box of everything drawn. Note that this includes the
  selected element, so aligning the leftmost element to the left does nothing.
* **Several** -- one of them, the **base object**, which stays put while the
  others move onto it. It is outlined in orange on the canvas, and **▶** steps
  the base through the selection, so it is always visible which element the rest
  are about to line up with.

  Shift-clicking elements one by one makes the first one you picked the base.
  A rubber-band selection has no click order to take that from -- js-draw sorts
  a selection by z-index, so the base starts as the element drawn first.

*Space out* leaves the outermost two elements where they are and gives the ones
between them equal gaps. The base object plays no part: which elements bound the
row is a property of where they sit, not of what was selected first.

*Snap to grid* snaps each element separately, unlike js-draw's own
whole-selection snap. The grid is js-draw's, whose spacing follows the zoom
level, so zoom in for a finer grid.

*Match width / height* scales about each element's own centre, so elements
change size without moving. js-draw scales a stroke's width along with its
geometry, so matched elements are drawn with a heavier or lighter pen than they
were.

Every action is one undoable step: a single Ctrl+Z takes back a whole alignment,
however many elements moved.

## UML relationship arrows

A class diagram tells its relationships apart by two things: the shape of the
head and whether the line is solid or dashed. js-draw has one arrowhead -- a
solid filled triangle -- and no dashed lines at all, so none of the six could be
drawn other than by hand. These add them to the pen's *Shape* list, beside
js-draw's own arrow, line, rectangle and circle:

| Pen | Line | Head |
|---|---|---|
| Generalization | solid | hollow triangle |
| Realization | dashed | hollow triangle |
| Composition | solid | filled diamond |
| Aggregation | solid | hollow diamond |
| Association | solid | open barbs |
| Dependency | dashed | open barbs |

Each is a shape pen like the ones next to it: drag from the tail to the head,
and only the two ends matter. They take the pen's colour and thickness, and the
head is sized from the thickness -- a thick pen draws a big head -- except on an
arrow too short to hold one, where the head shrinks to fit rather than swallow
the line. Holding the pen still snaps the arrow to the grid, as it does for
js-draw's own shapes.

An arrow is a single element, so it selects with one click, moves as a piece,
undoes in one step and lines up with [Align…](#aligning-what-you-drew) as a
whole. The eraser is the exception: it splits an arrow the way it splits any
stroke, so half an arrow is a reachable state.

Set `umlPens` to `false` in `giteaDrawConfig` to leave the pen list as js-draw
ships it.

These pens make UML arrows easier to *draw*; they do not make the board a UML
tool. Arrows do not stick to what they point at, so moving a box leaves its
arrows behind, and there are no class boxes or labels on lines. For a diagram
that is *maintained* as the code changes, Gitea's built-in mermaid
`classDiagram` is the better tool -- it is text, it diffs, and its layout is
computed. [doc/uml-arrows.md](doc/uml-arrows.md) is the maintainer's note: why
the pens are built the way they are, what is load-bearing, and what it would
take to go further.

## The edit history

Every action that Ctrl+Z can take back is written into the drawing itself, so
the undo stack outlives the tab and the same record can later be played back as
an animation of how the drawing was made.

This is the half of the customization that lives in its own two files:
`gitea-draw-history.js` knows the log's format -- how it is recorded, stored and
read back -- and `gitea-draw-playback.js` knows how to show one, step through it
and export it. Neither is reached until a reader clicks something.

If you are about to change any of this, read
[doc/action-history-recording.md](doc/action-history-recording.md) first: it
records which parts of the design were forced by js-draw rather than chosen,
what to re-check after a js-draw upgrade, and the bugs already paid for.

### What is recorded

Exactly what enters js-draw's undo history: strokes, erasures, text, moving and
resizing a selection, duplicating, every **Align…** action, background and canvas
size changes. Panning and zooming are not, because js-draw dispatches them
outside the undo stack -- so "undoable" and "recorded" are the same set by
construction, not by a rule that has to be kept in step.

Undo and redo are recorded too, as events in their own right. A drawing
therefore remembers not just what was drawn but what was drawn and taken back,
which is what makes reopening it able to redo, and what will make an animation
show the corrections rather than only the final path.

Timing is recorded as the gap between one action and the next, plus one absolute
timestamp per editing session. The gaps come from `performance.now()`, which is
monotonic, so a system clock adjustment cannot produce a negative one; the
session anchors come from `Date.now()`, and are what a cross-session gap is
computed from -- relative gaps alone cannot express the time between one session
ending and the next beginning, because no action happens in between to carry it.

### Where it is stored

Inside the SVG, as an XML comment just before `</svg>`:

````markdown
```js-draw
<svg ...>...<!--gitea-draw-history:1:z:Ly8gZGVmbGF0ZWQgSlNPTiwgYmFzZTY0...--></svg>
```
````

so one fence stays one self-contained drawing: copying it takes the history
along, and every renderer that does not know about it -- Gitea's, GitHub's, an
e-mail client's -- ignores a comment, so nowhere does a wall of base64 show up on
screen. The payload is JSON, deflated through `CompressionStream` and base64'd;
base64 cannot contain the `--` that would close the comment early. A browser
without `CompressionStream` stores it uncompressed and marks it `p` instead of
`z`, so either can be read back.

Measured on the drawings the test suite makes, the history adds **about 60%** to
the size of the drawing's SVG (a two-stroke sketch is worse, near 100%, because
the fixed cost dominates). That is close to the floor: js-draw serializes a
stroke's geometry as the same path string the SVG carries, so the log is
essentially a compressed second copy of the drawing.

The log has its own budget, `historyMaxChars`. It is not counted against
`maxSourceChars`, which is about how much drawing a page is asked to rasterize
-- counting it would push drawings that were fine yesterday over the limit today.

### How a drawing comes back

The log is a complete script starting from an empty canvas, not a patch on top
of the SVG, and opening a drawing replays it rather than loading its SVG.

That is forced by js-draw rather than chosen: component ids survive
serialize/deserialize but not an SVG round trip -- js-draw writes no ids into its
SVG and its loader makes fresh ones on the way back. A command recorded against
an SVG-loaded image would, next time, name a component that no longer exists, and
undoing it would delete the wrong thing. Replaying from JSON keeps every id, so
the drawing that comes out is the drawing that went in. The SVG in the fence
stays the thing that renders, regenerated from the replayed state on every save.

A drawing with no log -- one made before this existed, or by an older install --
is **adopted** on first open: everything on the canvas becomes the log's first
command, so from then on the ids are fixed. That first command is recorded as a
session with no time, because when the drawing was actually made is not something
the file can say; the confirmation before undoing into it says so rather than
inventing a date.

Replaying reinstates the components and nothing else, but a drawing is more than
its components: `loadFromSVG` also sets where the drawing sits on the canvas
(the SVG's `viewBox`), whether the canvas grows with its content (a
`js-draw--autoresize` class on the root), and the view onto it. All three are
taken from the SVG after a replay, not from the log. The SVG is what the drawing
renders as, so it is authoritative by definition, and taking them from there also
repairs logs written before this was noticed. Recording them instead would be a
trap: `setAutoresizeEnabled` returns the non-serializable `Command.empty` when
the value is unchanged, which would make the whole log unserializable and switch
recording off.

### Watching it being drawn

A rendered drawing that carries a history gets a **▶ Play the edit history**
button beside it, which opens a player: the drawing appears stroke by stroke,
with **Pause**, **Restart** and a progress bar.

The timing is the recorded timing, with two adjustments, because a faithful
replay is unwatchable. A pause inside a session is capped at `playbackMaxGap`,
so somebody's lunch break does not become a minute of nothing; and the gap
between two sessions -- hours, days, sometimes weeks -- is not acted out at all
but written in the corner, "3 days later", which is what the absolute session
anchors are for. `playbackSpeed` divides every wait.

Playback runs on a click and never on its own. It deserializes the same
attacker-written content the board does, and a page carrying a dozen drawings
must not do that merely by being looked at, so rendering a drawing does not even
fetch js-draw. The canvas is inert while it plays: a stroke drawn onto it by hand
would put the picture out of step with the log being replayed into it.

The player builds the drawing from the log, not from the SVG, so it shows the
undo and redo as they happened -- the picture goes backwards where the author
changed their mind.

### Stepping through it, and editing it

**⏮** and **⏭** move one step at a time, and the bar says which step you are on.
The controls are glyphs so the bar fits a phone -- **▶** / **⏸** play and pause,
**↺** restarts, **✂︎Step** deletes, **⎋** closes -- and each carries its name as
a tooltip and as its accessible name, which is what a screen reader reads and
what the tests assert on. Below about 560px the caption drops onto its own line
rather than pushing a control off the edge.
Stepping forward applies the next entry, exactly as opening the drawing does.
Stepping backward rebuilds from the start: js-draw's `push` clears the redo
stack, so after "draw A, undo, draw B" the command A is no longer anywhere the
editor can reach, and stepping back over the undo cannot be done with redo alone.
Rebuilding is slower on a long history, but it cannot drift away from what
playing to the same point would have shown.

Where the markdown behind the drawing can be reached -- a comment being written,
a file being edited, the same condition the **Edit drawing** button goes by --
two more buttons appear:

* **✂︎Step** (*Delete this step*) takes the current step out of the history. A
  step nothing else builds on goes without a question: nothing reaches the
  markdown until **Save**, so the way back from a mis-aimed click is to close
  the player, and the markdown is exactly as it was.

  A step that later ones build on is the case worth stopping for, because it is
  not visible from the button: removing a stroke while a later step still moves
  it would leave a history that cannot be replayed, so the two cannot be
  separated. There the click asks -- *Delete a stroke and the 2 that build on
  it?* -- names which steps go with it, and removes them together.

  Reading the log gives the first guess: every recorded command names the
  components it works on by id, so `add-element` says what a step brings into
  being and `transform-element`, `erase`, `duplicate` and
  `selection-tool-transform` say what they need to already be there. One forward
  pass finds the whole chain, transitive cases included, because a step can only
  ever depend on an earlier one.

  That guess is then **replayed**, and anything that will not go through is
  added to it and the replay tried again, until the log runs clean. js-draw does
  not even fail uniformly on a missing component -- `transform-element` throws
  where `selection-tool-transform` warns and carries on -- so a guess alone can
  be wrong, and a wrong guess would show up as a deletion agreed to and then
  refused. Replaying is what makes the answer right whatever the dependency
  turns out to be; the reading only keeps it quick.
* **Save** (*Save to markdown*) replays the edited log to its end, regenerates the SVG
  from that, and writes both back into the fence. The picture in the markdown is
  therefore always the picture the log produces.

**⤓** exports the animation, asking which format first. It needs no editable
text behind the drawing, so it works on a posted comment as well as in an editor.

* **Animated SVG** -- ready at once. Building it is only a replay of the log, so
  it takes milliseconds however long the drawing took to make.
* **Video** (MP4 where the browser can, WebM otherwise) -- recorded as it plays,
  so it takes about as long as watching it. `MediaRecorder` encodes a live
  stream; there is no faster path.

They are offered one at a time rather than both together, for two reasons: the
quick one should not have to wait for the slow one, and two downloads from a
single click is exactly what a browser refuses -- Safari took only one of them,
because by the time either file exists the click that asked for it is long over.

That last point is also why an export sometimes ends with a question rather than
a download. A browser only acts on a download while the click that asked for it
still counts as a user action, which lapses after a few seconds. Building the SVG
takes milliseconds and stays inside that window, so it simply downloads; a
recording usually does not, so the file is offered with a **Save it** button,
which makes the save a click in its own right. Which of the two happens is read
from `navigator.userActivation`, not guessed -- so there is no second button
parked in the bar for a case that most exports never reach.
`exportAskBeforeSaving` overrides it: `always` for a browser where the automatic
route cannot be trusted, `never` to rely on the download alone.

While an export runs the bar shows what it is doing and how far it has got, and
every control that would disturb it is switched off -- it is replaying the log
through an editor of its own, and a step or a deletion landing in the middle of
that is the sort of thing that produces a file quietly missing a stroke. Closing
the player stops an export in flight rather than letting it finish into nothing.

Those two formats are the ones that need no library, which is why they are the
ones on offer. SMIL animation is declarative and -- unlike script -- runs inside
an `<img>`, so a self-playing drawing stays on exactly the rendering path and
trust model a still one is on; it is built by rendering each component through
js-draw's own `SVGRenderer` and giving it a `<set>` at the time it appeared, so
it comes out about the size of the drawing rather than the size of a film of it.
The video is the replay canvas recorded through `MediaRecorder`, driven by
`captureStream(0)` and `requestFrame()` so each step is held for as long as it
actually lasted.

Both replay in a second, off-screen editor, so exporting does not disturb the
one being watched, and the canvas is pinned to the finished drawing's frame --
left to autoresize it would grow as the replay adds strokes, and the picture
would drift under the recording.

Edits live in the player until they are saved: **Save** is the only thing that
writes into the markdown, so closing is always a way out. It asks before
discarding unsaved edits, and discarding leaves the markdown byte for byte as it
was. On a drawing with no
editable text behind it, neither button appears and the player is a viewer with
step controls.

### When a stored log is not used

Three cases, none of which loses the drawing:

* **The SVG was changed outside the board** -- a hand edit in the markdown,
  another tool, a merge resolution. The log carries a fingerprint of the SVG it
  produced; if it does not match, the log is dropped and the SVG is loaded,
  because that edit is what the author meant and replaying would quietly undo it.
* **The log cannot be read** -- written by a newer version of this script,
  truncated, or not decompressible here.
* **The log cannot be replayed** -- it parses but a command in it does not
  deserialize. The half-built board is thrown away and a fresh one is opened
  straight from the SVG, because js-draw cannot empty an editor again
  (`loadFromSVG` replaces the background and adds the rest on top, so recovering
  in place would show a mixture of the two).

In all three the drawing loads from its SVG and a new log starts from there.
`giteaDrawDebug().history` reports which happened, under `rejected`.

The one case that does lose a history is a command that cannot be *serialized*,
which would make everything after it replay onto a different picture. Recording
stops there and the drawing is saved without a log rather than with a lying one;
`problem` says so, and a warning goes to the console. No js-draw command in the
undo stack behaves this way today -- this is the guard for the one that might.

### When it gets too big

Past `historyMaxChars` the log is collapsed on the next save into a single
snapshot of the drawing as it then stands, and recording starts again from
there. Undo can no longer reach back past that point; the drawing is untouched.
Keeping the current session's actions on top of a snapshot taken when the board
opened would be nicer, but an undo made during that session can reach back past
it, and a log that cannot be replayed is worse than a short one.

## How it works

Gitea's markdown renderer emits `<code class="chroma language-XXX display">` for
*any* fence language (`modules/markup/markdown/markdown.go`), and that `class`
survives sanitization because it goes through `FormatWithSafeAttrs`. So a fence
language is a usable extension point from the browser side, exactly like the
built-in `mermaid` and `math` blocks -- no `app.ini` change and no sanitizer rule
are needed, because the payload sits inside a code fence where the server-side
sanitizer only ever sees escaped text.

`custom/templates/custom/header.tmpl` is rendered into `<head>` on every page
(`templates/base/head.tmpl`), and `<custom>/public/` is served under `/assets/`
(`modules/public/public.go`).

Writing back into the editor needs one more hook per editor. The shared markdown
editor keeps its text in a plain `textarea.markdown-text-editor`, so that one is
just a text edit. The file editor is Monaco, whose text a `textarea` cannot
reach -- there Gitea publishes its editor instances as `window.codeEditors`,
declared in `web_src/js/globals.d.ts` as "export editor for customization",
which is exactly what this uses.

js-draw is only fetched when a board is actually opened, so pages that merely
display drawings do not pay for it.

Everything in the player that touches the editor runs one at a time. Abandoning
a playback only asks it to stop at its next checkpoint, and a command applies to
whichever editor is current when it runs, not when it was queued -- so without
that, a step still in flight could land on the editor a deletion had just put in
its place, and the replay meant to verify the deletion would run on a canvas
something else was still drawing on.

The edit history needs three things from js-draw, all of them public. The
`UndoRedoStackUpdated` event carries both the command and which of
done/undone/redone happened, so one listener sees all three -- `CommandDone`
alone cannot tell a fresh command from a redone one. Every command that reaches
the undo stack is a `SerializableCommand`, whose `serialize()`/`deserialize()`
pair exists for js-draw's collaborative editing support and preserves component
ids. And `editor.history.push(command, apply)` replays a command into both the
image and the undo stack without announcing it to a screen reader, which
`dispatch` would do several hundred times over on a large drawing.

The one liberty it takes is replacing `undo` on the board's own
`editor.history` object, to ask before an undo reaches back into an earlier
session. Both the toolbar button and the Ctrl+Z shortcut call
`editor.history.undo()`, so that single instance property covers both; nothing is
replaced on a prototype. If js-draw stops routing undo through it, the question
stops being asked and undo goes back to being immediate.

Alignment needs two things from js-draw, both of which it already offers:
`AbstractComponent.transformBy()` gives an undoable command per element (united
into one with `uniteCommands`, so an alignment undoes in a single step), and
`EditorEventType.SelectionUpdated` says when the selection changed.

Two things reach past the public API, both the same way: js-draw declares them
`private` in TypeScript, which is a compile-time promise, so at runtime they are
ordinary properties that can be wrapped. Neither is replaced on a prototype --
always on the instance, which is created fresh per board and per selection.

**The menu.** `SelectionTool.showContextMenu` is an *instance property*, read
when a selection is built, so replacing it before anything can be selected
covers both the **…** button and a right click. The replacement calls the
original -- every entry js-draw puts in the menu is left alone -- and then
appends one button to the `.content` list of the
`<dialog class="editor-popup-menu">` it just built.

**The guides.** There is no "the selection is being dragged" event, but a drag
is a stream of `Selection.setTransform(Mat33.translation(…))` calls, so each new
`Selection` gets its `setTransform` shadowed and the translation adjusted on its
way through. Anything that is not a plain translation goes through untouched,
which is what leaves the resize and rotate handles alone, and so does anything
with `preview` false, which is how the finalising command replays the transform
-- snapping that a second time would move it twice.

If js-draw changes either, the feature stops rather than misbehaves: the
**Align…** entry does not appear, or drags stop snapping. `giteaDrawDebug()`
reports `alignmentHooked` so that can be told apart from a stale cache.

The UML pens need none of that: `EditorSettings.pens.additionalPenTypes` takes
custom pens as public, documented API, and js-draw draws each one's toolbar icon
itself by running the builder.

What does constrain them is that **an arrow has to be one stroke with one
style**. The SVG renderer starts a new `<path>` wherever the style changes and
the loader makes one component per `<path>`; the drawing lives in the markdown
as SVG text, so it makes that round trip every time it is opened. An arrow built
out of two styles -- a stroked shaft and a filled head, say -- would look right
when drawn and come back as two components the next time someone opened it. So
everything is filled geometry, the idiom js-draw's own arrow and line builders
use: the shaft is a quad, a dash is a shorter quad, and a hollow head is a band
whose inner outline is wound backwards, which the default nonzero fill rule
turns into a hole.

### Security

The SVG in a fence is attacker-controlled content: any user who can comment can
put anything in there. It is therefore **never** inserted into the page as live
SVG. Rendering goes through an `<img>` pointing at a blob URL, which browsers
treat as a non-interactive document -- scripts do not run and external
references are not loaded. When a drawing is opened for editing it is passed to
`editor.loadFromSVG(svg, /* sanitize */ true)`.

If you change this file, keep that property. `innerHTML = svgText` on markdown
content would be a stored-XSS hole that bypasses Gitea's server-side sanitizer.

A recorded edit history is the same attacker-controlled content as the SVG beside
it, and the JSON route into js-draw is guarded *less* than the SVG one:
`ImageComponent.deserializeFromJSON` assigns `src` straight through, while
js-draw's SVG loader forces `data:image/` and re-encodes anything else through a
canvas. Every recorded command is therefore run through a sanitizing pass before
it is deserialized, which replaces any `src` that is not a `data:image/` URL with
a blank pixel -- otherwise a drawing could call home to a URL of its author's
choosing from every reader who opened the board, which is a tracking pixel and an
IP leak. The cleaned command is what gets written back on save, so a hostile
payload is defused once rather than on every open. Keep that pass in front of
`SerializableCommand.deserialize` if you change how logs are read.

Playback goes through the same pass, and only ever on a click. Rendering a
drawing must stay what it is today -- an `<img>`, and not even a fetch of js-draw
-- because a page can carry many drawings from many authors, and none of them
should get to run their content through a deserializer just by being displayed.

`loadSaveData` is dropped rather than sanitized: js-draw refuses to restore it
for the same reason (`AbstractComponent.deserialize` says so in a comment), so
carrying it would be weight with no effect.

Sources larger than `maxSourceChars` (512 KiB by default) are refused, the same
guard `MERMAID_MAX_SOURCE_CHARACTERS` provides for mermaid.

### Configuration

Override any of the defaults before the scripts load, e.g. in `header.tmpl`.
Each file defaults the options it acts on and then re-applies `giteaDrawConfig`
on top, so an override always wins whichever file the option belongs to:

```html
<script>
  window.giteaDrawConfig = {
    assetsPrefix: "{{AssetUrlPrefix}}/js-draw",
    lang: "js-draw",            // fence info string
    maxSourceChars: 524288,
    edgeToolbarMaxWidth: 800,   // below this width, use the touch toolbar
    alignment: true,            // the "Align…" entry in the selection menu
    snapDistance: 8,            // screen px a drag snaps over, 0 to switch off
    umlPens: true,              // the six UML relationship pens
    // gitea-draw-history.js
    history: true,              // record every undoable action into the drawing
    historyMaxChars: 262144,    // past this the log collapses to a snapshot
    historyConfirmUndo: true,   // ask before undoing into an earlier session
    // gitea-draw-playback.js
    playback: true,             // the "▶ Play the edit history" button
    playbackMaxGap: 1200,       // longest pause, in ms, playback acts out
    playbackSessionGap: 900,    // beat where one session ends and the next begins
    playbackMinStep: 40,        // floor, so a burst of fast commands is followable
    playbackSpeed: 1,           // divides every wait; 2 plays back twice as fast
    exportAnimation: true,      // the "⤓" button: a self-playing SVG and a video
    exportBitrate: 4000000,     // video bitrate
    exportTailMs: 1200,         // how long the finished drawing is held at the end
    exportName: 'drawing-history',  // base name for the two files
    exportAskBeforeSaving: 'auto',  // 'always' / 'never' override the check
  };
</script>
```

## Tests

`test/` builds a browser test environment and drives the customization in it:

```sh
cd test && ./setup.sh && ./run.sh
```

It stands up the two Gitea editors' markup, serves the real
`custom/public/assets` files into them, and opens the board with a mouse and
with a finger. See [test/README.md](test/README.md).

## Limitations

* **Browser-side only.** The API's rendered HTML, Atom/RSS feeds, notification
  e-mails and other Git clients all see the raw fence text. This is the same
  trade-off mermaid makes.
* **The markdown gets bigger.** js-draw's SVG is verbose; a busy sketch can be
  tens of kilobytes of one-line SVG in the source, and the edit history adds
  about 60% on top of that. Fine for issue comments, worth thinking about for
  files you expect to review line by line. If that matters, upload drawings as
  attachments and link them instead -- but then they no longer travel with the
  markdown -- or set `history: false` to keep only the picture.
* **The edit history says nothing about who.** It records what was done and
  when, not by whom: a drawing edited by three people is one log, and the
  confirmation before undoing across a session can say when that work was done
  but not whose it was. Gitea's own history -- the commit or the comment edit --
  is where that lives.
* **A restored undo stack can reach other people's work.** That is the point of
  it, and the reason for the confirmation, but it does mean a drawing can be
  taken apart with repeated Ctrl+Z by someone who did not draw it. The markdown
  itself is still the record; the surrounding commit or comment history is what
  undoes an unwanted change.
* **The history does not survive a hand edit of the SVG.** Editing the drawing's
  text directly is respected -- the log is dropped rather than replayed over it
  -- but the log is then gone, and a new one starts from the edited picture.
* **No GIF.** Browsers ship no GIF encoder -- `toBlob('image/gif')` quietly
  returns a PNG -- so one would mean vendoring an encoder, and this
  customization carries no dependency but js-draw. The self-playing SVG covers
  the "shows up inline" case and the video covers "plays anywhere".
* **Recording the video takes as long as watching it.** `MediaRecorder` encodes
  a live stream; there is no faster-than-real-time path. The SVG has no such
  cost -- it is built from a replay, not from a recording.
* **A download that is not tied to a click** is refused or ignored by some
  browsers, Safari among them, and nothing built after an await can be tied to
  one. Hence one file per action, and the **Save it** question when the window
  has lapsed.
* **Stepping backwards costs a rebuild.** Each backward step replays the log
  from the start, so on a history of hundreds of steps it is noticeably slower
  than stepping forwards. Correctness is why: see the stepping section.
* **Deleting a step can take later ones with it.** A stroke that a later step
  moves cannot be removed on its own, so the two go together. The confirmation
  says how many and which, but there is no way to keep the later step and drop
  only the one it builds on -- that is not a history that could be replayed.
* **Editing the history needs the markdown to be reachable.** On a posted
  comment or a plain file view there is no text to write back into, so the
  player only steps and plays there.
* **The legacy EasyMDE editor is not covered.** Switching to it hides the
  markdown toolbar, so the button disappears with it; switch back to draw.
* In the file editor the button only appears for the extensions listed in
  `markdownExtensions` (Gitea's `[markdown] FILE_EXTENSIONS` defaults). Change
  one and change the other.
* Depends on Gitea's editor DOM (`.combo-markdown-editor`,
  `textarea.markdown-text-editor`, `<markdown-toolbar>`) and on
  `window.codeEditors`, none of which carry a compatibility promise. Re-test
  after a major upgrade. The file editor button only needs `window.codeEditors`
  -- the page layout it is placed into is probed, not assumed.
* Alignment depends on js-draw internals in two places: the
  `SelectionTool.showContextMenu` instance property together with the markup of
  the menu it opens (`dialog.editor-popup-menu > .content`), and
  `Selection.setTransform` being the channel a drag goes through. A js-draw
  upgrade that changes either drops that half -- no **Align…** entry, or no
  snapping while dragging -- rather than breaking the editor. The alignment
  arithmetic itself is public API and unaffected.
* Snapping compares the selection against every other element in the drawing.
  That list is gathered once per drag, so a drag stays smooth, but a drawing
  with thousands of strokes will pause briefly when one starts.
* Alignment works on whole elements. A stroke drawn as one gesture is one
  element, so it cannot be lined up with part of itself, and matching sizes
  scales pen widths along with the geometry.
* The UML pens draw arrows, not diagrams: an arrow does not stick to what it
  points at, so moving a box leaves its arrows where they were, and there are no
  class boxes or labels on lines. An arrow also carries no record of what it is
  -- it is ink, so it cannot be retyped from composition to aggregation without
  being redrawn. [doc/uml-arrows.md](doc/uml-arrows.md) covers why, and what
  each of those would take.

## When the button does not show up

Run `giteaDrawDebug()` in the browser console on the page in question.

**If it is not defined**, `gitea-draw.js` did not run. Find out which of the two
reasons it is, in the console -- this lists all three script tags, and the first
one is the one `giteaDrawDebug()` comes from:

```js
[...document.scripts].map((s) => s.src).filter((s) => s.includes('gitea-draw'))
```

* **Empty** -- the `<script>` tags are not in the page, so `header.tmpl` is not
  being read. Check `<custom>/templates/custom/header.tmpl` really is under the
  *Custom File Root Path* the admin panel reports, and restart Gitea (templates
  are read at startup).
* **Not empty** -- the tag is there but the file did not execute. Open exactly
  that URL, `?v=` and all: a stale cached copy and a 404 both look like this.
  Reloading `/assets/js/gitea-draw.js` without the `?v=` refreshes a *different*
  cache entry and will not help. `install.sh` stamps a fresh `?v=` on every run
  for this reason, but it only takes effect after a Gitea restart.

**If it is defined**, it prints what the script sees. `scripts` and
`cssRevision` tell you whether the browser is running the versions you
installed -- every file is cached on its own, so one can be stale while the
others are current. `scripts` has one entry per script that loaded, with its URL
and its revision; a missing entry means that file 404'd or was never installed,
which shows up as a drawing that records nothing (`gitea-draw-history.js`) or
one with no **▶ Play the edit history** button (`gitea-draw-playback.js`). On a
file editor page `codeEditors` must be at least 1 -- if it is 0, either Monaco
has not finished loading, or your Gitea is too old to publish
`window.codeEditors`.

If the pencil button works but **Align…** is not in the selection menu, open a
board first and run `giteaDrawDebug()` again: `alignmentHooked` is only set once
a board has been opened, and `alignmentProblem` says what stopped it.

`history` reports the recorder. With a board open it is an object:
`commands` and `entries` are how much has been recorded, `undoStack` how far
Ctrl+Z can still go, `sessions` how many editing sessions the drawing has been
through, `rejected` why a stored log was not used (recording carries on
regardless), and `problem` why this drawing will be saved without a log at all.
After a board is closed it holds the last board's report. If a drawing that
should have one does not, `drawingsWithHistory` on the page it is rendered on
says whether the fence carries a log to begin with.

`player` is filled in while a player is open: `position` and `total` are how far
through the log it is, `components` is what is on the canvas at that step,
`dirty` says whether there are unsaved edits to the history, and `editable` says
whether the markdown behind the drawing could be found at all.

`boardCanvas` is filled in while a board is open: `drawing` is where the drawing
sits on the canvas, `visible` is where the board is looking. If a reopened
drawing shows up zoomed into a corner, or with a stray grey box beside it, these
two will not overlap -- the drawing is somewhere the view is not.
* js-draw follows `prefers-color-scheme` for its own chrome rather than Gitea's
  theme setting. Drawings themselves get an opaque background so they stay
  readable under any theme.

## Why not an external renderer?

`app.ini`'s `[markup.xxx]` renderers match on **file extension** and hand a whole
file to an external command; `RENDER_CONTENT_MODE = iframe` can even run a full
editor in a sandboxed iframe. But that only works for standalone files, not for a
marker inside markdown, and the sandbox deliberately withholds `allow-same-origin`
(`modules/setting/markup.go`), so the iframe has no credentials and cannot save
back without a separate token. It is a fine route for viewing `.excalidraw`-style
files, and the wrong one for "draw here, save with the text".
