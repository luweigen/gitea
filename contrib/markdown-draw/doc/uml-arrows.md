# How the UML relationship pens came out this way

Notes for whoever maintains this next. [README.md](../README.md#uml-relationship-arrows)
says what the pens do and how to configure them; this says **why they are built
the way they are**, which decisions were forced rather than chosen, and which
mistakes are already paid for. Most of it is here because it is not visible from
the code: the geometry looks needlessly indirect until you know what it is
avoiding.

Line references are to **js-draw 1.33.0**, `dist/mjs/…`, which is what
`install.sh` pins. Re-check them after an upgrade -- there is a checklist at the
end.

## 1. The decision everything else follows from

**An arrow is one `Stroke` with one style.** Everything -- shaft, dashes, head,
hollow head -- is filled geometry in a single path with a single `fill`. There
is no `stroke` anywhere in it.

This is not a preference. It is forced by two facts that meet:

> `SVGRenderer.drawPath` merges consecutive parts that share a style into one
> `<path d="…">` and starts a **new `<path>` element** as soon as the style
> changes (`rendering/renderers/SVGRenderer.mjs`, `drawPath` +
> `addPathToSVG`).
>
> `SVGLoader.addPath` creates **exactly one `Stroke` per `<path>`** -- its own
> comment is "Adds a stroke with a single path" (`SVGLoader/SVGLoader.mjs`).

A drawing lives in the markdown as SVG text, so it is saved and reloaded
constantly; a re-edit is a round trip. An arrow built the natural way -- a
stroked shaft plus a filled head, two styles -- would look correct when drawn
and come back as **two components** the next time anyone opened it. Then:
selecting it takes two clicks, moving it needs both, undo takes two steps, and
the alignment feature, which aligns whole components, lines the head up against
its own shaft.

The failure would appear one session later than the change that caused it, in a
feature that did not change. That is why this is section 1.

**Consequence to keep in mind:** any future head shape must be expressible as
filled geometry. If a shape seems to need a second style, it needs a second
element, and that is a different feature (see §8).

## 2. What UML needs, and what js-draw has

A class diagram tells its relationships apart by two things: the shape of the
head, and whether the line is solid or dashed.

| Relationship | Line | Head | js-draw has it? |
|---|---|---|---|
| Association | solid | open barbs `>` | no -- its arrow is filled |
| Generalization (inheritance) | solid | hollow triangle `▷` | no |
| Realization (implements) | **dashed** | hollow triangle `▷` | no |
| Composition | solid | filled diamond `◆` | no |
| Aggregation | solid | hollow diamond `◇` | no |
| Dependency | **dashed** | open barbs `>` | no |

js-draw's pen offers eight stroke types
(`toolbar/widgets/PenToolWidget.mjs`): three freehand pens, then the shape pens
*arrow*, *line*, *filled rectangle*, *outlined rectangle*, *outlined circle*.

* **Arrow** (`components/builders/ArrowBuilder.mjs`) is one closed filled path,
  stem plus a solid triangular head. The head is not configurable and is always
  filled.
* **Nothing is dashed.** A stroke's style is
  `{fill: Color4, stroke?: {color, width}}` (`rendering/RenderingStyle.d.ts`) --
  no dash array, and the SVG renderer writes only `fill`, `stroke` and
  `stroke-width`.

So four head shapes and a dashed shaft had to be built. Nothing was extended;
they are new builders that happen to sit in the same list.

## 3. The extension point, and why nothing here is a hack

```js
new jsdraw.Editor(host, {
  pens: {additionalPenTypes: [{id, name, isShapeBuilder: true, factory}]},
});
```

`factory` is a `ComponentBuilderFactory`: `(startPoint, viewport) => builder`,
where the builder implements `getBBox()`, `build()`, `preview(renderer)` and
`addPoint(point)` (`components/builders/types.d.ts`).

This is worth stating plainly because of what sits beside it in the same file:
the **Align…** menu and the drag guides shadow members js-draw declares
`private`, and are written to fail gracefully when it changes. The UML pens need
none of that. `additionalPenTypes` is public, documented, and has js-draw's own
examples pointing at it. **Do not "harmonise" the two -- they are different in
kind, not in style.**

Three things fall out of it for free, all of which would otherwise be work:

* **Icons.** `IconProvider.makeIconFromFactory` runs the builder from (10,10) to
  (90,90) at `sqrt(thickness) * 3` and renders the result, so each pen's toolbar
  icon is literally a picture of what it draws. It is also the reason for the
  bug in §5.1 -- generating an icon is a *real invocation of the builder*, with
  arguments no user gesture would produce.
* **Saved toolbar state.** `PenToolWidget.deserializeFrom` matches on the pen's
  `id` string, not its index, so adding pens does not disturb what users already
  have in `localStorage`, and an id that has gone away falls back silently. The
  `TOOLBAR_STATE_KEY` in `gitea-draw.js` needed no migration.
* **Keyboard shortcuts.** Ctrl+1…9 index into the pen list, and custom shape
  pens are appended *after* the built-in shape pens, so existing shortcuts keep
  pointing at the same pens.

## 4. The geometry, and the shape it was nearly built in

Everything is assembled into one command list and handed to
`new Path(from, commands)`, then one `pathToRenderable(path, {fill})`.

| helper | what it emits |
|---|---|
| `umlPolygon` | one closed subpath |
| `umlSegment` | a straight run as a filled quad |
| `umlDashedSegment` | that, broken into dashes -- several subpaths, same style |
| `umlInsetPolygon` | a convex polygon offset inwards, corners mitered |
| `umlBand` | the outline, then the inset outline **reversed** |

`umlBand` is the load-bearing trick: SVG's default `fill-rule: nonzero` turns a
subpath wound the opposite way into a **hole**, so a hollow head is a filled
ring rather than a stroked outline. js-draw relies on the same thing for its
outlined rectangle, where `Path.fromRect(rect, lineWidth)` builds exactly this
outer/inner pair (`components/builders/RectangleBuilder.mjs`). js-draw writes no
`fill-rule` into the paths it exports -- measured, not assumed -- so the default
is what applies. **If it ever starts writing `fill-rule="evenodd"`, every hollow
head fills in solid.**

Each entry in `UML_HEADS` draws itself at the tip and returns **how much of the
shaft it covers**, so a solid line does not show through a hollow head. Open
barbs return `0`: they are not closed, so the line runs to the point.

### The dead end worth knowing about

The obvious alternative is `{fill: transparent, stroke: {color, width}}` -- draw
centrelines and let SVG stroke them. js-draw's own `CircleBuilder` does exactly
that, so it is a sanctioned idiom, and it makes five of the six notations
trivial: the shaft is a line, the hollow heads are unfilled closed polygons,
corners get js-draw's `stroke-linejoin: round` for free, and `umlInsetPolygon`
would not need to exist.

It fails on **composition**, and only on composition. A filled diamond on a
plain line needs fill *and* line in the same element, and under a stroke-only
style the diamond comes out hollow -- which is precisely the notation for
aggregation. Composition and aggregation differ *by that fill*; getting it wrong
does not look like a rendering glitch, it silently draws the wrong relationship.

Mixing the two idioms -- stroke style for five pens, fill style for composition
-- would work and was rejected: two pens sitting next to each other in one
dropdown would then respond differently to scaling (js-draw scales
`stroke.width` with the geometry but fills follow the path), and a maintainer
would have to know which pen they were touching. One idiom, six pens.

## 5. Bugs already paid for

These encode invariants. Each is a place where the obvious code is wrong.

### 5.1 A zero-length shaft writes `NaN` into the path

When the arrow is shorter than its own head, the head eats the whole shaft, and
`to.minus(from).normalized()` on a zero vector produces `NaN` -- which lands in
the `d` attribute and the browser rejects the whole path.

This is **not** an edge case a user has to work at. It was found by the very
first prototype run, in the console, before a single deliberate short arrow had
been drawn: `makeIconFromFactory` (§3) draws a 113-unit arrow at the current
thickness to build each pen's toolbar icon, so a thick pen hits it *while merely
opening the toolbar*.

Two things fix it and **both are required**:

* `UML_HEAD_LENGTHS` + `min(w, distance / (2 * length))` clamps the head to half
  the arrow -- the same shape as `ArrowBuilder`'s
  `Math.min(lineWidth, arrowLength / 2)`, which exists for the same reason.
* `umlSegment` returns early on a degenerate run.

The suite drags six pixels to keep both honest.

### 5.2 "UML generalization" does not fit

js-draw lays pen types out in a grid; the longer name overflowed its cell and
collided with its neighbours. The names are `Generalization`, `Realization`, …
with no prefix. If a name ever needs lengthening, look at the grid first.

### 5.3 The test harness: two things that are not guessable

Both cost a debugging round, and neither is discoverable without dumping the DOM:

* js-draw names a pen type in **`label[title="Generalization"]`**, not in a text
  node with a class of its own. Selecting on a `.toolbar-button-label`-style
  class silently matches nothing.
* Choosing a pen leaves the dropdown **open and covering the middle of the
  canvas**. A drag started there hits the dropdown, not the drawing, so
  `choosePen` closes it before returning.

## 6. How it was built, and why in that order

Worth recording because the order is what caught §5.1 before it reached anyone:

1. **Read the pinned bundle, not the docs.** `js-draw-1.33.0.tgz` was unpacked
   and `dist/mjs/` read directly -- `ArrowBuilder`, `RectangleBuilder`,
   `CircleBuilder`, `PenToolWidget`, `SVGRenderer`, `SVGLoader`. The
   one-style-per-arrow constraint (§1) is not in any documentation; it is two
   facts in two files that only matter when you put them together.
2. **Prototype against the real bundle in a bare page**, before touching
   `gitea-draw.js`: all six builders, a plain `Editor`, drawn programmatically,
   exported, reloaded, counted. This is where the `NaN` appeared and where the
   round trip was first confirmed by counting components rather than by
   eyeballing a screenshot.
3. **Then** port into `gitea-draw.js` and drive it through the real harness.

Step 2 is the cheap one to skip and the expensive one to have skipped: the
prototype tests things the browser suite cannot reach easily, such as loading an
exported SVG into a second editor and comparing component counts.

## 7. Testing

`test/suites/uml-pens.mjs`. Every check goes through **the saved SVG**, not
js-draw's in-memory model -- what matters is the geometry that lands in the
markdown, and the markdown is also the only thing the board can read back.

The instrument for "is this the right notation" is **counting subpaths**
(`[Mm]` in the `d`), which works because of §1: everything is one path, so the
count is a direct statement about the geometry.

* A hollow head is a band -- outline plus reversed inset -- so it is one subpath
  more than the filled version of the same shape.
* A dashed shaft is one subpath per dash, so it is far more than a solid one.
  The check is `>= 6` against a `<= 3` for solid; the exact number follows from
  the drag length and is not worth pinning.

Also asserted:

* **One arrow is one path, and still one path after a reload** -- with its `d`
  unchanged. This is §1's regression test; if it ever fails, something has
  started emitting two styles.
* **A six-pixel drag produces no `NaN`** -- §5.1.
* **An arrow records and replays** through the edit-history log. It works
  because the recorder stores what a command serializes to rather than the pen
  that produced it, so a UML arrow is a `Stroke` like any other. That is
  asserted rather than assumed on purpose: a pen that built its shape out of
  something js-draw could not serialize would break the log **for the whole
  drawing**, not only for itself.

## 8. Metadata on the path: designed, verified, not shipped

Can an exported path say *what it is* -- `data-uml="composition"` rather than an
anonymous filled polygon? Yes, and it survives a full round trip, but not by the
obvious route. It is written up here because the obvious route **fails
silently**, and the next person to want this should not have to rediscover that.

### What does not work

`AbstractComponent.attachLoadSaveData(key, data)` is public, and `'svgAttrs'` is
the key `SVGLoader` itself uses for attributes it does not recognise. Attach
`['data-uml', 'composition']` to a `Stroke` and `toSVGAsync()` writes it out:

```
<path d="M300,40l-18,11l-18-11l18-11l18,11m-260-3l224,0l0,6l-224,0l0-6"
      fill="#000000" data-uml="composition"/>
```

**But reading it back drops it.** `SVGLoader` only records unrecognised
attributes when `storeUnknown` is set, and `storeUnknown = !sanitize`. The board
loads with `editor.loadFromSVG(initialSvg, true)`, so on the first re-edit the
attribute is gone and the next save writes the drawing back without it. Nothing
reports this: the drawing looks right, the metadata has evaporated.

Turning `sanitize` off preserves it -- and preserves every *other* attribute in
an attacker-authored fence, writing them back into the markdown verbatim.
`onload="…"` would survive a round trip through another user's browser. It would
not execute today, because drawings render through an `<img>` and a blob URL,
but it makes the README's security note false and the next refactor dangerous.
Not an option.

### What works

`EditorSettings.svg.loaderPlugins` is public and independent of `sanitize`: a
plugin's `visit(node, loader)` sees each node first, and returning `true` takes
the node over. So the customization recognises **its own** attribute while
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

The security property is not "the value is sanitized" but "**the file's string is
never carried**": `kind` is used only after matching one of six literals, and
what gets attached is that literal. A fence author cannot get an attribute of
their choosing back out of the editor.

Verified in Chromium against the pinned js-draw: the attribute reaches the
export; a `sanitize = true` reload loses it and a `sanitize = false` reload
keeps it (both confirming the analysis); with the plugin and `sanitize` still
`true` it survives and the arrow is still one component and one `<path>`; it
survives being moved, because `transformBy` clones and `AbstractComponent.clone`
copies load/save data; and `<path data-uml="composition" onload="alert(1)">`
comes back with `data-uml` kept and `onload` dropped.

One subtlety if the plugin is ever generalised: `SVGLoader.addPath` splits a
path's `d` at each `M` into separate parts. It never fires on this
customization's output, because js-draw writes subsequent subpaths with a
relative `m` -- but a plugin taking over arbitrary paths would need to mirror
the split to stay faithful. (Both variants were measured; both re-export a
byte-identical `d`.)

### Why it is not shipped

Nothing reads it. The pens draw ink, and ink needs no label. Metadata is the
enabling step for things that do not exist yet -- retyping an arrow from
composition to aggregation without redrawing it, telling arrows from boxes so a
future anchoring feature knows what to anchor, exporting a sketch to mermaid.

The cost is ~60 lines and one more js-draw setting; the real cost is that
metadata nothing reads goes stale. Partial erase is the clearest case: the
eraser splits a stroke into new `Stroke` objects, and half a composition arrow
would either lose the label (fine) or keep it while no longer being one (a lie).
Adding it later is no harder than adding it now -- an arrow without `data-uml`
is not corrupt, just unlabelled, and nothing needs migrating -- so it waits for
the first feature that reads it.

## 9. After a js-draw upgrade, re-check these

`giteaDrawDebug()` reports `umlPens`, which tells "the pens are configured on"
apart from "the pens are configured on but js-draw no longer shows them".

1. `EditorSettings.pens.additionalPenTypes` is still read, and custom shape
   pens still land after the built-in ones (`PenToolWidget`'s constructor).
2. `SVGLoader.addPath` still makes **one component per `<path>`**, and
   `SVGRenderer.drawPath` still merges same-style parts into one `<path>`. §1
   rests entirely on these two. *(If a `<path>` ever became more than one
   component, or a style change stopped splitting them, most of §4 could be
   simplified -- that would be the moment.)*
3. No `fill-rule` is written into exported paths, so `nonzero` still applies and
   `umlBand` still leaves a hole (§4).
4. `PenToolWidget` still serializes the selected pen by `id` -- if it goes back
   to an index, saved toolbar state needs a migration.
5. `viewport.snapToGrid` and `viewport.roundPoint` are still public;
   `makeSnapToGridAutocorrect` is still *not* exported (if it becomes exported,
   drop `withSnapToGrid` and use it).
6. `IconProvider.makeIconFromFactory` still invokes the builder to draw an icon
   -- it is the reason the §5.1 clamps cannot be relaxed.
7. `Stroke`, `Path`, `PathCommandType` (with `MoveTo`), `Vec2` and
   `pathToRenderable` are all still on `window.jsdraw`.
8. The pen dropdown still names pen types in `label[title]` -- the suite selects
   on it (§5.3).

## 10. Deliberately not done

These pens make UML arrows easier to *draw*; they do not make the board a UML
tool.

* **Connectors that stick.** Move a class box and its arrows stay put. Real
  anchoring needs a component that references two others, which js-draw's
  component model does not have. Much larger than this piece of work, and it
  would need §8 first.
* **Class boxes** (name / attributes / operations compartments) and **labels on
  lines** (multiplicities, role names). The text tool puts text anywhere, but it
  is attached to nothing.
* **Routing.** Lines are straight, point to point. What blocks an elbow is the
  gesture, not the geometry: js-draw drives a builder from one pointer-down..up
  and `Pen.onPointerUp` discards it, so a click-per-vertex route needs a custom
  `BaseTool` rather than another pen. Fitting an elbow out of a single freehand
  drag instead is measured in [stroke-fitting.md](stroke-fitting.md).
* **Retyping an arrow** from composition to aggregation -- needs §8.
* **Protecting an arrow from the eraser.** It splits like any other stroke, so
  half an arrow is a reachable state. Making it atomic would mean a component
  type of our own, and would cost the property that these drawings open in a
  plain js-draw.

For a class diagram that is *maintained* as the code changes, Gitea's built-in
mermaid `classDiagram` is the better tool: it is text, it diffs, and its layout
is computed. markdown-draw's place is the sketch mermaid cannot express, and
these pens are for making that sketch read as UML.
