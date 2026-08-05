# How "Fit…" came out this way

Notes for whoever maintains this next.
[README.md](../README.md#fitting-a-path-to-its-bounding-box) says what the three
fits do; this says **why the feature is shaped like this**, and in particular why
it is a button rather than something that fires by itself.

[stroke-fitting.md](stroke-fitting.md) is the measurement this is built on. It
is worth reading first: it is the reason this feature exists in the form it does
rather than the form it was originally imagined in.

Line references are to **js-draw 1.33.0**, `dist/mjs/…`, which is what
`install.sh` pins.

## 1. The finding that chose the design

The original idea was autocorrect: draw a rough L, hold the pen still, get a
clean right-angled connector. js-draw has the hook for exactly that --
`ComponentBuilder.autocorrectShape()`, which its own shape pens use.

[stroke-fitting.md §3.2](stroke-fitting.md#32-nothing-is-stable-across-redraws)
killed it. Every corner detector measured -- curvature over a window,
ShortStraw, RDP, pen speed -- gives a **different answer on about one redraw in
ten** of the same shape. That is noise in the input, not a threshold anyone can
tune out. An autocorrect that fires on its own and is wrong one time in ten is a
feature that makes the board feel broken.

So: **do not detect corners at all.**

A bounding box has four corners whether the hand shook or not. Reading the fit
off the box instead of off the stroke makes it exactly reproducible -- the same
stroke fits the same way every time, and a fitted stroke fits to itself. And
making it a menu entry rather than a gesture means a fit that is not wanted is a
button that was not pressed, rather than something to notice and undo.

The whole of that note's algorithm inventory -- RDP, ShortStraw, IStraw,
Schneider, dynamic programming -- is unused here. It stays on file for whoever
wants the general version; this is the version whose failure mode is "the
result was not what I meant", not "the board changed my drawing".

## 2. What the fit actually reads from the stroke

Three things, and nothing else:

* where the stroke **starts**,
* where it **ends**,
* which way round the box it **went**.

**The first two are kept, not consulted.** They are the first and last points
of the fitted path, unmoved. An earlier version snapped them to the nearest
corner of the box, and that was wrong in a way worth recording: it threw away
the only part of the stroke that says *which* stroke it was. A G, a C and a
rectangle drawn in one loop all have the same bounding box, and corner-snapped
they all fit to the same drawing. Kept, a G stays a G.

Each end is joined to the box by one straight hop out to the **nearest** edge,
so the joint is a right angle and a square fit stays square. Nearest, rather
than whichever edge fits best: see §3.

The third thing picks the walk between those two joins. There are two ways
round the perimeter; the stroke is resampled to 64 evenly spaced points, both
routes are scored against it, and the closer one wins.

Resampling matters. A hand slows at a corner, so raw points bunch up there --
which is [the effect the speed detector in stroke-fitting.md §3.1 exists to
exploit](stroke-fitting.md#31-corner-detection), and here it would be a bias:
the corner is exactly where the two candidate routes differ most, so counting
its points twice would weight the score by how slowly the corner was drawn.

The score is symmetric -- how far the stroke sits from the route **plus** how
far the route sits from the stroke. The second half is not decoration. Charging
only the first would make the longer way round win every time: another side of
the box can only bring the route nearer to the stroke, never further. The second
half charges for route that goes where the stroke did not, which is what turns
"which way did it go" into a question with an answer.

The perimeter is handled as a loop of one number -- distance clockwise from the
top left corner -- so the walk between two points on the box is arithmetic
rather than case analysis over which edges each of them landed on.

Everything between the ends is used only for that score. A Z, an S, a stroke
that crosses its own box -- all of them fit to whatever the perimeter offers
between their ends. That is a real limitation and it is not a bug: a route that
follows the edges of a box cannot express a shape that goes through the middle
of it.

### Worked example: a G

Drawn from about two o'clock, anticlockwise over the top, down the left, along
the bottom and up the right, then in along the crossbar. Neither end is at a
corner and the second is deep inside the box. The fit is

    start -> up to the top edge -> along it to the top left corner
          -> down to the bottom left corner -> along the bottom to the bottom
          right -> up the right edge -> in along the crossbar to the end

which is a rectilinear G: a box open where the pen started, with a bar coming in
at the height the pen stopped. `test/suites/path-fit.mjs` draws exactly this and
checks that both ends survive it, that the route rounds the three corners the
arc encloses and not the fourth, and that nothing but the two hops leaves an
edge.

## 3. The three fits are one route drawn three ways

The route is the two kept ends with the box corners between them. What varies is
only how the turns are drawn.

* **Square** -- `LineTo` per point. Every point of the result lies on an edge of
  the box, bar the two hops out to the ends.
* **Rounded** -- each corner is cut back along both of its edges by `r`, and the
  cut ends joined by a quadratic whose control point is the corner. That is not
  an approximation of a rounded corner; it *is* the construction, and it costs
  one path command. `r` is `fitCornerRadius` (0.25 by default) of the shorter
  side of the box, and is further clamped to half of either edge it touches, or
  two corners sharing a short edge would round through each other and the line
  would visibly double back.
* **Curve** -- the route's kept ends become the curve's ends and every corner
  between them becomes a control point. One corner is a quadratic and two are a
  cubic; past that -- and a G turns four times -- they become a chain of
  quadratics handed off at the midpoints between consecutive corners, the join
  that leaves the tangent continuous. This is the fit that does *not* keep the
  path near the box: a Bézier leans into a control point without reaching it, so
  the curve passes a good fraction of the box away from each corner it turns at.

**A closed stroke has no free ends** -- and nothing to keep, since its two ends
are the same point. Its route is the whole perimeter, from the corner it started
nearest, which is the one case where the ends do move. Starting at a corner
rather than at the projection of the start point keeps the turn count down to
the four the box has.

That changes both of the curved fits. Rounded has a fourth turn to make, at the
corner the path both leaves from and arrives at, so it starts part way along the
first edge instead. Curve has no ends to anchor to at all, so every corner is a
control point and the curve runs midpoint-to-midpoint of the edges -- the
standard closed quadratic spline, which around a rectangle draws the loop
inscribed in it. A freehand circle comes back as an ellipse-like ring, which is
the useful answer.

A stroke counts as closed when its ends come within a tenth of the box's
perimeter of each other. For a hand-drawn circle that gap is a few units against
a threshold of dozens; for anything with real ends it is a good part of a
circuit. Same headroom, and the same kind of measurement, as
[stroke-fitting.md §3.5](stroke-fitting.md#35-ask-the-stroke-whether-it-wants-right-angles).

### The hop goes to the nearest edge, not the best-fitting one

Since the walk direction is chosen by scoring, the obvious next step is to score
which edge each end hops out to as well -- four choices each way, thirty-two
candidates, let the measurement decide. It was built that way and it is a trap.

A hop long enough to cross the box can lie along the stroke **better than the
edge it is standing in for does**. A rough L wobbles a couple of units inside
its own box; the edge is by definition at the extreme, so it sits those couple
of units off the ink, while a hop drawn straight down the middle of the wobble
sits on it. Given the choice, the score picked a route whose "hop" ran the whole
length of the shape and whose stay on the box was a two-unit jog near a corner:

    M338,240 l287,0 l0,-2 l-3,0 l0,171     <- scored best, hugs the ink
    M338,240 l0,-2 l287,0 l0,171 l-3,0     <- nearest edge, hugs the box

Both are the same L to look at. Only the second is the feature. Hugging the box
is the promise; the hop is the exception to it, so it is kept as small as it can
be and not left to a score that is measuring something else.

## 4. Why only stroked paths

`fittablePart()` refuses anything whose single part has no `stroke` in its
style. That rules out more than it sounds like: js-draw's freehand pen ("Round")
draws `{fill: transparent, stroke: {color, width}}`, but its **pressure-
sensitive pen, all four of its shape pens, and the six UML pens** draw a *filled
outline* instead -- the visible line is the gap between two sides of one closed
loop.

Running that loop around the box would not fit the shape; it would replace it
with a hairline. Worse, for a UML arrow it would silently delete the head, since
the head is part of the same filled path (see
[uml-arrows.md §1](uml-arrows.md#1-the-decision-everything-else-follows-from)).

Two ways out were considered and not taken:

* **Emit a filled band instead of a stroked path.** The helpers for it already
  exist -- `umlSegment`, `umlBand`. It works for the square fit and gets hard for
  the other two, and it still loses the arrowhead.
* **Estimate a stroke width from the filled shape** (`w ≈ 2·area / perimeter`
  for a band, both of which are cheap off the polyline) and emit a stroked path
  in the fill colour. This is a couple of lines and gives a plausible answer for
  a line-like shape -- but for a UML arrow it converts a filled arrow into a
  plain stroked elbow, losing the notation without saying so.

Both trade a refusal for a surprise. The refusal says why, in the entry's
tooltip, so it is at least a dead end with a sign on it.

## 5. Where the entry sits

**Beside "Align…" in the selection menu, not inside its panel.** It was built
the other way first, as a row at the bottom of the align panel, on the reasoning
that both are ways of tidying a selection up.

That reasoning does not survive contact with the menu. Align and Fit ask
different questions -- *where does this sit against everything else* against
*what shape should this one path be* -- and neither is a step on the way to the
other, so nesting one in the other costs a click and an extra Back for no
grouping anyone would look for. It also made the panel stack two deep, which the
align panel's own base-object state has to survive being hidden and restored
through.

The cost of the flat arrangement is that the entry is greyed out most of the
time, since most selections are not a single path. Leaving it out instead was
the alternative, and it is worse: an entry that comes and goes as the selection
changes reads as a bug, and there is nowhere left to say *why* it does not
apply. Greyed out with the reason as its tooltip says it in the one place a user
will look.

js-draw's menu options have no disabled state of their own -- every entry it
puts there is always available -- so `.markup-draw-fit-entry:disabled` supplies
one, including cancelling the `:hover` highlight the option would otherwise
still light up with.

## 6. How the replacement is dispatched

A fit is not a transform -- the geometry changes, not just its placement -- so
unlike every action in the align panel beside it, it cannot be a
`transformBy`. It is:

```js
uniteCommands([new Erase([component]), editor.image.addComponent(stroke)])
```

United, so one Ctrl+Z takes it back, which
[stroke-fitting.md §4](stroke-fitting.md#4-what-this-suggests) sets as the bar
any fit has to clear ("a fit that cannot be rejected in one keystroke should not
ship"). The new `Stroke` is constructed with the old one's `getZIndex()`, or an
erase-and-add would quietly bring the path to the front of the drawing.

Both halves are `SerializableCommand`s and both are already understood by the
edit-history recorder -- `commandRefs()` reads `union`, `erase` and
`add-element`, so a fit records, replays and reports its dependencies with no
change to that machinery. The only thing added there is a label:
`describeCommand()` calls an erase and an add together "a reshaped element",
because "a group of 2 changes" hides the one thing about the step worth reading.

The selection has to be moved onto the new component by hand
(`tool.setSelection([stroke])`): the panel stays open after a fit so that one
shape can be tried three ways, and without that it would be pointing at what was
just erased.

## 7. Where the numbers came from

| constant | value | why |
|---|---|---|
| `FIT_SAMPLES` | 64 | enough that a corner cannot fall between two samples on any box big enough to see; the score is a mean, so more only costs time |
| `FIT_CURVE_STEPS` | 8 | per curve command when flattening a path to a polyline. Only matters when re-fitting a path a previous fit already curved -- without it the score would compare the routes against a straight line between the curve's ends |
| `cfg.fitCornerRadius` | 0.25 | of the shorter side. Large enough to read as deliberate at the sizes a drawing board is used at, small enough to leave straight run on both edges |
| `FIT_CLOSED` | 0.1 | of the perimeter, under which the stroke's two ends count as the same point. See §3 |

## 8. If js-draw is upgraded

The geometry uses only public API, so it is much less exposed than the menu it
is reached from: `injectMenuEntries` appends to js-draw's popup-menu markup, and
that is the fragile half -- but it is the same half the align entry already
depends on, and it fails the same way, by the entry silently not appearing.
Worth re-checking anyway:

* `Stroke.getParts()` returning `RenderablePathSpecWithPath` -- the fit reads
  `.path` and `.style` off it.
* `PathCommandType` still having `LineTo`, `QuadraticBezierTo`,
  `CubicBezierTo`, and the command objects still keying their points as
  `point` / `controlPoint` / `controlPoint1` / `controlPoint2` / `endPoint`.
* `EditorImage.addComponent` returning a command rather than applying directly.
* Whether any pen listed in §4 has changed which of fill and stroke it uses --
  a pen that switched from filled to stroked would silently become fittable,
  which is fine, and one that went the other way would silently stop being,
  which the tooltip would at least explain.

`test/suites/path-fit.mjs` covers all of this through the saved SVG.
