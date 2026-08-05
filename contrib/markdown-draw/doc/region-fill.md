# How filling a closed area came out this way

Notes for whoever maintains this next. [README.md](../README.md#filling-a-closed-area)
says what the tool does and how to configure it; this says **why it is built the
way it is**, which decisions were forced rather than chosen, and which mistakes
are already paid for.

Line references are to **js-draw 1.33.0**, `dist/mjs/…`, which is what
`install.sh` pins. Re-check them after an upgrade -- there is a checklist at the
end.

All of it lives in `custom/public/assets/js/gitea-draw-fill.js`. `gitea-draw.js`
gains four lines: one editor setting, one call before the toolbar is built, one
after, and one line in `giteaDrawDebug()`.

## 0. js-draw has no fill

Worth stating, because "surely it does" is the first reaction.

js-draw's pens can draw a *filled shape* -- `filledRect`, `filledCircle`, a
freehand blob -- but that is one stroke's own geometry, decided as it is drawn.
There is no bucket, no flood fill, no fill tool of any kind: `tools/` has Pen,
Eraser, Selection, Text, PanZoom, Pipette, Find, Scrollbar and Sound, and none
of them looks at what is already on the canvas in order to paint the space
between it. Grepping the whole package for `flood`, `bucket` or `fill.*tool`
returns nothing.

So drawing a box out of four separate lines and then wanting the inside coloured
is not something the editor can do, which is the gap this fills.

## 1. Why a raster, and not the geometry

The tool renders everything already drawn into an offscreen canvas and flood
fills the pixels. That looks like the crude option next to intersecting the
paths, and it is the correct one.

**"Closed" means closed as drawn.** Four separate strokes whose ends merely
overlap enclose an area to the eye and to a flood fill. As four *open paths*
they do not intersect in any way a point-in-polygon test could use, and no
amount of path algebra turns them into one closed loop without deciding, by some
tolerance, which ends count as joined -- which is the same judgement the raster
makes, only with a worse answer at the corners.

Working from pixels also puts the boundary exactly where the user sees one:
along the *inside edge of the ink*, thickness and all, rather than along the
mathematical centre line of a stroke that is six units wide.

Three consequences fall out of this and are not negotiable:

* The raster is taken **without the background**. A drawing's background is an
  opaque white page covering everything; with it in the raster every pixel is a
  wall. `EditorImage.getAllComponents()` documents that it leaves background
  components out, which is what the code relies on.
* Existing fills are left out too. Paint is not something new paint should have
  to flow around, and a fill is translucent anyway, so it would be a wall made
  of nothing.
* **Escaping the raster is the whole test for "closed".** The raster is taken a
  few pixels larger than everything drawn, so paint reaching its edge is paint
  that got out. There is no other check, and there does not need to be one.

## 2. The three things the raster does

`inkMask` reads **only the alpha channel**. The paint is stopped by anything
drawn, whatever colour it is, and by nothing else. Matching colours would mean
deciding what "close enough to the background" means, on a canvas whose
background is not in the raster.

`floodFill` is **4-connected**. A one-pixel diagonal gap in a line is therefore a
wall, which is what someone who drew a closed box expects of the corner where
two strokes cross. 8-connectivity leaks through those corners.

`growUnderInk` grows the filled area **into the ink only**, two passes by
default. Without it every fill is outlined by a hairline of background showing
through between the paint and the line that bounds it. Growing into ink alone
cannot leak into the space on the far side of a line unless the line is thinner
than the number of passes -- which is also why it is two passes and not ten.

## 3. Turning pixels back into a path

Every boundary pixel edge becomes one directed segment on the lattice between
pixels, wound so the filled side is always on the same hand. Chaining them end
to end gives the outer loop and, wound the other way round, one loop per hole.
**The nonzero fill rule then leaves the holes empty with nothing else said about
them** -- the same trick the UML pens use for a hollow arrowhead, see
[uml-arrows.md](uml-arrows.md).

Where the area pinches to a corner, two loops meet at one lattice point and
there are two ways to continue. Turning as hard as possible keeps each loop
hugging its own side rather than crossing into the other; the alternative is one
self-crossing loop, which the nonzero rule then fills wrongly.

A traced contour turns a corner at every pixel, so a sheet-sized fill is tens of
thousands of coordinates -- in markdown that someone has to read in a diff.
Collapsing the straight runs and then running Ramer-Douglas-Peucker over what is
left brings a plain rectangle down to eight points. The loop is closed and so has
no ends to anchor the simplifier to; cutting it at its two furthest-apart points
puts both anchors on corners the outline needs anyway.

## 4. Why a component of its own

A fill is *not* a `Stroke`. It cannot be:

> A js-draw rendering style is `{fill: Color4, stroke?: {color, width}}`
> (`rendering/RenderingStyle.d.ts`). A flat colour in each. There is no gradient
> anywhere in the type.

Two of the three patterns are gradients, so the component draws itself, through
the two escape hatches js-draw provides for exactly this:

| Renderer | Hatch | Used for |
|---|---|---|
| `CanvasRenderer` | `drawWithRawRenderingContext(cb)` | what the editor shows |
| `SVGRenderer` | `drawWithSVGParent(cb)` | what is saved |

Both are public and documented. The component feature-detects rather than
`instanceof`-checks, so a renderer that has neither -- the text-only one js-draw
uses for accessibility -- still gets a flat path of roughly the right colour.

**Two coordinate traps, both already paid for:**

1. `drawWithRawRenderingContext` hands back a context **already transformed into
   canvas coordinates** (it does `ctx.save(); transformBy(getCanvasToScreenTransform())`).
   So the canvas side draws in canvas coordinates and the gradient geometry can be
   used as stored.
2. `drawWithSVGParent` creates its `<g>` with `transformFrom(Mat33.identity, parent, true)`
   -- `inCanvasSpace: true`, which means **no transform is set at all**. Everything
   put inside it must already be in export coordinates, exactly like the `d`
   attribute `drawPath` writes. So the SVG side transforms the path *and the
   gradient* by `getCanvasToScreenTransform()` itself. Forgetting the gradient
   there is the bug that looks right at one zoom level and wrong at every other.

## 5. Two round trips, not one

A component that draws itself has to be able to come back, and there are two
separate ways it must:

**Through JSON**, for undo and for the recorded history in
`gitea-draw-history.js` -- which stores what a command *serializes to*. This is
`AbstractComponent.registerComponent(kind, deserialize)`, and it must happen
before any such component is constructed: `AbstractComponent`'s constructor
throws for an unregistered kind. That is why both entry points into this file
call the same idempotent `defineComponent`.

**Through SVG**, because that is what lives in the markdown, and every reopen is
a round trip. On the way out the `<g>` carries a `data-gitea-draw-fill`
attribute holding everything that is not in the path; on the way back an
`SVGLoaderPlugin` (`EditorSettings.svg.loaderPlugins` -- note the nesting, it is
*not* a top-level setting) claims the `<g>` and rebuilds the component.

Claiming it matters for more than convenience. `SVGLoader.visit` stops
descending into a node a plugin returned `true` for, so the `<defs>` inside never
reaches the loader as an unknown object and the `<path>`'s `url(#…)` fill is
never handed to `Color4.fromString`. Without the plugin -- i.e. **if
`gitea-draw-fill.js` is not installed** -- js-draw logs "Unknown fill color",
gives the path a transparent fill, and the fill is silently lost on the next
save. There is no way to make that degrade gracefully from inside the SVG, which
is why the README says the four files travel together.

**The gradient's `id` is a hash of the fill itself**, not a counter and not the
component's id. Neither of those survives a reload, so opening a drawing and
saving it unchanged would rewrite every id and put a diff in the markdown for no
reason. Two fills that hash the same are the same fill, so sharing one gradient
definition is right rather than merely harmless.

## 6. Smaller decisions worth not re-deciding

**A `BaseTool` starts enabled.** `addPrimaryTool` sees that and turns the pen
off, so a board would open with the fill tool selected and drawing apparently
broken. The tool is disabled before it joins the group. This is a one-line fix
for a bug that looks like "the pen stopped working".

**The selection menu's colour control needs three methods.** js-draw applies it
to every selected component that answers to `isRestylableComponent` and
*silently skips the rest* -- the input stays enabled either way, so a fill
without `getStyle`/`updateStyle`/`forceStyle` leaves a control that shows
transparent black (`Color4.average([])`) and does nothing when set. That is a
worse state than a missing feature, and it is invisible from this file's own
code, which is why it is written down here.

The colour reported and accepted there carries the opacity in its **alpha**, the
way a translucent stroke's does -- and the same way the fill tool's own dropdown
does, so the two controls mean the same thing by a colour. See §6 for why that is
the only control either of them has.

**A fill goes underneath everything**, via the `initialZIndex` argument to
`AbstractComponent`'s constructor rather than a second command. Translucent paint
laid over a line washes it out, and paint is translucent by default. Passing the
z-index at construction keeps the whole thing one `addComponent` command, which
is one undo step and one recorded entry.

**Click, not drag.** A drag with this tool selected is how someone scrolls the
board; filling wherever their finger came to rest would be a surprise. The
threshold is in screen pixels so it does not change with the zoom.

**The reason a click filled nothing goes on the canvas**, not into
`window.alert`, following the same rule as the board's other questions.

**The colour picker's alpha is the opacity, and there is no slider beside it.**
js-draw configures Coloris with `format: 'hex'` and no `alpha: false`, so the
picker has always drawn an alpha slider under the hue one; a separate opacity
slider would have been a second control for the same number, and the two would
eventually disagree. `makeColorInput` hands back a `Color4` whose `.a` is that
slider, and `Color4.fromHex` reads the eight-digit form, so nothing had to be
worked around to use it.

The cost, which is worth knowing before someone "fixes" it: the six preset
swatches are `Color4.red.toHexString()` and friends -- fully opaque -- and the
pipette reads a pixel off the composited canvas, which sits on an opaque
background. So both set the alpha to 1: `#1e6bb880` becomes `#ff0000` on a
swatch click. That is the bargain every drawing program makes once colour and
opacity are one control, and it reads as "I picked *that* colour" rather than as
something going wrong. Second-guessing it -- keeping the old alpha whenever an
incoming colour happens to be opaque -- would make 100% unreachable from a
swatch and is not worth the magic.

## 7. What this does not do

* **It does not track what it filled.** Move the box and the fill stays where it
  was; the fill is a shape, not a relationship. Same limitation, same reason, as
  the UML arrows.
* **It does not re-flow when the boundary changes.** Redrawing a line means
  deleting the fill and clicking again.
* **The eraser deletes a fill whole** rather than splitting it. `withRegionErased`
  is optional and is not implemented; implementing it would mean re-tracing the
  outline against the erased region.
* **A gap narrower than the raster resolution leaks.** The raster is taken at the
  zoom the board is at, so zooming in before filling is the workaround, and it is
  the same workaround every paint program has.

## 8. After a js-draw upgrade

Re-check, in order of how quietly each would break:

1. `SVGRenderer.drawWithSVGParent` still creates its `<g>` **with no transform**
   (`transformFrom(Mat33.identity, parent, true)`). If it ever starts setting
   one, every saved fill doubles its transform. Nothing else notices.
2. `CanvasRenderer.drawWithRawRenderingContext` still applies
   `getCanvasToScreenTransform()` before the callback.
3. `EditorSettings.svg.loaderPlugins` still exists and `SVGLoader.visit` still
   skips the children of a claimed node. If not, fills are lost on reopen --
   again silently, because the picture looks right until it is saved.
4. `EditorImage.getAllComponents()` still leaves background components out. If
   not, every fill fails with "nothing closes that point in", because the page
   is one wall.
5. `AbstractComponent`'s constructor still takes `initialZIndex`, and
   `registerComponent`'s callback still receives the parsed `data` object.
6. `ToolController.addPrimaryTool` still disables the previously enabled tool in
   the group.
7. `isRestylableComponent` still looks for `getStyle`/`updateStyle`/`forceStyle`
   plus the `isRestylableComponent` flag, and `createRestyleComponentCommand` is
   still exported. If not, recolouring a fill from the selection menu goes back
   to doing nothing.

`test/suites/fill.mjs` covers all six from the outside: it fills, saves, reopens
and compares the SVG. A js-draw upgrade that breaks any of them fails it.
