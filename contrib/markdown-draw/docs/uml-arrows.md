# UML relationship arrows

Analysis and implementation plan for drawing UML class-diagram relationships --
composition, generalization ("inheritance") and realization -- on the
markdown-draw board.

Against js-draw **1.33.0**, the version `install.sh` pins.

## Short answer

**No, not today.** js-draw has exactly one arrowhead -- a solid filled triangle
-- and no dashed lines, so none of the six UML relationship notations can be
drawn except by hand, stroke by stroke.

**It can be added without touching js-draw**, through
`EditorSettings.pens.additionalPenTypes`, a documented extension point. A
verified prototype draws all six notations correctly; see
[What was verified](#what-was-verified). Estimated work: ~250 lines in
`gitea-draw.js`, one test suite, a README section.

## What UML needs and what js-draw has

A class diagram distinguishes its relationships by two things: the shape of the
head, and whether the line is solid or dashed.

| Relationship | Line | Head | js-draw |
|---|---|---|---|
| Association | solid | open barbs `>` | no (its arrow is filled) |
| Generalization (inheritance) | solid | hollow triangle `▷` | no |
| Realization (implements) | **dashed** | hollow triangle `▷` | no |
| Composition | solid | filled diamond `◆` | no |
| Aggregation | solid | hollow diamond `◇` | no |
| Dependency | **dashed** | open barbs `>` | no |

js-draw's pen offers eight stroke types
(`dist/mjs/toolbar/widgets/PenToolWidget.mjs`): three freehand pens, then the
shape pens *arrow*, *line*, *filled rectangle*, *outlined rectangle* and
*outlined circle*. Of those:

* **Arrow** (`components/builders/ArrowBuilder.mjs`) builds one closed,
  filled path -- stem plus a solid triangular head. The head shape is not
  configurable and it is always filled.
* **Nothing is dashed.** A stroke's style is
  `{fill: Color4, stroke?: {color, width}}` (`rendering/RenderingStyle.d.ts`) --
  there is no dash array, and the SVG renderer writes only `fill`, `stroke` and
  `stroke-width` (`rendering/renderers/SVGRenderer.mjs`).

So the six notations above need four new head shapes and a dashed shaft, none of
which exist.

Two further gaps are worth naming, because they are what separates "UML arrows"
from "UML diagrams": js-draw has **no connectors** (a line does not attach to a
box, so moving the box leaves the line behind) and **no labels on lines**
(multiplicities, role names). Those are out of scope here -- see
[Out of scope](#out-of-scope).

## The extension point

js-draw takes custom pens as a public setting:

```js
new jsdraw.Editor(host, {
  pens: {additionalPenTypes: [{id, name, isShapeBuilder: true, factory}]},
});
```

`factory` is a `ComponentBuilderFactory`: `(startPoint, viewport) => builder`,
where the builder implements `getBBox()`, `build()`, `preview(renderer)` and
`addPoint(point)` (`components/builders/types.d.ts`).

This matters for this branch specifically: the **Align…** menu and the drag
guides reach past js-draw's public API and are written to fail gracefully if it
changes. Custom pens need none of that -- `additionalPenTypes` is public,
documented and covered by js-draw's own examples. Nothing here is a hack.

Three details fall out of it for free:

* **Icons.** `IconProvider.makeIconFromFactory` runs the builder from (10,10) to
  (90,90) and renders the result, so each pen gets a toolbar icon that is
  literally a picture of what it draws.
* **Saved toolbar state.** `PenToolWidget` serializes the selected pen by its
  `id` string, not its index, so adding pens does not disturb what users already
  have in `localStorage`, and an id that is gone falls back silently. The
  branch's `TOOLBAR_STATE_KEY` needs no migration.
* **Keyboard shortcuts** (Ctrl+1…9) index into the pen list; custom shape pens
  are appended after the built-in shape pens, so the existing shortcuts keep
  pointing at the same pens.

## The one real constraint: one style per arrow

An arrow is naturally two things -- a shaft and a head -- and it is tempting to
build it as one `Stroke` with two differently-styled parts (say, a stroked shaft
and a filled head). **That breaks the round trip**, and this is the finding that
shapes the whole design:

* `SVGRenderer.drawPath` merges consecutive parts that share a style into a
  single `<path d="…">`, and starts a new `<path>` element as soon as the style
  changes.
* `SVGLoader.addPath` creates **exactly one `Stroke` per `<path>`** ("Adds a
  stroke with a single path").

A drawing lives in the markdown as SVG text, so every drawing is saved and
reloaded constantly. A two-style arrow would come back as *two* components:
selecting it would take two clicks, moving it would need both, undo would take
two steps, and this branch's alignment feature -- which aligns whole components
-- would line up the head and the shaft against each other.

So: **each arrow must be a single `Stroke` with a single style**, which means
building everything as filled geometry, the idiom `ArrowBuilder`, `LineBuilder`
and `RectangleBuilder` already use.

That is achievable for all six notations:

* **Shaft** -- a filled quad, as `LineBuilder` does.
* **Dashed shaft** -- several filled quads, one per dash. Multiple subpaths in
  one `d`, one style, one `<path>`.
* **Filled head** (composition's diamond) -- a filled polygon.
* **Hollow head** (the triangles and aggregation's diamond) -- a *band*: the
  outer polygon, then the inset polygon wound in the opposite direction. SVG's
  default `fill-rule: nonzero` turns the inner one into a hole. js-draw already
  relies on this for its outlined rectangle, where `Path.fromRect(rect, width)`
  builds the same outer/inner pair.

## What was verified

A prototype of all six pens was run in Chromium against the pinned js-draw
1.33.0 bundle. Results:

* All six appear in the pen dropdown under **Shape**, with auto-generated
  icons, from `additionalPenTypes` alone.
* Six arrows drawn produced **six components and seven `<path>` elements** in
  the exported SVG (the seventh is the background) -- one path per arrow, as
  required.
* Reloading that SVG into a fresh editor produced **six components** again, so
  the round trip holds.
* No `fill-rule` attribute is emitted, so the browser default `nonzero` applies
  and the hollow heads render as holes. Confirmed visually: hollow triangle,
  hollow diamond, filled diamond and open barbs all read correctly, solid and
  dashed.

The exported path for a generalization arrow, showing outer triangle, inner
triangle and shaft in one `d`:

```
M360,40l-30,16l0-32l30,16 m-25,-7l0,14l13,-7l-13,-7 m-295,4l290,0l0,6l-290,0
```

Two bugs the prototype run surfaced, both of which the plan below has to handle:

* A shaft of zero length -- when the arrow is shorter than its own head --
  normalizes a zero vector and writes `NaN` into the path. This is not
  hypothetical: `makeIconFromFactory` draws a 113-unit arrow at whatever the
  current pen thickness is, so a thick pen hits it while merely *opening the
  toolbar*.
* Long pen names ("UML generalization") overflow the dropdown's grid cells.

## Implementation plan

### 1. Geometry helpers in `gitea-draw.js` (~120 lines)

A new section, following the existing alignment section's shape: pure functions,
no js-draw internals.

```js
polygon(out, points)              // closed subpath
insetPolygon(points, d)           // offset each edge inwards, miter the corners
band(out, points, w)              // polygon + reversed inset polygon -> a hole
segment(out, from, to, w)         // filled quad
dashedSegment(out, from, to, w, dash)
```

Then a head table, each entry drawing into the command list and returning how
much of the shaft it covers (zero for open barbs, whose shaft runs to the tip):

```js
HEADS = {hollowTriangle, filledDiamond, hollowDiamond, openArrow}
HEAD_LENGTHS = {hollowTriangle: 5, filledDiamond: 6, hollowDiamond: 6, openArrow: 4}
```

`HEAD_LENGTHS` is in multiples of the pen width and exists to clamp the head:
`headWidth = min(w, distance / (2 * HEAD_LENGTHS[head]))`, which is what
`ArrowBuilder` does with `Math.min(lineWidth, arrowLength / 2)`. Together with an
early return in `segment` for a degenerate shaft, that closes the `NaN` hole
above. **Both are required, not optional hardening.**

### 2. The builder (~40 lines)

One class parameterized by `{head, dashed}`, mirroring `RectangleBuilder`'s
`filled` flag:

```js
buildPreview() {
  // ... clamp the head, walk HEADS[this.head], then the shaft
  const path = new Path(from, commands).mapPoints((p) => this.viewport.roundPoint(p));
  return new Stroke([pathToRenderable(path, {fill: this.startPoint.color})]);
}
```

`viewport.roundPoint` keeps the exported `d` free of long decimals -- this is
markdown that lands in a diff, so it is worth the call.

All of `Path`, `PathCommandType`, `Vec2`, `Stroke` and `pathToRenderable` are on
`window.jsdraw`; nothing new needs loading.

### 3. Snap-to-grid (~20 lines)

Every built-in shape pen is wrapped in `makeSnapToGridAutocorrect`, which is what
makes a shape snap to the grid when the pen is held still or Ctrl is used. It is
**not** exported from the package, so it has to be re-implemented -- it is a
thin builder wrapper whose only js-draw call is the public
`viewport.snapToGrid`. Without it the UML pens would behave subtly differently
from the pens next to them in the same dropdown.

### 4. Wiring (~15 lines)

```js
editor = new jsdraw.Editor(elHost, {
  wheelEventsEnabled: 'only-if-focused',
  appInfo: {name: 'Gitea', description: 'markdown drawing'},
  pens: cfg.umlPens ? {additionalPenTypes: umlPenTypes(jsdraw)} : null,
});
```

Plus a `umlPens: true` entry in `cfg` (documented in the README's Configuration
section alongside `alignment` and `snapDistance`), and a `umlPens` line in
`giteaDrawDebug()`, so a missing pen can be told from a stale cache the same way
`alignmentHooked` already does.

Names go in the existing `i18n` object. Keep them short -- **Generalization**,
**Realization**, **Composition**, **Aggregation**, **Association**,
**Dependency** -- because of the grid overflow noted above. Prefixing each with
"UML" is what caused it.

Bump `SCRIPT_REVISION`.

### 5. Tests (`test/suites/uml-pens.mjs`)

Following the existing suites, driving the real board in the harness:

1. The six pens appear in the pen dropdown.
2. Drawing with one adds **exactly one** component.
3. The exported SVG contains exactly one `<path>` for it.
4. Reloading the export yields one component again (the round trip).
5. The hollow heads' `d` contains two closed subpaths for the head, and the
   dashed ones contain more subpaths than their solid counterparts.
6. A very short drag -- shorter than the head -- produces a path with no `NaN`.
   This is the regression test for the bug above.

Register it in `run.mjs` next to the other suites.

### 6. README

A section under **Use**, a row in the toolbar description, `umlPens` in
**Configuration**, and one line in **Limitations** saying what these pens are
not (see below).

## Risk

Low. The whole feature is public API, so unlike **Align…** it cannot be broken
by a js-draw internal changing. If `additionalPenTypes` ever disappeared, the
`Editor` constructor would ignore the unknown setting and the pens would simply
not appear.

Drawings are unaffected in both directions: what these pens produce is ordinary
filled SVG paths, so a drawing made with them opens, renders, erases and aligns
in an install that does not have them -- and in js-draw itself.

Two behaviours to document rather than fix:

* The eraser splits a UML arrow the way it splits any stroke -- half an arrow is
  a possible state.
* Head size scales with pen thickness, so a thick pen gives a big head. That is
  consistent with js-draw's own arrow.

## Out of scope

These pens make UML arrows easier to *draw*. They do not make the board a UML
tool:

* **Connectors don't stick.** Move a class box and its arrows stay put. Real
  anchoring needs a component that references two others, which js-draw's
  component model does not have -- a much larger piece of work than this one.
* **No class boxes** (name / attributes / operations compartments) and **no
  labels on lines** (multiplicities, role names). The text tool can put text
  anywhere, but it is not attached to anything.
* **No routing.** Lines are straight, point to point; orthogonal elbow routing
  would need a multi-segment builder.

For a *maintained* class diagram -- one that gets edited as the code changes --
Gitea's built-in mermaid `classDiagram` is the better tool: it is text, it
diffs, and its layout is computed. markdown-draw's place is the sketch that
mermaid cannot express, and these pens are for making that sketch read as UML.
