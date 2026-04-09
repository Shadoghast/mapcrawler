import { MAPCRAWLER } from "./config.mjs";

export class TravelMode {
  static active = false;

  // Internal state
  static #state   = "IDLE";       // "IDLE" | "DRAGGING" | "ANIMATING"
  static #points  = [];           // array of {x, y} in canvas world coords
  static #overlay = null;         // PIXI.Graphics for live preview / animation
  static #ticker  = null;         // PIXI.Ticker for animation

  // Stable bound references so addEventListener/removeEventListener match
  static _onMouseDown = null;
  static _onMouseMove = null;
  static _onMouseUp   = null;
  static _cancelDrag  = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  static init() {
    TravelMode._onMouseDown = TravelMode.#handleMouseDown.bind(TravelMode);
    TravelMode._onMouseMove = TravelMode.#handleMouseMove.bind(TravelMode);
    TravelMode._onMouseUp   = TravelMode.#handleMouseUp.bind(TravelMode);
    TravelMode._cancelDrag  = TravelMode.#doCancelDrag.bind(TravelMode);
  }

  static setActive(value) {
    TravelMode.active = value;

    if (value) {
      canvas.stage.on("mousedown", TravelMode._onMouseDown);
      canvas.stage.on("mousemove", TravelMode._onMouseMove);
      canvas.stage.on("mouseup",   TravelMode._onMouseUp);
      canvas.stage.on("rightdown", TravelMode._cancelDrag);
    } else {
      TravelMode.#removeListeners();
      TravelMode.#cleanup();
    }
  }

  // ── Mouse Handlers ──────────────────────────────────────────────────────────

  static #handleMouseDown(event) {
    if (TravelMode.#state !== "IDLE") return;

    const pos = event.data.getLocalPosition(canvas.stage);
    TravelMode.#points = [{ x: pos.x, y: pos.y }];
    TravelMode.#state  = "DRAGGING";

    TravelMode.#overlay = new PIXI.Graphics();
    canvas.drawings.addChild(TravelMode.#overlay);

    TravelMode.#drawDot(TravelMode.#overlay, pos.x, pos.y);
  }

  static #handleMouseMove(event) {
    if (TravelMode.#state !== "DRAGGING") return;

    const pos  = event.data.getLocalPosition(canvas.stage);
    const last = TravelMode.#points.at(-1);

    // Throttle: skip points within 5px to avoid bloating the array with jitter
    if (Math.hypot(pos.x - last.x, pos.y - last.y) < 5) return;

    TravelMode.#points.push({ x: pos.x, y: pos.y });

    // Redraw live preview: start dot + dashed path to cursor (no end dot yet)
    TravelMode.#overlay.clear();
    TravelMode.#drawDot(TravelMode.#overlay, TravelMode.#points[0].x, TravelMode.#points[0].y);
    TravelMode.#drawDashedPath(TravelMode.#overlay, TravelMode.#points);
  }

  static #handleMouseUp(event) {
    if (TravelMode.#state !== "DRAGGING") return;

    const pos = event.data.getLocalPosition(canvas.stage);
    TravelMode.#points.push({ x: pos.x, y: pos.y });
    TravelMode.#state = "ANIMATING";

    // Tear down the live preview; animation will build its own overlay
    TravelMode.#overlay.destroy();
    TravelMode.#overlay = null;

    TravelMode.#playAnimation(TravelMode.#points);
  }

  static #doCancelDrag() {
    if (TravelMode.#state !== "DRAGGING") return;
    TravelMode.#cleanup();
  }

  // ── Drawing Helpers ─────────────────────────────────────────────────────────

  /** Draw a filled circle at (x, y). */
  static #drawDot(gfx, x, y) {
    gfx.beginFill(MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);
    gfx.drawCircle(x, y, MAPCRAWLER.DOT_RADIUS);
    gfx.endFill();
  }

  /**
   * Draw a dashed polyline through an array of {x, y} points.
   * PIXI has no native dash support — we walk each segment and alternate
   * draw / skip manually.
   *
   * @param {PIXI.Graphics} gfx
   * @param {{x:number,y:number}[]} points
   * @param {number} [revealUpTo=Infinity]  Only reveal this many pixels of path.
   */
  static #drawDashedPath(gfx, points, revealUpTo = Infinity) {
    if (points.length < 2) return;

    gfx.lineStyle(MAPCRAWLER.LINE_WIDTH, MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);

    const dash = MAPCRAWLER.DASH_LENGTH;
    const gap  = MAPCRAWLER.GAP_LENGTH;
    let cycle   = 0;      // position within current dash-or-gap
    let drawn   = 0;      // total pixels emitted so far
    let drawing = true;   // true = in a dash, false = in a gap

    for (let i = 1; i < points.length; i++) {
      const ax = points[i - 1].x, ay = points[i - 1].y;
      const bx = points[i].x,     by = points[i].y;
      const segLen = Math.hypot(bx - ax, by - ay);
      if (segLen === 0) continue;

      const dx = (bx - ax) / segLen;
      const dy = (by - ay) / segLen;
      let traveled = 0;

      while (traveled < segLen) {
        if (drawn >= revealUpTo) return;

        const remain  = drawing ? (dash - cycle) : (gap - cycle);
        const canMove = Math.min(remain, segLen - traveled, revealUpTo - drawn);

        const nx = ax + dx * (traveled + canMove);
        const ny = ay + dy * (traveled + canMove);

        if (drawing) {
          if (cycle === 0) gfx.moveTo(ax + dx * traveled, ay + dy * traveled);
          gfx.lineTo(nx, ny);
        }

        cycle    += canMove;
        traveled += canMove;
        drawn    += canMove;

        if (cycle >= (drawing ? dash : gap)) {
          cycle   = 0;
          drawing = !drawing;
        }
      }
    }
  }

  // ── Animation ───────────────────────────────────────────────────────────────

  /**
   * Plays the three-phase reveal animation:
   *   1. START_DOT  — start dot pulses in (scale 0 → 1, DOT_ANIM_DURATION ms).
   *   2. PATH       — dashed path is progressively revealed at REVEAL_SPEED px/frame.
   *   3. END_DOT    — end dot pulses in once the path is fully drawn.
   *   4. DONE       — persists everything as Drawing documents, cleans up.
   */
  static #playAnimation(points) {
    const totalLength = TravelMode.#pathLength(points);

    let revealed   = 0;
    let phaseTimer = 0;
    let phase      = "START_DOT";

    const gfx = new PIXI.Graphics();
    canvas.drawings.addChild(gfx);
    TravelMode.#overlay = gfx;

    const ticker = new PIXI.Ticker();
    TravelMode.#ticker = ticker;

    ticker.add((delta) => {
      // DONE must be checked BEFORE gfx.clear() so the final frame stays
      // visible on-screen while Foundry creates the persistent Drawing docs.
      if (phase === "DONE") {
        ticker.stop();
        ticker.destroy();
        TravelMode.#ticker = null;

        TravelMode.#persistAsDrawing(points)
          .catch(err => console.error("Mapcrawler | Failed to persist drawing:", err))
          .finally(() => {
            if (!gfx.destroyed) gfx.destroy();
            TravelMode.#overlay = null;
            TravelMode.#state   = "IDLE";
            TravelMode.#points  = [];
          });
        return; // leave gfx intact until persist resolves
      }

      gfx.clear();
      // delta is in frames; convert to ms assuming 60fps
      phaseTimer += delta * (1000 / 60);

      if (phase === "START_DOT") {
        const scale = Math.min(1, phaseTimer / MAPCRAWLER.DOT_ANIM_DURATION);
        const p     = points[0];
        gfx.beginFill(MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);
        gfx.drawCircle(p.x, p.y, MAPCRAWLER.DOT_RADIUS * scale);
        gfx.endFill();

        if (scale >= 1) { phase = "PATH"; phaseTimer = 0; }

      } else if (phase === "PATH") {
        TravelMode.#drawDot(gfx, points[0].x, points[0].y);

        revealed = Math.min(totalLength, revealed + MAPCRAWLER.REVEAL_SPEED * delta);
        TravelMode.#drawDashedPath(gfx, points, revealed);

        if (revealed >= totalLength) { phase = "END_DOT"; phaseTimer = 0; }

      } else if (phase === "END_DOT") {
        TravelMode.#drawDot(gfx, points[0].x, points[0].y);
        TravelMode.#drawDashedPath(gfx, points);

        const endScale = Math.min(1, phaseTimer / MAPCRAWLER.DOT_ANIM_DURATION);
        const last     = points[points.length - 1];
        gfx.beginFill(MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);
        gfx.drawCircle(last.x, last.y, MAPCRAWLER.DOT_RADIUS * endScale);
        gfx.endFill();

        if (endScale >= 1) { phase = "DONE"; }
      }
    });

    ticker.start();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Convert the finished path into persistent Foundry Drawing documents so they
   * survive page reloads and are visible to all clients.
   *
   * Creates three documents: the freehand path + start dot + end dot.
   */
  static async #persistAsDrawing(points) {
    if (!canvas.scene) return;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const x  = Math.min(...xs);
    const y  = Math.min(...ys);
    const w  = Math.max(...xs) - x;
    const h  = Math.max(...ys) - y;

    // Drawing coords are relative to the bounding box top-left
    const rel = points.map(p => ({ x: p.x - x, y: p.y - y }));

    const colorHex   = `#${MAPCRAWLER.DEFAULT_COLOR.toString(16).padStart(6, "0")}`;

    // Safe CONST fallbacks — values are stable across v11-v14 but guard anyway
    const TYPE_FREE  = CONST.DRAWING_TYPES?.FREEHAND  ?? "f";
    const TYPE_ELLIP = CONST.DRAWING_TYPES?.ELLIPSE   ?? "e";
    const FILL_NONE  = CONST.DRAWING_FILL_TYPES?.NONE  ?? 0;
    const FILL_SOLID = CONST.DRAWING_FILL_TYPES?.SOLID ?? 1;

    const [pathDoc] = await canvas.scene.createEmbeddedDocuments("Drawing", [{
      type:        TYPE_FREE,
      author:      game.user.id,
      x, y,
      shape: {
        // width/height required in v13 for the renderer to size the drawing correctly
        width:  Math.max(w, 1),
        height: Math.max(h, 1),
        points: rel.flatMap(p => [p.x, p.y]),
      },
      strokeWidth:  MAPCRAWLER.LINE_WIDTH,
      strokeColor:  colorHex,
      strokeAlpha:  MAPCRAWLER.DEFAULT_ALPHA,
      fillType:     FILL_NONE,
      bezierFactor: 0,
    }]);

    // Store world-space points on the path doc so the animation can be replayed
    await pathDoc.setFlag("mapcrawler", "points", points);

    const startPt = points[0];
    const endPt   = points[points.length - 1];
    const r       = MAPCRAWLER.DOT_RADIUS;

    await canvas.scene.createEmbeddedDocuments("Drawing", [
      TravelMode.#dotDrawingData(startPt.x - r, startPt.y - r, r * 2, colorHex, TYPE_ELLIP, FILL_SOLID),
      TravelMode.#dotDrawingData(endPt.x   - r, endPt.y   - r, r * 2, colorHex, TYPE_ELLIP, FILL_SOLID),
    ]);
  }

  static #dotDrawingData(x, y, diameter, colorHex, type, fillSolid) {
    return {
      type,
      author:      game.user.id,
      x, y,
      shape:       { width: diameter, height: diameter },
      strokeWidth: 0,
      fillType:    fillSolid,
      fillColor:   colorHex,
      fillAlpha:   MAPCRAWLER.DEFAULT_ALPHA,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** True when no animation or drag is in progress. */
  static get isIdle() {
    return TravelMode.#state === "IDLE";
  }

  /**
   * Replay the travel animation for an existing Drawing.
   * Safe to call at any time — silently ignored if already animating.
   *
   * @param {{x:number,y:number}[]} points  World-space points stored on the Drawing flag.
   */
  static replayAnimation(points) {
    if (TravelMode.#state !== "IDLE") return;
    TravelMode.#state = "ANIMATING";
    TravelMode.#playAnimation(points);
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  /** Total arc-length of a polyline. */
  static #pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].y - points[i - 1].y
      );
    }
    return total;
  }

  static #removeListeners() {
    canvas.stage.off("mousedown", TravelMode._onMouseDown);
    canvas.stage.off("mousemove", TravelMode._onMouseMove);
    canvas.stage.off("mouseup",   TravelMode._onMouseUp);
    canvas.stage.off("rightdown", TravelMode._cancelDrag);
  }

  static #cleanup() {
    TravelMode.#ticker?.stop();
    TravelMode.#ticker?.destroy();
    TravelMode.#ticker  = null;
    TravelMode.#overlay?.destroy();
    TravelMode.#overlay = null;
    TravelMode.#state   = "IDLE";
    TravelMode.#points  = [];
  }
}
