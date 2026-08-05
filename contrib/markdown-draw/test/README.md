# markdown-draw browser tests

Drives the customization in a real browser: it opens the drawing board, draws
with a mouse and with a finger, saves, and checks what landed in the markdown.

Nothing here touches a Gitea instance. The harness pages reproduce the two
editors' markup, and `/js/` and `/css/` are served straight out of
`../custom/public/assets/`, so the suites always exercise the files that ship
rather than a copy of them.

## Run

```sh
./setup.sh     # once: fetches js-draw, monaco-editor and playwright-core
./run.sh       # all suites
./run.sh colour-picker   # just one
```

`setup.sh` puts everything under `./vendor` and `./node_modules`, both
git-ignored. It needs `curl`, `tar`, `node` and `npm`, plus a Chromium: it uses
whatever `playwright-core` has downloaded, else `$CHROMIUM`, else a browser
found in `$PLAYWRIGHT_BROWSERS_PATH` or the usual system locations. If none is
found, `npx playwright install chromium` gets one.

`run.sh` exits 0 when every suite passes, 1 on a failure, 2 when the
environment is not set up. Screenshots land in `./screenshots`.

To poke at the harness by hand: `node server.mjs`, then open
<http://127.0.0.1:8765/>.

## What the suites cover

| suite | what it drives |
| --- | --- |
| `combo-editor` | the shared markdown editor (issues, PRs, comments, wiki, releases): insert, render, hostile payloads, round trip |
| `history` | recording every undoable action into the fence, replaying it into a later board, undoing across sessions, the three ways a stored log is refused, playing one back, stepping through / deleting a step / saving the result, and exporting the animation as a self-playing SVG and a video |
| `alignment` | the "Align…" entry in the selection menu, the guides that snap a drag, and the geometry both produce |
| `path-fit` | the "Fit…" entry beside "Align…" in the selection menu: where it sits, when it is offered, the geometry of its three fits, that a G keeps both of its ends, and that one undo takes the original stroke back |
| `uml-pens` | the six UML relationship pens: that each draws its notation, that an arrow stays one element across a save and reload, and that it records and replays like any other stroke |
| `mobile` | drawing with a finger, via raw CDP touch events on an iPhone-sized viewport, including a finger-driven alignment |
| `file-editor` | the repository file editor against the real Monaco build Gitea pins |
| `file-editor-layouts` | the same button across three generations of Gitea's editor markup |
| `colour-picker` | Coloris' picker, which lives outside the board and has to be stacked above it |

Two habits worth keeping when adding to them:

* **Check reachability, not presence.** A colour picker that exists behind an
  overlay looks fine to `querySelector` and is useless to a user. The picker
  suite asserts `elementFromPoint` lands on the picker; the layout suite
  asserts the button does not overlap the editor.
* **Drive the real thing.** The file editor tests load actual Monaco and read
  the result back out of the model, not out of the hidden textarea Monaco
  writes to. Faking the editor would have hidden the bug that the textarea is
  written *by* Monaco and never read from.
* **Let the page fail the suite.** An uncaught error in the browser fails the
  run even when every check passed -- `watchPage` records them and `finish()`
  reports them. A stray call that threw after doing its work was passing 101
  checks while printing a `TypeError` nobody was looking at.
* **Assert on what ships.** The alignment suite measures the saved SVG rather
  than js-draw's in-memory model: what matters is the geometry that lands in
  the markdown. Where a number would have to be assumed -- the grid spacing,
  which follows the zoom level -- it checks the property instead (snapping
  twice changes nothing the second time).

## Dependency versions

* **js-draw** comes from `../install.sh`, so the version and checksum are the
  ones users get, and the installer is exercised on every setup.
* **monaco-editor** is read from Gitea's own `package.json`, so it tracks
  whatever the repository pins. Testing against a different Monaco than the one
  Gitea ships would prove very little.

## Not covered here

* The `arrow-tool` suite lives on the
  `claude/markdown-canvas-drawing-nfnwki_arrow_button_superfluous` branch,
  together with the feature it tests.
* The legacy EasyMDE editor, which hides the markdown toolbar and with it the
  button.
* Server-side rendering: the customization is browser-side only, so there is
  nothing on the Go side to test.
