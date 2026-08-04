# UML relationship arrows

Why the six UML class-diagram relationships -- composition, generalization
("inheritance"), realization and the rest -- could not be drawn on the
markdown-draw board, and how they were added.

Against js-draw **1.33.0**, the version `install.sh` pins.

The pens themselves are **shipped**: see
[UML relationship arrows](../README.md#uml-relationship-arrows) for what they
do. This is the design record -- the constraint that shaped them, what was
measured rather than assumed, and what was deliberately left out.

## Short answer

js-draw has exactly one arrowhead -- a solid filled triangle -- and no dashed
lines, so none of the six UML relationship notations could be drawn except by
hand, stroke by stroke.

They were added without touching js-draw, through
`EditorSettings.pens.additionalPenTypes`, a documented extension point. The one
thing that shaped the design is that **an arrow has to be a single stroke with a
single style**; see [the constraint](#the-one-real-constraint-one-style-per-arrow).

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

Two bugs the prototype run surfaced, both of which the shipped pens handle:

* A shaft of zero length -- when the arrow is shorter than its own head --
  normalizes a zero vector and writes `NaN` into the path. This is not
  hypothetical: `makeIconFromFactory` draws a 113-unit arrow at whatever the
  current pen thickness is, so a thick pen hits it while merely *opening the
  toolbar*.
* Long pen names ("UML generalization") overflow the dropdown's grid cells.

## What it is made of

All of it is one section of `custom/public/assets/js/gitea-draw.js`, plus a
`umlPens` flag in `cfg` and a line in `giteaDrawDebug()`. Three parts are worth
pointing at, because none of them is obvious from the code alone.

**The head is clamped to the arrow.** `UML_HEAD_LENGTHS` gives each head a
length in multiples of the pen width, and the builder uses
`min(w, distance / (2 * length))` -- the same shape as `ArrowBuilder`'s
`Math.min(lineWidth, arrowLength / 2)`. Together with an early return in
`umlSegment` for a degenerate shaft, that is what keeps `NaN` out of the path.
Both are load-bearing, not hardening: js-draw draws a 113-unit arrow at the
current thickness to generate each pen's toolbar icon, so a thick pen would hit
the zero-length shaft just by opening the toolbar. The suite drags six pixels to
keep it that way.

**Snap-to-grid is reimplemented.** Every shape pen js-draw ships is wrapped in
`makeSnapToGridAutocorrect`, which is what snaps a shape when the pen is held
still. It is not exported from the package, so `withSnapToGrid` reproduces it --
a thin builder wrapper whose only call into js-draw, `viewport.snapToGrid`, is
public. Without it these pens would behave differently from the ones beside them
in the same dropdown, for no reason a user could see.

**The names are short on purpose.** js-draw lays pen types out in a grid whose
cells "UML generalization" overflows; "Generalization" fits.

`viewport.roundPoint` keeps the exported `d` free of long decimals, which
matters more here than in most drawing tools: this is markdown someone has to
read in a diff.

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

## Metadata on the path

Can an exported path say *what it is* -- `data-uml="composition"` rather than
just an anonymous filled polygon? Yes, and it survives a full round trip, but
not by the obvious route.

### What does not work

js-draw already has the machinery: `AbstractComponent.attachLoadSaveData(key,
data)` is public, and `'svgAttrs'` is the key `SVGLoader` itself uses for
attributes it does not recognise. Attach `['data-uml', 'composition']` to a
`Stroke` and `toSVGAsync()` writes it out:

```
<path d="M300,40l-18,11l-18-11l18-11l18,11m-260-3l224,0l0,6l-224,0l0-6"
      fill="#000000" data-uml="composition"/>
```

**But reading it back drops it.** `SVGLoader` only records unrecognised
attributes when `storeUnknown` is set, and `storeUnknown = !sanitize`. The board
loads with `editor.loadFromSVG(initialSvg, true)`, so on the first re-edit the
attribute is gone, and the next save writes the drawing back without it. The
failure is silent: the drawing looks right, the metadata has evaporated.

Turning `sanitize` off would preserve it -- and would also preserve every *other*
attribute in an attacker-authored fence, writing them back into the markdown
verbatim. `onload="…"` would survive a round trip through another user's
browser. The drawing is displayed through an `<img>` and a blob URL, so it would
not execute today, but it makes the security note in the README false and the
next refactor dangerous. Not an option.

### What works

`EditorSettings.svg.loaderPlugins` is public and independent of `sanitize`: a
plugin's `visit(node, loader)` sees each node first, and returning `true` takes
the node over. So the customization recognises **its own** attribute, and
sanitization keeps handling everything else:

```js
const UML_TYPES = ['generalization', 'realization', 'composition',
  'aggregation', 'association', 'dependency'];

const umlLoaderPlugin = (jsdraw) => ({
  async visit(node, loader) {
    if (node.tagName.toLowerCase() !== 'path') return false;
    const kind = node.getAttribute('data-uml');
    // re-emit a value from this list, never the string the file supplied
    if (!UML_TYPES.includes(kind)) return false;
    const fill = node.getAttribute('fill');
    if (!fill || fill === 'none') return false;
    const stroke = new jsdraw.Stroke([
      jsdraw.pathToRenderable(
        jsdraw.Path.fromString(node.getAttribute('d')),
        {fill: jsdraw.Color4.fromString(fill)},
      ),
    ]);
    stroke.attachLoadSaveData('svgAttrs', ['data-uml', kind]);
    await loader.addComponent(stroke);
    return true;
  },
});
```

The security property is not "we sanitize the value" but "**we never carry the
file's string**": `kind` is only used after it has matched one of six literals,
and what gets attached is that literal. A fence author cannot get an attribute
of their choosing back out of the editor.

### Verified

Run against the pinned js-draw 1.33.0 in Chromium:

* Attached metadata reaches the exported SVG.
* Reloading with `sanitize = true` -- what the board does -- **loses it**; with
  `sanitize = false` it survives. Both confirm the analysis above.
* With the plugin and `sanitize` still `true`: the attribute survives, and the
  arrow is still **one component and one `<path>`**.
* It survives being moved -- `transformBy` clones the component and
  `AbstractComponent.clone` copies the load/save data.
* A `<path data-uml="composition" onload="alert(1)">` in the same file comes
  back with `data-uml` kept and `onload` **dropped**.
* The `d` a plugin-loaded arrow re-exports is byte-identical to what js-draw's
  own loader produces.

One subtlety, in case the plugin is ever generalised: js-draw's `addPath` splits
a path's `d` at each `M` into separate parts. It never fires on this
customization's output, because js-draw writes subsequent subpaths with a
relative `m` -- but a plugin that took over arbitrary paths would need to
mirror the split to stay faithful.

### Worth it?

Only if something consumes it, and **nothing does yet**, which is why the
shipped pens do not write it: they draw ink, and ink needs no label. Metadata is
the enabling step for things that do not exist -- retyping an arrow from
composition to aggregation without redrawing it, telling arrows from boxes so a
future anchoring feature knows what to anchor, or exporting a sketch to mermaid.

The cost is ~60 lines and one new js-draw setting, but the real cost is that
metadata nothing reads goes stale. Partial erase is the clearest case: the
eraser splits a stroke into new `Stroke` objects, and half a composition arrow
would either lose the label (fine) or keep it while no longer being one (a lie).
Adding it later is no harder than adding it now -- an arrow drawn without
`data-uml` is not corrupt, just unlabelled, and nothing needs migrating -- so it
waits for the first feature that reads it.

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
