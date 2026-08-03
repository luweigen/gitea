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
<custom>/templates/custom/header.tmpl        loads the two files below
<custom>/public/assets/js/gitea-draw.js      the integration
<custom>/public/assets/css/gitea-draw.css    styles
<custom>/public/assets/js-draw/bundle.js     js-draw itself (~500 KB, lazy-loaded)
<custom>/public/assets/js-draw/bundledStyles.js
```

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
* **Read**: drawings render as images wherever markdown renders.

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

### Security

The SVG in a fence is attacker-controlled content: any user who can comment can
put anything in there. It is therefore **never** inserted into the page as live
SVG. Rendering goes through an `<img>` pointing at a blob URL, which browsers
treat as a non-interactive document -- scripts do not run and external
references are not loaded. When a drawing is opened for editing it is passed to
`editor.loadFromSVG(svg, /* sanitize */ true)`.

If you change this file, keep that property. `innerHTML = svgText` on markdown
content would be a stored-XSS hole that bypasses Gitea's server-side sanitizer.

Sources larger than `maxSourceChars` (512 KiB by default) are refused, the same
guard `MERMAID_MAX_SOURCE_CHARACTERS` provides for mermaid.

### Configuration

Override any of the defaults before `gitea-draw.js` loads, e.g. in
`header.tmpl`:

```html
<script>
  window.giteaDrawConfig = {
    assetsPrefix: "{{AssetUrlPrefix}}/js-draw",
    lang: "js-draw",            // fence info string
    maxSourceChars: 524288,
    edgeToolbarMaxWidth: 800,   // below this width, use the touch toolbar
    alignment: true,            // the "Align…" entry in the selection menu
    snapDistance: 8,            // screen px a drag snaps over, 0 to switch off
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
  tens of kilobytes of one-line SVG in the source. Fine for issue comments, worth
  thinking about for files you expect to review line by line. If that matters,
  upload drawings as attachments and link them instead -- but then they no longer
  travel with the markdown.
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

## When the button does not show up

Run `giteaDrawDebug()` in the browser console on the page in question.

**If it is not defined**, the script did not run. Find out which of the two
reasons it is, in the console:

```js
[...document.scripts].map((s) => s.src).filter((s) => s.includes('gitea-draw'))
```

* **Empty** -- the `<script>` tag is not in the page, so `header.tmpl` is not
  being read. Check `<custom>/templates/custom/header.tmpl` really is under the
  *Custom File Root Path* the admin panel reports, and restart Gitea (templates
  are read at startup).
* **Not empty** -- the tag is there but the file did not execute. Open exactly
  that URL, `?v=` and all: a stale cached copy and a 404 both look like this.
  Reloading `/assets/js/gitea-draw.js` without the `?v=` refreshes a *different*
  cache entry and will not help. `install.sh` stamps a fresh `?v=` on every run
  for this reason, but it only takes effect after a Gitea restart.

**If it is defined**, it prints what the script sees. `scriptRevision` and
`cssRevision` tell you whether the browser is running the versions you
installed -- the two files are cached independently, so one can be stale while
the other is current. On a file editor page
`codeEditors` must be at least 1 -- if it is 0, either Monaco has not finished
loading, or your Gitea is too old to publish `window.codeEditors`.

If the pencil button works but **Align…** is not in the selection menu, open a
board first and run `giteaDrawDebug()` again: `alignmentHooked` is only set once
a board has been opened, and `alignmentProblem` says what stopped it.
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
