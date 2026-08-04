# Fitting a freehand stroke to an elbow or a curve

Research note. Nothing here is implemented -- this is what was measured before
deciding whether to, and what the numbers say about how it would have to work.

The question: a user drags a rough L across the board and wants a clean
right-angled connector, or drags a rough arc and wants a smooth curve. Which
algorithms turn a point stream into either, and how well do they behave?

Everything below was measured against **js-draw 1.33.0**, the version
`install.sh` pins. See [uml-arrows.md](uml-arrows.md) for how a custom pen is
built and what constrains its output.

## 1. Where it would plug in, and the constraint that comes with it

js-draw drives a `ComponentBuilder` from **one pointer-down..up gesture**:
`Pen.onPointerUp` calls `finalizeStroke()` and then `postGestureCleanup()` sets
`this.builder = null`. A builder cannot span two gestures, so a click-per-vertex
tool is not reachable through `additionalPenTypes` -- that would be a custom
`BaseTool`, which is a different piece of work.

What *is* reachable is the optional hook on the builder interface:

```ts
autocorrectShape?: () => Promise<AbstractComponent | null>;
```

js-draw calls it when the pen goes stationary mid-stroke, and this is exactly
the "tidy up what I just drew" moment. It is not a new mechanism: js-draw's own
shape pens use it through `makeShapeFitAutocorrect`, which fits a **line or a
rectangle** and nothing else (`components/builders/autocorrect/makeShapeFitAutocorrect.mjs`
builds only `makeLineTemplate` and `makeRectangleTemplate`, and only for strokes
whose bounding box exceeds 32 units). Everything in this note would be a richer
template set behind the same hook.

Two inputs are available and both matter below: `StrokeDataPoint` carries `pos`,
`width` and **`time`**, so pen speed is measurable, not just geometry.

Whatever comes out still has to obey the constraint in
[uml-arrows.md §1](uml-arrows.md): one component, one style, one `<path>`.

## 2. The algorithm families

Fitting splits cleanly into two stages, and most of the literature is about the
first.

### Stage 1 -- where are the corners?

* **Ramer-Douglas-Peucker.** Recursively keep the point furthest from the
  chord until everything is within ε. O(n log n) typical, O(n²) worst. It has
  no notion of a corner at all; it keeps whatever the chord cannot represent.
* **Curvature over a window.** Accumulate the turning angle between the
  directions entering and leaving a point, across a window of ±W points, and
  take local maxima above a threshold. O(n).
* **ShortStraw** (Wolin, Eoff & Hammond, 2008). Resample to an even spacing,
  then measure the "straw" -- the chord across a 2W window. A corner pinches
  the window, so a corner is a local minimum of the straw, thresholded against
  the median. O(n). Its own paper scopes it to *polylines*.
* **IStraw** (Xiong & LaViola, 2009) extends ShortStraw to strokes containing
  curves and arcs, which is the case ShortStraw is known to fail.
* **Speed** (Sezgin, Stahovich & Davis, 2001). The hand slows at a corner, so
  speed minima are corner candidates. The paper's point is that speed is a
  *second, independent* source to be combined with curvature -- not that it
  works alone.
* **Dynamic-programming segmentation.** Treat it as a shortest path over
  candidate pieces, each scored by fit error plus a per-piece penalty, so the
  number of pieces falls out of the cost model rather than a threshold. Handles
  mixed segment/arc output. O(n²) candidate pieces; the most principled and the
  most expensive.

### Stage 2 -- turn the vertices into the intended shape

* **Orthogonalisation.** Snap each segment to horizontal or vertical. Snapping
  segments independently disconnects the chain, so the directions are decided
  first and the vertices then rebuilt from those decisions -- a vertex between a
  horizontal and a vertical run takes x from one neighbour and y from the other.
  Then collapse the short stair-steps snapping leaves behind.
* **Schneider**, "An Algorithm for Automatically Fitting Digitized Curves",
  Graphics Gems (1990). Chord-length parameterise, least-squares fit one cubic
  Bézier, improve the parameterisation with Newton-Raphson, and split at the
  worst point if that is still not close enough. This is what Inkscape's pencil
  and `paper.js`'s `simplify()` use, and there are JS ports (`fit-curve` on npm).
  js-draw already does something adjacent in `StrokeSmoother`, but incrementally
  and with *quadratic* Béziers.

## 3. What was measured

A prototype implements RDP, curvature, ShortStraw, speed-only, orthogonalisation
and Schneider, and runs them over synthesised strokes: a path walked at a speed
that dips near corners (the effect the speed detector exists to exploit),
gaussian jitter, and corners rounded off with a 14-unit radius because nobody
draws a sharp one. Deterministic PRNG, so rows compare.

**Synthetic input is a model of hand drawing, not hand drawing.** The rankings
below are trustworthy; the absolute thresholds would need re-tuning against
captured strokes.

### 3.1 Corner detection

Interior corners found against the truth, tolerance 30 units, jitter σ = 1.4:

| shape | RDP ε=4 | RDP ε=10 | ShortStraw | curvature | speed only |
|---|---|---|---|---|---|
| L (1 bend) | 4 | **1** | 3 | **1** | **1** |
| Z (2 bends) | 12 | **2** | 4 | **2** | 3 |
| U (2 bends) | 13 | **2** | 4 | **2** | 3 |
| straight (0) | **0** | **0** | 3 | **0** | 2 |
| stair (4 bends) | 15 | **4** | 7 | **4** | 5 |
| semicircle (0) | 12 | -- | 7 | **0** | -- |

* **Curvature wins outright**: exact on every shape, including zero on a
  straight line and zero on a semicircle.
* **RDP is exact at ε=10 and useless at ε=4.** ε is in canvas units, so it is
  scale-dependent -- the same gesture drawn zoomed out would need a different
  one. It is also a *vertex* finder, not a corner finder: on a semicircle it
  returns 12 vertices, all correct and none of them corners.
* **ShortStraw over-reports everywhere**, including 3 corners on a straight
  line and 7 on a semicircle. Its median-based threshold always finds minima,
  even when there is nothing to find. This is the documented weakness IStraw
  exists to fix, reproduced.
* **Speed alone over-reports by about one** and locates corners worse
  (16-23 units of error against curvature's 5-8). Useful as a second opinion,
  not as the detector.

### 3.2 Nothing is stable across redraws

The same shape drawn 20 times, with different noise each time:

| shape | curvature | ShortStraw | RDP ε=10 |
|---|---|---|---|
| L (want 1) | 1×19, 2×1 | 1×1, 2×12, 3×7 | 1×18, 2×2 |
| Z (want 2) | 2×18, 3×1, 4×1 | 2×2, 3×15, 4×3 | 2×18, 3×2 |
| stair (want 4) | 4×17, 5×3 | 4×8, 5×3, 6×4, 7×4, 8×1 | 4×17, 5×2, 6×1 |

**Not one detector is stable.** The best of them is wrong about one redraw in
ten. This is the finding that should drive the design, not the accuracy table:
a user who draws the same elbow twice will sometimes get a different answer, and
no amount of threshold tuning removes that -- it is noise in the input.

### 3.3 Schneider needs a tolerance above the noise

Cubic segments produced for a semicircle, which wants 2-4:

| jitter σ | tol 1 | tol 2 | tol 3 | tol 5 | tol 8 |
|---|---|---|---|---|---|
| 0 | 3 | 1 | 1 | 1 | 1 |
| 0.5 | 31 | 3 | 2 | 1 | 1 |
| 1.4 | 74 | 36 | 17 | **3** | 2 |
| 3 | 94 | 66 | 48 | 27 | 16 |

With the jitter removed the algorithm is exact at every tolerance, so the
explosion is not a defect -- it is Schneider faithfully reproducing the tremor
it was asked to reproduce. **The tolerance has to sit above roughly 3σ of the
input noise**, or the stroke must be smoothed first.

### 3.4 Splitting at corners is about keeping the corner, not saving segments

Segment counts, blind fit versus splitting at detected corners first:

| shape | tol | blind | split |
|---|---|---|---|
| L | 6 | 3 | 4 |
| Z | 6 | 6 | 3 |
| stair | 6 | 6 | 5 |

The saving is real for multi-bend strokes and absent for a single L. The
sharpness of the fitted corner is the honest reason to split:

| tol | blind, sharpest join | split, sharpest join |
|---|---|---|
| 3 | 18.5° | 45.3° |
| 6 | 53.1° | 59.5° |
| 10 | 47.4° | 71.9° |

Schneider produces a tangent-continuous chain, so on its own it can only round
a corner off; it spends segments approximating the turn. Neither column reaches
90° because the synthetic input's corner is rounded with a 14-unit radius --
that ceiling is the input, not the algorithm.

*(An earlier run of this comparison used tolerance 3 against σ = 1.4 -- right at
the noise floor -- and the segment counts it produced were measuring tremor, not
corners. The table above is above the floor.)*

### 3.5 Ask the stroke whether it wants right angles

Orthogonalising a stroke that is not an elbow is a disaster: a diagonal line has
no right-angled form except a detour. Measuring the cost as *maximum deviation
divided by the stroke's own bounding box* separates the two families cleanly and
without a unit:

| stroke | vertices | max deviation | cost |
|---|---|---|---|
| L | 4 | 13.6 | **0.045** |
| Z | 5 | 8.4 | **0.025** |
| U | 5 | 5.0 | **0.020** |
| stair | 7 | 7.9 | **0.022** |
| shallow diagonal | 3 | 35.9 | 0.109 |
| diagonal line | 3 | 102.6 | 0.310 |

A threshold around 0.06 has a factor of two of headroom on both sides. The
elbows' residual deviation is essentially the input's 14-unit corner radius: a
sharp corner cannot pass through a rounded one.

## 4. What this suggests

A pipeline, in the order the measurements support:

1. **Resample** to an even spacing -- every detector but RDP assumes it.
2. **Curvature corner detection** (window ±4 points, ~40° threshold). It was
   exact on every shape tried; ShortStraw was not, and RDP's ε does not survive
   a zoom change.
3. **Score orthogonalisation** by deviation over bounding box. Above ~0.06,
   this stroke is not an elbow -- do not straighten it.
4. Then either **orthogonalise and collapse** the short steps, or **split at
   the corners and fit each run with Schneider** at a tolerance above the input
   noise.

Speed is worth keeping as a tie-breaker rather than a detector: it is
independent of the geometry, the timestamps are already in `StrokeDataPoint`,
and Sezgin's result is that combining the two sources beats either.

The thing to design around is §3.2, not §3.1. Since the same gesture will
occasionally fit differently, the feature has to make that cheap:
`autocorrectShape` already replaces one component with another as a single
undoable step, so a wrong guess costs one Ctrl+Z. **A fit that cannot be
rejected in one keystroke should not ship.**

## 5. The cheaper alternative worth weighing first

All of the above generalises to "beautify any stroke". A UML connector does not
need that. It has **two endpoints and a bend count of one or two**, and the
useful information is where the pen started and stopped, not where it wandered.
A builder that emits an elbow from the start and end points -- picking
horizontal-first or vertical-first from the drag's dominant axis -- needs no
corner detection, no resampling, no thresholds, is exactly stable across
redraws, and fits the existing UML pens without a new concept.

It cannot express a three-bend route, and the user cannot say where the bend
goes. If that turns out to matter, this note is the map for the general version;
if it does not, the general version is a great deal of machinery for a shape
with two degrees of freedom.

## Sources

* [A ShortStraw-based algorithm for corner finding in sketch-based interfaces](https://www.sciencedirect.com/science/article/abs/pii/S0097849310001044) -- Xiong & LaViola (IStraw)
* [Revisiting ShortStraw: Improving Corner Finding in Sketch-Based Interfaces](https://www.researchgate.net/publication/220772408_Revisiting_ShortStraw_Improving_Corner_Finding_in_Sketch-Based_Interfaces)
* [Sketch based interfaces: early processing for sketch understanding](https://www.semanticscholar.org/paper/Sketch-based-interfaces:-early-processing-for-Sezgin-Stahovich/0afd88db86946b4b13304c14375ec0c48e262c03) -- Sezgin, Stahovich & Davis
* [FitCurves.c](https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c) -- Schneider's original, in Graphics Gems
* [fit-curve](https://github.com/soswow/fit-curve) -- a JavaScript port of it
* [An Efficient Combinatorial Algorithm for Optimal Compression of a Polyline with Segments and Arcs](https://arxiv.org/pdf/1811.05659) -- Gribov, on the dynamic-programming formulation
* [A new algorithm for fitting a rectilinear x-monotone curve to a set of points in the plane](https://www.sciencedirect.com/science/article/abs/pii/S0167865501001301)
