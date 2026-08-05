// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Filling an area that other elements have closed off.  Part of
// contrib/markdown-draw, see contrib/markdown-draw/README.md; gitea-draw.js
// loads first and this file hangs itself off the namespace that one publishes.
//
// js-draw has no fill of any kind.  Its pens can draw a *filled shape* -- a
// rectangle, an ellipse, a freehand blob -- but only as one stroke's own
// geometry: there is nothing that looks at what is already on the canvas and
// paints the space between it.  Drawing a box out of four separate lines and
// then wanting the inside coloured is not something the editor can do, and that
// is the gap this file closes.
//
// The button is a tool of its own, beside the pens.  One click on the canvas:
//
//   1. everything already drawn is rendered, on its own, into an offscreen
//      canvas -- ink against transparency, no background;
//   2. a flood fill spreads from the clicked pixel through the transparent
//      pixels.  Reaching the edge of that raster means the paint ran off the
//      page and there was no closed shape to fill, which is reported and
//      nothing is added;
//   3. the pixels it did reach are traced back into an outline, simplified,
//      and turned into a single filled element that goes *under* everything
//      else, so the lines that closed the shape stay as crisp as they were.
//
// A raster is used rather than the geometry because the geometry cannot answer
// the question.  "Closed" here means closed *as drawn*: four separate strokes
// whose ends merely overlap enclose an area to the eye and to a flood fill,
// while as four open paths they intersect in no way that a point-in-polygon
// test could use.  Working from the pixels also means the fill lands exactly
// where the user sees a boundary, thickness and all.
//
// ---------------------------------------------------------------- the element
//
// A fill is one component with three appearances -- even, fading along a line,
// fading out from a point -- and the last two are gradients, which js-draw's
// rendering style cannot express: a style is {fill, stroke} with a flat colour
// in each.  So the fill is a component of our own rather than a `Stroke`, and
// it draws itself through the two escape hatches js-draw provides for exactly
// this:
//
//   * `CanvasRenderer.drawWithRawRenderingContext` -- the 2D context, already
//     transformed into canvas coordinates, for what the editor shows;
//   * `SVGRenderer.drawWithSVGParent` -- a <g> to fill in, for what is saved.
//
// A component that draws itself has to be able to come back, and it makes two
// round trips, not one:
//
//   * through JSON, for undo and for the recorded history in
//     gitea-draw-history.js.  `AbstractComponent.registerComponent` covers it.
//   * through SVG, because that is what lives in the markdown.  On the way out
//     the <g> carries a `data-gitea-draw-fill` attribute holding everything
//     that is not in the path; on the way back an `SVGLoaderPlugin` claims the
//     <g> and rebuilds the component from it.  Without that plugin -- i.e. if
//     this file is not installed -- js-draw sees a path whose fill is a
//     `url(#…)` it cannot parse and drops it, so a drawing containing a fill
//     should not be edited on an installation missing this file.

(() => {
  'use strict';

  // bump when changing this file; the files are cached separately, so
  // giteaDrawDebug() reports one revision per file
  const REVISION = '4';

  const draw = window.giteaDraw;
  if (!draw) {
    // eslint-disable-next-line no-console
    console.error('markdown-draw: gitea-draw-fill.js loaded without gitea-draw.js, check header.tmpl');
    return;
  }
  draw.scripts.push({name: 'gitea-draw-fill.js', revision: REVISION, url: document.currentScript?.src ?? '(unknown)'});

  const {cfg, i18n, SVG_NS} = draw;

  // Defaults for what this file does.  Applied here rather than in gitea-draw.js
  // so that an option sits next to the code it drives; the admin's own
  // giteaDrawConfig is re-applied on top so it still wins.
  Object.assign(cfg, {
    // offer the fill tool in the toolbar
    fill: true,
    // what a fresh board starts with, until the toolbar state is restored
    fillColour: '#1e6bb8',
    // the alpha the colour picker opens on; there is no separate control for it
    fillOpacity: 0.5,
    fillPattern: 'even', // 'even' | 'linear' | 'radial'
    fillFadeTowards: 'bottom', // 'bottom' | 'top' | 'right' | 'left'
    // longest side of the offscreen raster, in pixels.  The raster is taken at
    // the zoom the board is at, so this only bites on a drawing much larger
    // than the window; a coarser raster rounds the outline more, it does not
    // change what counts as closed.
    fillMaxRaster: 1600,
    // how opaque a pixel has to be to count as a wall the paint cannot cross.
    // Low, so that the soft edge of an antialiased line still stops it.
    fillInkAlpha: 0.25,
    // how far the filled area creeps in under the ink that bounds it, in raster
    // pixels.  Without it every fill is outlined by a hairline of background
    // showing through between the paint and the line.
    fillUnderlap: 2,
    // how far, in raster pixels, the traced outline may be moved to use fewer
    // points.  A flood fill traces one point per pixel step; at 0 a fill of a
    // sheet-sized area is tens of thousands of coordinates in the markdown.
    fillSimplify: 0.8,
    // smallest area worth filling, in raster pixels
    fillMinArea: 12,
  }, window.giteaDrawConfig ?? {});

  Object.assign(i18n, {
    fillTitle: 'Fill',
    // the tool's own name, as a screen reader reads it out
    fillTool: 'Fill a closed area',
    fillHint: 'Click inside an area that what you have drawn closes off.',
    // the picker behind it sets the transparency too, through the colour's alpha
    fillColourLabel: 'Colour',
    fillPatternLabel: 'Fill',
    fillPatternEven: 'Evenly',
    fillPatternLinear: 'Fading across',
    fillPatternRadial: 'Fading out from where you click',
    fillTowardsLabel: 'Fades towards',
    fillTowardsBottom: 'The bottom',
    fillTowardsTop: 'The top',
    fillTowardsRight: 'The right',
    fillTowardsLeft: 'The left',
    // what a fill is, as the editor announces adding or erasing one
    fillDescription: 'a filled area',
    // why nothing was filled
    fillNothingDrawn: 'There is nothing drawn to close an area off yet.',
    fillNotClosed: 'Nothing closes that point in, so there is no area to fill.',
    fillOnInk: 'That point is on something already drawn, not in a space between.',
    fillTooSmall: 'That space is too small to fill.',
  });

  // ---------------------------------------------------------------- the raster
  //
  // Everything from here to "the outline" works on a plain binary raster and
  // knows nothing about js-draw: `ink` marks the pixels the paint cannot cross,
  // `area` the pixels it reached.  Both are Uint8Arrays of w*h, row-major.

  // Which pixels count as a wall.  Only the alpha channel is read, so the paint
  // is stopped by anything drawn whatever colour it is -- and by nothing else,
  // because the background is left out of the render.
  function inkMask(pixels, alpha) {
    const ink = new Uint8Array(pixels.length / 4);
    const threshold = Math.round(alpha * 255);
    for (let i = 0; i < ink.length; i++) {
      if (pixels[i * 4 + 3] >= threshold) ink[i] = 1;
    }
    return ink;
  }

  // The paint, spreading from one pixel.  4-connected: a one-pixel diagonal gap
  // in a line is a wall, which is what someone who drew a closed box would
  // expect of the corner where two strokes cross.
  //
  // `escaped` is the whole answer to "is this area closed": the raster is taken
  // a few pixels larger than everything drawn, so paint on its edge is paint
  // that got out.
  function floodFill(ink, w, h, startX, startY) {
    const area = new Uint8Array(w * h);
    const start = startY * w + startX;
    if (ink[start]) return {area, count: 0, escaped: false, onInk: true};

    // every pixel is marked as it is pushed, so it is pushed at most once and
    // the stack cannot outgrow the raster
    const stack = new Int32Array(w * h);
    let top = 0;
    stack[top++] = start;
    area[start] = 1;
    let count = 0;
    let escaped = false;

    while (top > 0) {
      const at = stack[--top];
      const x = at % w;
      const y = (at - x) / w;
      count++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) escaped = true;
      if (x > 0 && !area[at - 1] && !ink[at - 1]) { area[at - 1] = 1; stack[top++] = at - 1; }
      if (x < w - 1 && !area[at + 1] && !ink[at + 1]) { area[at + 1] = 1; stack[top++] = at + 1; }
      if (y > 0 && !area[at - w] && !ink[at - w]) { area[at - w] = 1; stack[top++] = at - w; }
      if (y < h - 1 && !area[at + w] && !ink[at + w]) { area[at + w] = 1; stack[top++] = at + w; }
    }
    return {area, count, escaped, onInk: false};
  }

  // Grow the filled area into the ink that bounds it, one ring per pass.
  //
  // Only into ink: the area is closed, so every pixel next to it is either ink
  // or already part of it, and growing into ink alone cannot leak into the
  // space on the far side of a line unless the line is thinner than the number
  // of passes.  That is also why this is two passes and not ten.
  function growUnderInk(area, ink, w, h, passes) {
    for (let pass = 0; pass < passes; pass++) {
      const added = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const at = y * w + x;
          if (area[at] || !ink[at]) continue;
          const touches =
            (x > 0 && area[at - 1]) || (x < w - 1 && area[at + 1]) ||
            (y > 0 && area[at - w]) || (y < h - 1 && area[at + w]);
          if (touches) added.push(at);
        }
      }
      if (!added.length) return;
      for (const at of added) area[at] = 1;
    }
  }

  // ---------------------------------------------------------------- the outline
  //
  // Turning the filled pixels back into loops of points.  Each boundary pixel
  // edge becomes one directed segment on the lattice between pixels, wound so
  // that the filled side is always on the same hand; chaining them end to end
  // gives the outer loop and, wound the other way round, a loop per hole.  The
  // nonzero fill rule then leaves the holes empty without anything else being
  // said about them, which is the same trick the UML pens in gitea-draw.js use
  // for a hollow arrowhead.

  const key = (x, y, w) => y * (w + 1) + x;

  function traceLoops(area, w, h) {
    const filled = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && area[y * w + x]) ? 1 : 0;

    // start point -> list of end points; a lattice point can begin two segments
    // where the area touches itself corner to corner
    const outgoing = new Map();
    const addEdge = (ax, ay, bx, by) => {
      const from = key(ax, ay, w);
      const to = key(bx, by, w);
      const list = outgoing.get(from);
      if (list) list.push(to); else outgoing.set(from, [to]);
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!filled(x, y)) continue;
        // wound so the filled pixel is always on the left of the direction of
        // travel (y grows downwards, so "left of +x" is -y)
        if (!filled(x, y - 1)) addEdge(x + 1, y, x, y);
        if (!filled(x - 1, y)) addEdge(x, y, x, y + 1);
        if (!filled(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1);
        if (!filled(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y);
      }
    }

    const loops = [];
    const pointOf = (k) => ({x: k % (w + 1), y: Math.floor(k / (w + 1))});

    while (outgoing.size) {
      const first = outgoing.keys().next().value;
      const loop = [];
      let at = first;
      let direction = null;
      while (true) {
        const list = outgoing.get(at);
        if (!list || !list.length) break;
        let index = 0;
        if (list.length > 1 && direction) {
          // Where the area pinches to a corner two loops meet at one point.
          // Turning as hard as possible keeps each loop hugging its own side
          // rather than crossing over into the other.
          const here = pointOf(at);
          let best = Infinity;
          list.forEach((candidate, i) => {
            const next = pointOf(candidate);
            const dx = next.x - here.x, dy = next.y - here.y;
            const cross = direction.dx * dy - direction.dy * dx;
            if (cross < best) { best = cross; index = i; }
          });
        }
        const next = list.splice(index, 1)[0];
        if (!list.length) outgoing.delete(at);
        const here = pointOf(at);
        loop.push(here);
        const there = pointOf(next);
        direction = {dx: there.x - here.x, dy: there.y - here.y};
        at = next;
        if (at === first) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  // A traced loop turns a corner at every pixel; collapsing the straight runs
  // first leaves the simplifier below far less to look at.
  function dropCollinear(points) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const previous = points[(i - 1 + points.length) % points.length];
      const here = points[i];
      const next = points[(i + 1) % points.length];
      const cross = (here.x - previous.x) * (next.y - here.y) -
        (here.y - previous.y) * (next.x - here.x);
      if (cross !== 0) out.push(here);
    }
    return out.length >= 3 ? out : points;
  }

  // Ramer-Douglas-Peucker, on an open run of points.
  function simplifyRun(points, tolerance) {
    if (points.length < 3) return points.slice();
    const first = points[0];
    const last = points[points.length - 1];
    const dx = last.x - first.x, dy = last.y - first.y;
    const length = Math.hypot(dx, dy);
    let worst = -1;
    let at = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const point = points[i];
      const distance = length < 1e-9
        ? Math.hypot(point.x - first.x, point.y - first.y)
        : Math.abs((point.x - first.x) * dy - (point.y - first.y) * dx) / length;
      if (distance > worst) { worst = distance; at = i; }
    }
    if (worst <= tolerance) return [first, last];
    const head = simplifyRun(points.slice(0, at + 1), tolerance);
    const tail = simplifyRun(points.slice(at), tolerance);
    return head.slice(0, -1).concat(tail);
  }

  // A closed loop has no ends to anchor the simplifier to, and anchoring it to
  // an arbitrary point leaves that point unsimplified.  Cutting the loop at its
  // two furthest-apart points and simplifying each half puts both anchors on
  // corners the outline needs anyway.
  function simplifyLoop(points, tolerance) {
    const loop = dropCollinear(points);
    if (loop.length < 4 || tolerance <= 0) return loop;
    let furthest = 0;
    let best = -1;
    for (let i = 1; i < loop.length; i++) {
      const distance = Math.hypot(loop[i].x - loop[0].x, loop[i].y - loop[0].y);
      if (distance > best) { best = distance; furthest = i; }
    }
    const head = simplifyRun(loop.slice(0, furthest + 1), tolerance);
    const tail = simplifyRun(loop.slice(furthest).concat([loop[0]]), tolerance);
    // both halves carry the points they were cut at; drop the repeats
    const out = head.slice(0, -1).concat(tail.slice(0, -1));
    return out.length >= 3 ? out : loop;
  }

  // ---------------------------------------------------------------- the element
  //
  // Built once, the first time js-draw is loaded: a component class has to be
  // registered before one can be constructed, and it needs js-draw's own Path,
  // Rect2 and Color4 to be there to close over.

  const COMPONENT_KIND = 'gitea-draw-fill-region';
  const FILL_CLASS = 'gitea-draw-fill';
  const FILL_ATTR = 'data-gitea-draw-fill';

  let FillRegion = null;

  const asPoint = (jsdraw, pair) => jsdraw.Vec2.of(pair[0], pair[1]);
  const asPair = (point) => [round(point.x), round(point.y)];
  // four decimals is well under a screen pixel at any zoom a drawing is read at,
  // and this is markdown someone has to be able to diff
  const round = (value) => Math.round(value * 1e4) / 1e4;

  // What is stored beside the outline, in both round trips.  The gradient is
  // kept as the points it runs between rather than as an angle and a radius, so
  // moving, rotating or resizing a fill is one transformation applied to
  // everything about it.
  function transformStyle(style, transform) {
    const moved = {...style};
    for (const name of ['from', 'to', 'centre', 'edge']) {
      if (style[name]) moved[name] = transform.transformVec2(style[name]);
    }
    return moved;
  }

  function styleToJSON(style) {
    const json = {colour: style.colour, opacity: round(style.opacity), pattern: style.pattern};
    if (style.pattern === 'linear') {
      json.from = asPair(style.from);
      json.to = asPair(style.to);
    } else if (style.pattern === 'radial') {
      json.centre = asPair(style.centre);
      json.edge = asPair(style.edge);
    }
    return json;
  }

  function styleFromJSON(jsdraw, json) {
    const style = {
      colour: typeof json?.colour === 'string' ? json.colour : '#000000',
      opacity: Number.isFinite(json?.opacity) ? json.opacity : 0.5,
      pattern: json?.pattern === 'linear' || json?.pattern === 'radial' ? json.pattern : 'even',
    };
    if (style.pattern === 'linear' && json.from && json.to) {
      style.from = asPoint(jsdraw, json.from);
      style.to = asPoint(jsdraw, json.to);
    } else if (style.pattern === 'radial' && json.centre && json.edge) {
      style.centre = asPoint(jsdraw, json.centre);
      style.edge = asPoint(jsdraw, json.edge);
    } else {
      // a gradient with no geometry cannot be drawn; an even fill of the same
      // colour is the closest thing to what was meant
      style.pattern = 'even';
    }
    return style;
  }

  // `#rrggbb` plus an opacity, as the `#rrggbbaa` the colour picker speaks.
  // Everything else here keeps the two apart, because the SVG does: a stop's
  // colour and its `stop-opacity` are separate attributes, and a gradient needs
  // the same colour at both ends with only the alpha differing.
  function withAlpha(colour, opacity) {
    const value = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
    return `${colour}${value.toString(16).padStart(2, '0')}`;
  }

  // FNV-1a, as an unsigned base-36 string.  Not a checksum of anything: it only
  // has to turn a fill into a short name that is the same every time.
  function hash(text) {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193);
    }
    return (value >>> 0).toString(36);
  }

  // `rgb(...)` rather than a hex string: a gradient needs the same colour at
  // both ends with only the alpha differing, and this keeps the two stops
  // obviously the same colour in the saved markdown.
  function rgbaString(jsdraw, colour, alpha) {
    let parsed;
    try {
      parsed = jsdraw.Color4.fromString(colour);
    } catch {
      parsed = jsdraw.Color4.black;
    }
    const channel = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
    return `rgba(${channel(parsed.r)}, ${channel(parsed.g)}, ${channel(parsed.b)}, ${round(alpha)})`;
  }

  function defineComponent(jsdraw) {
    if (FillRegion) return FillRegion;
    const {AbstractComponent, Path, Color4, pathToRenderable, createRestyleComponentCommand} = jsdraw;

    const parseColour = (text) => {
      try {
        return Color4.fromString(text);
      } catch {
        return Color4.black;
      }
    };

    class FillRegionComponent extends AbstractComponent {
      constructor(path, style, zIndex) {
        super(COMPONENT_KIND, zIndex);
        this.path = path;
        this.style = style;
        this.contentBBox = path.bbox;
        // what makes the selection menu's colour control act on this, see
        // getStyle below
        this.isRestylableComponent = true;
      }

      // --- what it looks like

      // The colour a renderer that can only manage one flat fill gets: the mean
      // of a gradient that runs to nothing is half of it.
      flatColour() {
        const parsed = parseColour(this.style.colour);
        const alpha = this.style.pattern === 'even' ? this.style.opacity : this.style.opacity / 2;
        return Color4.ofRGBA(parsed.r, parsed.g, parsed.b, alpha);
      }

      // --- restyling, from the "Select" tool's colour control
      //
      // js-draw's selection menu offers one colour input and applies it to every
      // selected component that answers to `isRestylableComponent`.  Without
      // these three methods a fill is skipped: the input stays enabled, shows
      // transparent black, and setting it does nothing at all -- which looks far
      // more like a bug than a missing feature.
      //
      // The colour carries the opacity in its alpha, the way a translucent
      // stroke's does, so the one input sets both.  That is also the only way to
      // reach the opacity from here: the slider that sets it lives in the fill
      // tool's own dropdown, which is about the *next* fill rather than about
      // whatever happens to be selected.  For a gradient this is the colour the
      // fade starts at; how far it fades is the pattern's business, not the
      // colour's, and is left alone.

      getStyle() {
        const parsed = parseColour(this.style.colour);
        return {color: Color4.ofRGBA(parsed.r, parsed.g, parsed.b, this.style.opacity)};
      }

      updateStyle(style) {
        return createRestyleComponentCommand(this.getStyle(), style, this);
      }

      forceStyle(style, editor) {
        if (!style.color) return;
        // replaced rather than mutated: a clone shares this object until one of
        // the two changes
        this.style = {
          ...this.style,
          colour: style.color.toHexString().slice(0, 7),
          opacity: style.color.a,
        };
        if (editor) {
          editor.image.queueRerenderOf(this);
          editor.queueRerender();
        }
      }

      renderToSVG(canvas) {
        const toScreen = canvas.getCanvasToScreenTransform();
        const style = transformStyle(this.style, toScreen);
        const d = this.path.transformedBy(toScreen).toString();
        const described = JSON.stringify(styleToJSON(style));
        // The gradient is referenced by an id, and the id is a hash of the fill
        // itself.  A counter or the component's own id would do just as well
        // for telling two fills apart, but neither survives a reload: saving a
        // drawing that nobody changed would rewrite the ids and put a diff in
        // the markdown.  Two fills that hash the same are the same fill, and
        // sharing one gradient is right rather than merely harmless.
        const id = `gitea-draw-fill-${hash(`${d}${described}`)}`;
        canvas.drawWithSVGParent((parent) => {
          parent.classList.add(FILL_CLASS);
          parent.setAttribute(FILL_ATTR, described);
          const pathElem = document.createElementNS(SVG_NS, 'path');
          pathElem.setAttribute('d', d);
          if (style.pattern === 'even') {
            pathElem.setAttribute('fill', rgbaString(jsdraw, style.colour, style.opacity));
          } else {
            parent.append(makeGradientDefs(jsdraw, id, style));
            pathElem.setAttribute('fill', `url(#${id})`);
          }
          parent.append(pathElem);
        });
      }

      renderToCanvas(canvas) {
        const style = this.style;
        const d = this.path.toString();
        canvas.drawWithRawRenderingContext((ctx) => {
          ctx.fillStyle = makeCanvasPaint(jsdraw, ctx, style);
          // nonzero, the default, is what leaves the holes in the outline empty
          ctx.fill(new Path2D(d));
        });
      }

      render(canvas, _visibleRect) {
        canvas.startObject(this.contentBBox);
        if (typeof canvas.drawWithSVGParent === 'function') {
          this.renderToSVG(canvas);
        } else if (typeof canvas.drawWithRawRenderingContext === 'function') {
          this.renderToCanvas(canvas);
        } else {
          // a renderer with neither escape hatch (the text-only one js-draw uses
          // for accessibility, say) still gets something the right shape
          canvas.drawPath(pathToRenderable(this.path, {fill: this.flatColour()}));
        }
        canvas.endObject(this.getLoadSaveData());
      }

      // --- what the rest of the editor asks of it

      intersects(lineSegment) {
        if (this.path.intersection(lineSegment).length > 0) return true;
        // a segment entirely inside the paint still hits it
        return this.path.closedContainsPoint(lineSegment.p1);
      }

      intersectsRect(rect) {
        if (!rect.intersects(this.contentBBox)) return false;
        if (rect.containsRect(this.contentBBox)) return true;
        if (this.path.closedContainsPoint(rect.center)) return true;
        return rect.getEdges().some((edge) => this.path.intersection(edge).length > 0);
      }

      applyTransformation(transform) {
        this.path = this.path.transformedBy(transform);
        this.style = transformStyle(this.style, transform);
        this.contentBBox = this.path.bbox;
      }

      createClone() {
        // Path is immutable and every method that changes the style replaces the
        // object rather than writing into it, so a shallow copy is enough to
        // keep a duplicate and its original apart.
        return new FillRegionComponent(this.path, {...this.style});
      }

      description() {
        return i18n.fillDescription;
      }

      serializeToJSON() {
        return {d: this.path.toString(), style: styleToJSON(this.style)};
      }

      static deserializeFromJSON(json) {
        const data = typeof json === 'string' ? JSON.parse(json) : json;
        if (typeof data?.d !== 'string') throw new Error('missing the outline of a filled area');
        return new FillRegionComponent(Path.fromString(data.d), styleFromJSON(jsdraw, data.style));
      }
    }

    AbstractComponent.registerComponent(COMPONENT_KIND, FillRegionComponent.deserializeFromJSON);
    FillRegion = FillRegionComponent;
    return FillRegion;
  }

  function makeGradientDefs(jsdraw, id, style) {
    const defs = document.createElementNS(SVG_NS, 'defs');
    const linear = style.pattern === 'linear';
    const gradient = document.createElementNS(SVG_NS, linear ? 'linearGradient' : 'radialGradient');
    gradient.setAttribute('id', id);
    gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
    if (linear) {
      gradient.setAttribute('x1', String(round(style.from.x)));
      gradient.setAttribute('y1', String(round(style.from.y)));
      gradient.setAttribute('x2', String(round(style.to.x)));
      gradient.setAttribute('y2', String(round(style.to.y)));
    } else {
      gradient.setAttribute('cx', String(round(style.centre.x)));
      gradient.setAttribute('cy', String(round(style.centre.y)));
      gradient.setAttribute('r', String(round(Math.max(style.edge.distanceTo(style.centre), 1e-3))));
    }
    // Both stops are the same colour and only the alpha runs to zero.  Fading
    // to a *transparent black* instead would grey the fill out on its way to
    // nothing, which is what "fades to transparent" looks like when it is done
    // by accident.
    for (const [offset, alpha] of [[0, style.opacity], [1, 0]]) {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', String(offset));
      stop.setAttribute('stop-color', rgbaString(jsdraw, style.colour, 1));
      stop.setAttribute('stop-opacity', String(round(alpha)));
      gradient.append(stop);
    }
    defs.append(gradient);
    return defs;
  }

  function makeCanvasPaint(jsdraw, ctx, style) {
    if (style.pattern === 'even') return rgbaString(jsdraw, style.colour, style.opacity);
    const gradient = style.pattern === 'linear'
      ? ctx.createLinearGradient(style.from.x, style.from.y, style.to.x, style.to.y)
      : ctx.createRadialGradient(
        style.centre.x, style.centre.y, 0,
        style.centre.x, style.centre.y, Math.max(style.edge.distanceTo(style.centre), 1e-3),
      );
    gradient.addColorStop(0, rgbaString(jsdraw, style.colour, style.opacity));
    gradient.addColorStop(1, rgbaString(jsdraw, style.colour, 0));
    return gradient;
  }

  // ---------------------------------------------------------------- reading it back
  //
  // The plugin claims the whole <g> and stops js-draw from descending into it,
  // so the <defs> inside never reaches the loader as an unknown object and the
  // <path>'s `url(#…)` fill is never parsed as a colour.

  function loaderPlugin(jsdraw) {
    const Component = defineComponent(jsdraw);
    return {
      visit: async (node, loader) => {
        if (node.tagName?.toLowerCase() !== 'g') return false;
        if (!node.classList?.contains(FILL_CLASS)) return false;
        const pathElem = node.querySelector('path');
        const d = pathElem?.getAttribute('d');
        if (!d) return false;
        let style;
        try {
          style = styleFromJSON(jsdraw, JSON.parse(node.getAttribute(FILL_ATTR) ?? '{}'));
        } catch {
          return false; // let js-draw make what it can of it rather than losing it
        }
        await loader.addComponent(new Component(jsdraw.Path.fromString(d), style));
        return true;
      },
    };
  }

  // ---------------------------------------------------------------- filling
  //
  // Everything already drawn, rendered on its own into an offscreen canvas.
  // The background is left out on purpose: it is opaque and covers the page, so
  // with it in the raster every pixel would be a wall.  Fills already on the
  // canvas are left out too -- paint is not something new paint should have to
  // flow around.
  function rasterize(jsdraw, editor, rect, scale) {
    const w = Math.max(1, Math.ceil(rect.w * scale));
    const h = Math.max(1, Math.ceil(rect.h * scale));
    const elCanvas = document.createElement('canvas');
    elCanvas.width = w;
    elCanvas.height = h;
    const ctx = elCanvas.getContext('2d', {willReadFrequently: true});

    const viewport = new jsdraw.Viewport(() => {});
    viewport.updateScreenSize(jsdraw.Vec2.of(w, h));
    viewport.resetTransform(
      jsdraw.Mat33.scaling2D(scale).rightMul(jsdraw.Mat33.translation(rect.topLeft.times(-1))),
    );
    const renderer = new jsdraw.CanvasRenderer(ctx, viewport);
    // getAllComponents leaves the background out already; this is about the
    // other two exclusions
    for (const component of editor.image.getAllComponents()) {
      if (component.isBackground?.() || component instanceof FillRegion) continue;
      component.render(renderer, viewport.visibleRect);
    }
    return {pixels: ctx.getImageData(0, 0, w, h).data, w, h};
  }

  // The area everything drawn occupies, plus the point clicked, plus a margin.
  // The margin is what makes "the paint reached the edge" mean "the paint got
  // out": without it a fill of the space around a shape would be bounded by the
  // raster rather than by anything drawn.
  function rasterFrame(jsdraw, editor, at) {
    const components = editor.image.getAllComponents()
      .filter((component) => !component.isBackground?.());
    if (!components.length) return null;
    let box = components[0].getBBox();
    for (const component of components) box = box.union(component.getBBox());
    box = box.union(new jsdraw.Rect2(at.x, at.y, 0, 0));

    // as fine as the board is being looked at, up to the cap
    const cap = cfg.fillMaxRaster / Math.max(box.w, box.h, 1e-6);
    const scale = Math.max(Math.min(editor.viewport.getScaleFactor(), cap), 1e-3);
    return {rect: box.grownBy(4 / scale), scale};
  }

  // Where a gradient runs, worked out from the outline it fills and the point
  // that was clicked.  A linear one crosses the whole area, ending transparent
  // on the chosen side; a radial one starts where the click was, which is what
  // makes clicking somewhere off-centre a way of aiming it.
  function gradientGeometry(jsdraw, pattern, towards, box, at) {
    if (pattern === 'linear') {
      const middle = box.center;
      const ends = {
        bottom: [jsdraw.Vec2.of(middle.x, box.y), jsdraw.Vec2.of(middle.x, box.y + box.h)],
        top: [jsdraw.Vec2.of(middle.x, box.y + box.h), jsdraw.Vec2.of(middle.x, box.y)],
        right: [jsdraw.Vec2.of(box.x, middle.y), jsdraw.Vec2.of(box.x + box.w, middle.y)],
        left: [jsdraw.Vec2.of(box.x + box.w, middle.y), jsdraw.Vec2.of(box.x, middle.y)],
      }[towards] ?? null;
      if (!ends) return {};
      return {from: ends[0], to: ends[1]};
    }
    if (pattern === 'radial') {
      // out to the furthest corner, so the fade has run out everywhere by the
      // time it reaches the edge of the area rather than only on the near side
      let radius = 0;
      for (const corner of box.corners) radius = Math.max(radius, corner.distanceTo(at));
      return {centre: at, edge: jsdraw.Vec2.of(at.x + Math.max(radius, 1e-3), at.y)};
    }
    return {};
  }

  // The whole of it: a point on the canvas in, a component or a reason out.
  function buildFill(jsdraw, editor, at, chosen) {
    const frame = rasterFrame(jsdraw, editor, at);
    if (!frame) return {problem: i18n.fillNothingDrawn};
    const {rect, scale} = frame;

    const {pixels, w, h} = rasterize(jsdraw, editor, rect, scale);
    const ink = inkMask(pixels, cfg.fillInkAlpha);
    const startX = Math.min(w - 1, Math.max(0, Math.floor((at.x - rect.x) * scale)));
    const startY = Math.min(h - 1, Math.max(0, Math.floor((at.y - rect.y) * scale)));

    const filled = floodFill(ink, w, h, startX, startY);
    if (filled.onInk) return {problem: i18n.fillOnInk};
    if (filled.escaped) return {problem: i18n.fillNotClosed};
    if (filled.count < cfg.fillMinArea) return {problem: i18n.fillTooSmall};

    growUnderInk(filled.area, ink, w, h, cfg.fillUnderlap);
    const loops = traceLoops(filled.area, w, h)
      .map((loop) => simplifyLoop(loop, cfg.fillSimplify))
      .filter((loop) => loop.length >= 3);
    if (!loops.length) return {problem: i18n.fillTooSmall};

    // back into canvas coordinates, rounded to something a diff can be read
    // through: half a raster pixel is well inside the accuracy the raster had
    // to begin with
    const tolerance = 0.5 / scale;
    const toCanvas = (point) => jsdraw.Viewport.roundPoint(
      jsdraw.Vec2.of(rect.x + point.x / scale, rect.y + point.y / scale), tolerance,
    );

    let start = null;
    const commands = [];
    for (const loop of loops) {
      const points = loop.map(toCanvas);
      if (!start) start = points[0];
      else commands.push({kind: jsdraw.PathCommandType.MoveTo, point: points[0]});
      for (let i = 1; i < points.length; i++) {
        commands.push({kind: jsdraw.PathCommandType.LineTo, point: points[i]});
      }
      commands.push({kind: jsdraw.PathCommandType.LineTo, point: points[0]});
    }
    const path = new jsdraw.Path(start, commands);

    const style = {
      colour: chosen.colour,
      opacity: chosen.opacity,
      pattern: chosen.pattern,
      ...gradientGeometry(jsdraw, chosen.pattern, chosen.towards, path.bbox, at),
    };

    // Underneath everything, so the lines that closed the area off keep their
    // own colour: translucent paint laid over a stroke washes it out, and a
    // fill is translucent by default.
    let zIndex = 0;
    for (const component of editor.image.getAllComponents()) {
      zIndex = Math.min(zIndex, component.getZIndex());
    }
    return {component: new FillRegion(path, style, zIndex - 1)};
  }

  // ---------------------------------------------------------------- the tool
  //
  // A click, not a drag: a drag with this tool selected is how someone scrolls
  // the board, and filling wherever their finger came to rest would be a
  // surprise.  The threshold is in screen pixels so it does not change with the
  // zoom.

  const DRAG_SLOP = 6;

  function makeTool(jsdraw, editor, onFill) {
    class FillTool extends jsdraw.BaseTool {
      constructor() {
        super(editor.notifier, i18n.fillTool);
        this.downAt = null;
      }

      onPointerDown(event) {
        if (event.allPointers.length > 1) return false; // a pinch, not a click
        this.downAt = event.current.screenPos;
        return true;
      }

      onPointerUp(event) {
        const from = this.downAt;
        this.downAt = null;
        if (!from || event.current.screenPos.distanceTo(from) > DRAG_SLOP) return;
        onFill(event.current.canvasPos);
      }

      onGestureCancel() {
        this.downAt = null;
      }
    }
    return new FillTool();
  }

  // ---------------------------------------------------------------- the button
  //
  // The icon is the fill itself: the outline of an area with the chosen colour,
  // opacity and pattern inside it.  A toolbar button that shows what it is
  // about to do costs one small SVG and saves opening the dropdown to find out.

  let iconCounter = 0;

  function makeIcon(jsdraw, chosen) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    const inside = document.createElementNS(SVG_NS, 'path');
    const shape = 'M20,22 H80 V52 L50,78 L20,52 Z';
    inside.setAttribute('d', shape);
    if (chosen.pattern === 'even') {
      inside.setAttribute('fill', rgbaString(jsdraw, chosen.colour, chosen.opacity));
    } else {
      const id = `gitea-draw-fill-icon-${iconCounter++}`;
      const style = {
        colour: chosen.colour,
        opacity: chosen.opacity,
        pattern: chosen.pattern,
        from: jsdraw.Vec2.of(50, 22),
        to: jsdraw.Vec2.of(50, 78),
        centre: jsdraw.Vec2.of(50, 45),
        edge: jsdraw.Vec2.of(88, 45),
      };
      svg.append(makeGradientDefs(jsdraw, id, style));
      inside.setAttribute('fill', `url(#${id})`);
    }
    const outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute('d', shape);
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', 'currentColor');
    outline.setAttribute('stroke-width', '8');
    outline.setAttribute('stroke-linejoin', 'round');
    svg.append(inside, outline);
    return svg;
  }

  // one labelled row of the dropdown, laid out the way js-draw lays its own out
  function makeRow(labelText, elControl, id) {
    const elRow = document.createElement('div');
    const elLabel = document.createElement('label');
    elLabel.textContent = labelText;
    if (id) {
      elControl.id = id;
      elLabel.setAttribute('for', id);
    }
    elRow.append(elLabel, elControl);
    return elRow;
  }

  let widgetCounter = 0;

  function makeWidget(jsdraw, editor, tool, chosen, onChange) {
    class FillToolWidget extends jsdraw.BaseToolWidget {
      constructor() {
        super(editor, tool, 'gitea-draw-fill');
      }

      getTitle() {
        return i18n.fillTitle;
      }

      createIcon() {
        return makeIcon(jsdraw, chosen);
      }

      getHelpText() {
        return i18n.fillHint;
      }

      // The dropdown is built when the widget is added to the toolbar, which is
      // before the stored toolbar state is read back, so every control needs a
      // way to be told the value it should be showing after the fact.
      fillDropdown(dropdown) {
        const serial = widgetCounter++;
        const elList = document.createElement('div');
        elList.classList.add(
          'toolbar-spacedList', 'toolbar-nonbutton-controls-main-list', 'markup-draw-fill-controls',
        );

        // The colour input carries the opacity in its alpha rather than there
        // being a slider of its own beside it.  js-draw's picker is Coloris with
        // `format: 'hex'` and no `alpha: false`, so it has always drawn an alpha
        // slider under the hue one -- a second control for the same number would
        // have been a second control that disagrees, and the selection menu's
        // colour input already works this way (see getStyle on the component).
        //
        // The cost is that the six preset swatches and the pipette are opaque
        // colours, so picking one is picking 100%: `#1e6bb880` becomes `#ff0000`
        // on a swatch click.  That is the same bargain every drawing program
        // makes once colour and opacity are one control, and it reads as "I
        // picked *that* colour" rather than as something going wrong.
        const colour = jsdraw.makeColorInput(editor, (picked) => {
          chosen.colour = picked.toHexString().slice(0, 7);
          chosen.opacity = picked.a;
          onChange();
        });
        // the colour control is a container around its input, so the label has
        // to be pointed at the input rather than at what makeRow was handed
        const elColourRow = makeRow(i18n.fillColourLabel, colour.container);
        colour.input.id = `markup-draw-fill-colour-${serial}`;
        elColourRow.querySelector('label').setAttribute('for', colour.input.id);

        const elPattern = document.createElement('select');
        for (const [value, label] of [
          ['even', i18n.fillPatternEven],
          ['linear', i18n.fillPatternLinear],
          ['radial', i18n.fillPatternRadial],
        ]) {
          const elOption = document.createElement('option');
          elOption.value = value;
          elOption.textContent = label;
          elPattern.append(elOption);
        }
        elPattern.value = chosen.pattern;
        const elPatternRow = makeRow(
          i18n.fillPatternLabel, elPattern, `markup-draw-fill-pattern-${serial}`,
        );

        const elTowards = document.createElement('select');
        for (const [value, label] of [
          ['bottom', i18n.fillTowardsBottom],
          ['top', i18n.fillTowardsTop],
          ['right', i18n.fillTowardsRight],
          ['left', i18n.fillTowardsLeft],
        ]) {
          const elOption = document.createElement('option');
          elOption.value = value;
          elOption.textContent = label;
          elTowards.append(elOption);
        }
        elTowards.value = chosen.towards;
        const elTowardsRow = makeRow(
          i18n.fillTowardsLabel, elTowards, `markup-draw-fill-towards-${serial}`,
        );

        // only a gradient that runs along a line has a side to run towards
        this.updateInputs = () => {
          colour.setValue(withAlpha(chosen.colour, chosen.opacity));
          elPattern.value = chosen.pattern;
          elTowards.value = chosen.towards;
          elTowardsRow.style.display = chosen.pattern === 'linear' ? '' : 'none';
        };
        elPattern.addEventListener('change', () => {
          chosen.pattern = elPattern.value;
          this.updateInputs();
          onChange();
        });
        elTowards.addEventListener('change', () => {
          chosen.towards = elTowards.value;
          onChange();
        });
        this.updateInputs();

        const elHint = document.createElement('div');
        elHint.className = 'markup-draw-fill-hint';
        elHint.textContent = i18n.fillHint;

        elList.replaceChildren(elColourRow, elPatternRow, elTowardsRow, elHint);
        dropdown.replaceChildren(elList);
        return true;
      }

      serializeState() {
        return {...super.serializeState(), ...chosen};
      }

      deserializeFrom(state) {
        super.deserializeFrom(state);
        if (typeof state.colour === 'string') chosen.colour = state.colour;
        if (Number.isFinite(state.opacity)) chosen.opacity = state.opacity;
        if (['even', 'linear', 'radial'].includes(state.pattern)) chosen.pattern = state.pattern;
        if (['bottom', 'top', 'right', 'left'].includes(state.towards)) chosen.towards = state.towards;
        this.updateInputs?.();
        onChange();
      }
    }
    return new FillToolWidget();
  }

  // ---------------------------------------------------------------- what it says back
  //
  // Nothing filled needs a reason, and the reason belongs on the canvas rather
  // than in a browser dialog -- the same rule the board's other questions
  // follow.  It fades itself out; a second one replaces the first.

  function makeNotes(elRoot) {
    let elNote = null;
    let timer = null;
    return (text) => {
      if (timer) window.clearTimeout(timer);
      if (!elNote) {
        elNote = document.createElement('div');
        elNote.className = 'markup-draw-fill-note';
        elRoot.append(elNote);
      }
      elNote.textContent = text;
      elNote.classList.remove('markup-draw-fill-note-fading');
      timer = window.setTimeout(() => {
        elNote?.classList.add('markup-draw-fill-note-fading');
      }, 3200);
    };
  }

  // ---------------------------------------------------------------- the namespace

  const status = {
    available: false,
    why: 'no drawing board opened yet',
    chosen: null,
    lastProblem: null,
  };

  function create(jsdraw, editor, elRoot) {
    if (!cfg.fill) {
      status.why = 'turned off in giteaDrawConfig';
      return null;
    }
    defineComponent(jsdraw);

    const chosen = {
      colour: cfg.fillColour,
      opacity: cfg.fillOpacity,
      pattern: cfg.fillPattern,
      towards: cfg.fillFadeTowards,
    };
    status.chosen = chosen;
    status.lastProblem = null;

    const note = makeNotes(elRoot);
    let widget = null;

    const fillAt = (at) => {
      let result;
      try {
        result = buildFill(jsdraw, editor, at, chosen);
      } catch (err) {
        // A fill that cannot be worked out must never take the drawing with it
        result = {problem: String(err?.message ?? err)};
      }
      status.lastProblem = result.problem ?? null;
      if (result.problem) {
        note(result.problem);
        editor.announceForAccessibility(result.problem);
        return;
      }
      editor.dispatch(jsdraw.EditorImage.addComponent(result.component));
    };

    const tool = makeTool(jsdraw, editor, fillAt);
    // A BaseTool starts enabled, and joining the primary group while enabled
    // turns the pen off -- a board that opened with the fill tool already
    // selected would look like drawing had stopped working.
    tool.setEnabled(false);
    editor.toolController.addPrimaryTool(tool);
    status.available = true;
    status.why = '';

    return {
      addToToolbar(toolbar) {
        widget = makeWidget(jsdraw, editor, tool, chosen, () => widget?.updateIcon());
        toolbar.addWidget(widget);
      },
    };
  }

  draw.filling = {
    // Called the moment js-draw itself is loaded, whoever loaded it.  Reading a
    // fill back has to work everywhere a drawing is rebuilt, and that is more
    // places than the board: the player replays the same commands into an
    // editor of its own.
    //
    // Neither this nor the loader plugin is gated on cfg.fill, and that is the
    // point of them being separate from `create`: turning the tool off has to
    // mean "do not offer the button", not "stop being able to read drawings
    // that already have a fill in them".
    register: defineComponent,
    // called before the editor is built, so a stored drawing loads its fills
    loaderPlugins: (jsdraw) => [loaderPlugin(jsdraw)],
    // called once the editor exists and before its toolbar is built
    create,
    // what giteaDrawDebug() reports
    status: () => ({...status, chosen: status.chosen ? {...status.chosen} : null}),
  };
})();
