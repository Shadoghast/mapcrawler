# Mapcrawler — CLAUDE.md

Foundry VTT module (v13 minimum / v14 verified). Adds an animated "travel montage"
drawing tool to the scene canvas — inspired by the Indiana Jones map sequences.

---

## What This Module Does

When Travel Mode is active, the user can:
1. **Click and hold** on the canvas → drops an animated starting dot (filled circle).
2. **Drag** while held → traces a dashed line path following the cursor.
3. **Release** the mouse → drops an animated ending dot (filled circle).
4. The entire sequence (start dot → dashed path → end dot) plays as a one-shot
   animation that then remains permanently visible on the canvas as a Drawing.

---

## File Structure

```
mapcrawler/
├── CLAUDE.md                         ← this file
├── module.json                       ← manifest
├── mapcrawler.mjs                    ← single entry point
├── lang/
│   └── en.json                       ← i18n strings
├── styles/
│   └── mapcrawler.css                ← CSS with @layer declarations
└── module/
    ├── config.mjs                    ← MAPCRAWLER constants
    ├── travel-mode.mjs               ← core canvas interaction & animation logic
    └── ui/
        └── travel-controls.mjs       ← scene control button injection
```

---

## module.json (manifest)

```json
{
  "id": "mapcrawler",
  "title": "Mapcrawler",
  "description": "Animated Indiana Jones-style travel path drawing tool for scene maps.",
  "version": "1.0.0",
  "compatibility": {
    "minimum": "13",
    "verified": "14"
  },
  "authors": [{ "name": "Dan Weiss" }],
  "esmodules": ["mapcrawler.mjs"],
  "styles": ["styles/mapcrawler.css"],
  "languages": [
    { "lang": "en", "name": "English", "path": "lang/en.json" }
  ],
  "socket": false
}
```

---

## Entry Point (mapcrawler.mjs)

```js
import { MAPCRAWLER }      from "./module/config.mjs";
import { TravelMode }      from "./module/travel-mode.mjs";
import { registerControls } from "./module/ui/travel-controls.mjs";

globalThis.mapcrawler = { config: MAPCRAWLER, TravelMode };

Hooks.once("init", function () {
  globalThis.mapcrawler = game.mapcrawler = Object.assign(
    game.modules.get("mapcrawler"),
    globalThis.mapcrawler
  );
  console.log("Mapcrawler | Initialised");
});

Hooks.once("ready", function () {
  TravelMode.init();
});

// Inject the Travel Mode button into the drawing tools panel
Hooks.on("getSceneControlButtons", (controls) => {
  registerControls(controls);
});
```

---

## module/config.mjs

```js
export const MAPCRAWLER = {
  // Dot radius in pixels (scene units)
  DOT_RADIUS: 8,

  // Dashed line configuration
  DASH_LENGTH: 12,
  GAP_LENGTH: 8,
  LINE_WIDTH: 3,

  // Animation speed — pixels of path revealed per frame (at 60fps)
  REVEAL_SPEED: 4,

  // Visual style defaults
  DEFAULT_COLOR: 0xFFD700,   // gold
  DEFAULT_ALPHA: 1.0,

  // Animation phase durations (ms) for dot pulse-in
  DOT_ANIM_DURATION: 400,
};
```

---

## module/ui/travel-controls.mjs

Injects a "Travel Mode" toggle button into the **Drawing tools** section of the
Scene Controls sidebar. Uses the `getSceneControlButtons` hook pattern.

```js
import { TravelMode } from "../travel-mode.mjs";

export function registerControls(controls) {
  // Find the "drawings" control group
  const drawingControls = controls.find(c => c.name === "drawings");
  if (!drawingControls) return;

  drawingControls.tools.push({
    name:    "travel-mode",
    title:   "MAPCRAWLER.TravelMode",   // localised via lang/en.json
    icon:    "fas fa-route",
    toggle:  true,                       // renders as a toggle button
    active:  TravelMode.active,
    onClick: (toggled) => TravelMode.setActive(toggled),
  });
}
```

**Important v13/v14 note:** The `getSceneControlButtons` hook passes the full
`controls` array. Always find by `name` — never by index.

---

## module/travel-mode.mjs

This is the heart of the module. It manages:
- Canvas mouse event listeners (mousedown / mousemove / mouseup)
- A live PIXI.Graphics overlay used during the drag interaction
- Animation playback after mouse release
- Persisting the finished path as a Foundry **Drawing** document

### State machine

```
IDLE  ──[mousedown]──▶  DRAGGING  ──[mouseup]──▶  ANIMATING  ──[done]──▶  IDLE
```

### Full implementation sketch

```js
import { MAPCRAWLER } from "./config.mjs";

export class TravelMode {
  static active = false;

  // Internal state
  static #state   = "IDLE";          // "IDLE" | "DRAGGING" | "ANIMATING"
  static #points  = [];              // array of {x, y} in canvas coords
  static #overlay = null;            // PIXI.Graphics for live preview
  static #ticker  = null;            // PIXI.Ticker for animation

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  static init() {
    // Bind handlers with stable references so we can remove them
    TravelMode._onMouseDown = TravelMode.#handleMouseDown.bind(TravelMode);
    TravelMode._onMouseMove = TravelMode.#handleMouseMove.bind(TravelMode);
    TravelMode._onMouseUp   = TravelMode.#handleMouseUp.bind(TravelMode);
  }

  static setActive(value) {
    TravelMode.active = value;

    if (value) {
      // Attach listeners to the canvas stage
      canvas.stage.on("mousedown",  TravelMode._onMouseDown);
      canvas.stage.on("mousemove",  TravelMode._onMouseMove);
      canvas.stage.on("mouseup",    TravelMode._onMouseUp);
      canvas.stage.on("rightdown",  TravelMode._cancelDrag);
    } else {
      TravelMode.#removeListeners();
      TravelMode.#cleanup();
    }
  }

  // ── Mouse Handlers ────────────────────────────────────────────────────────

  static #handleMouseDown(event) {
    if (TravelMode.#state !== "IDLE") return;

    const pos = event.data.getLocalPosition(canvas.stage);
    TravelMode.#points = [{ x: pos.x, y: pos.y }];
    TravelMode.#state  = "DRAGGING";

    // Create PIXI overlay on the drawings layer (or a dedicated temp container)
    TravelMode.#overlay = new PIXI.Graphics();
    canvas.drawings.addChild(TravelMode.#overlay);

    // Draw the starting dot immediately
    TravelMode.#drawDot(TravelMode.#overlay, pos.x, pos.y);
  }

  static #handleMouseMove(event) {
    if (TravelMode.#state !== "DRAGGING") return;

    const pos = event.data.getLocalPosition(canvas.stage);
    TravelMode.#points.push({ x: pos.x, y: pos.y });

    // Redraw preview: start dot + dashed path to cursor (no end dot yet)
    TravelMode.#overlay.clear();
    TravelMode.#drawDot(TravelMode.#overlay, TravelMode.#points[0].x, TravelMode.#points[0].y);
    TravelMode.#drawDashedPath(TravelMode.#overlay, TravelMode.#points);
  }

  static #handleMouseUp(event) {
    if (TravelMode.#state !== "DRAGGING") return;

    const pos = event.data.getLocalPosition(canvas.stage);
    TravelMode.#points.push({ x: pos.x, y: pos.y });
    TravelMode.#state = "ANIMATING";

    // Remove live preview; replace with animated version
    TravelMode.#overlay.destroy();
    TravelMode.#overlay = null;

    TravelMode.#playAnimation(TravelMode.#points);
  }

  // ── Drawing Helpers ───────────────────────────────────────────────────────

  /**
   * Draw a filled circle at (x, y).
   */
  static #drawDot(gfx, x, y) {
    gfx.beginFill(MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);
    gfx.drawCircle(x, y, MAPCRAWLER.DOT_RADIUS);
    gfx.endFill();
  }

  /**
   * Draw a dashed polyline through an array of {x, y} points.
   * PIXI does not natively support dashed lines; we simulate by walking
   * the path segment-by-segment and alternating draw / skip.
   */
  static #drawDashedPath(gfx, points, revealUpTo = Infinity) {
    if (points.length < 2) return;

    gfx.lineStyle(MAPCRAWLER.LINE_WIDTH, MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);

    const dash = MAPCRAWLER.DASH_LENGTH;
    const gap  = MAPCRAWLER.GAP_LENGTH;
    let cycle  = 0;       // position within current dash+gap cycle
    let drawn  = 0;       // total pixels drawn so far
    let drawing = true;   // true = currently in a dash, false = in a gap

    for (let i = 1; i < points.length; i++) {
      const ax = points[i - 1].x, ay = points[i - 1].y;
      const bx = points[i].x,     by = points[i].y;
      const segLen = Math.hypot(bx - ax, by - ay);
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

  // ── Animation ─────────────────────────────────────────────────────────────

  /**
   * Plays the reveal animation:
   *   1. Start dot pulses in (scale 0 → 1).
   *   2. Dashed path is progressively revealed at REVEAL_SPEED px/frame.
   *   3. End dot pulses in once the path is fully drawn.
   *   4. On completion, the graphics are converted to a persistent Drawing
   *      document and the PIXI overlay is removed.
   */
  static #playAnimation(points) {
    const totalLength = TravelMode.#pathLength(points);
    let revealed      = 0;          // pixels of path revealed so far
    let startScale    = 0;          // for dot pulse-in (0 → 1)
    let endDotShown   = false;

    const gfx = new PIXI.Graphics();
    canvas.drawings.addChild(gfx);
    TravelMode.#overlay = gfx;

    // --- phase tracking ---
    const PHASE_START_DOT = "START_DOT";
    const PHASE_PATH      = "PATH";
    const PHASE_END_DOT   = "END_DOT";
    const PHASE_DONE      = "DONE";
    let phase             = PHASE_START_DOT;
    let phaseTimer        = 0;

    const ticker = new PIXI.Ticker();
    TravelMode.#ticker = ticker;

    ticker.add((delta) => {
      gfx.clear();
      phaseTimer += delta * (1000 / 60);   // convert delta frames → ms

      if (phase === PHASE_START_DOT) {
        // Pulse start dot in over DOT_ANIM_DURATION ms
        startScale = Math.min(1, phaseTimer / MAPCRAWLER.DOT_ANIM_DURATION);
        const p    = points[0];
        gfx.beginFill(MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);
        gfx.drawCircle(p.x, p.y, MAPCRAWLER.DOT_RADIUS * startScale);
        gfx.endFill();

        if (startScale >= 1) { phase = PHASE_PATH; phaseTimer = 0; }

      } else if (phase === PHASE_PATH) {
        // Draw start dot (full)
        TravelMode.#drawDot(gfx, points[0].x, points[0].y);

        // Reveal path progressively
        revealed = Math.min(totalLength, revealed + MAPCRAWLER.REVEAL_SPEED * delta);
        TravelMode.#drawDashedPath(gfx, points, revealed);

        if (revealed >= totalLength) { phase = PHASE_END_DOT; phaseTimer = 0; }

      } else if (phase === PHASE_END_DOT) {
        // Full path + start dot always visible
        TravelMode.#drawDot(gfx, points[0].x, points[0].y);
        TravelMode.#drawDashedPath(gfx, points);

        // Pulse end dot in
        const endScale = Math.min(1, phaseTimer / MAPCRAWLER.DOT_ANIM_DURATION);
        const last     = points[points.length - 1];
        gfx.beginFill(MAPCRAWLER.DEFAULT_COLOR, MAPCRAWLER.DEFAULT_ALPHA);
        gfx.drawCircle(last.x, last.y, MAPCRAWLER.DOT_RADIUS * endScale);
        gfx.endFill();

        if (endScale >= 1) { phase = PHASE_DONE; }

      } else if (phase === PHASE_DONE) {
        ticker.stop();
        ticker.destroy();
        TravelMode.#ticker = null;

        // Persist and clean up
        TravelMode.#persistAsDrawing(points, gfx).then(() => {
          gfx.destroy();
          TravelMode.#overlay = null;
          TravelMode.#state   = "IDLE";
          TravelMode.#points  = [];
        });
      }
    });

    ticker.start();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Convert the finished path into a Foundry Drawing document so it
   * persists across page reloads and is visible to all clients.
   *
   * We store it as a Drawing of type "p" (polygon / freehand polyline).
   * The dashed appearance is encoded in the Drawing's dash settings.
   */
  static async #persistAsDrawing(points, gfx) {
    if (!canvas.scene) return;

    // Bounding box of the path
    const xs  = points.map(p => p.x);
    const ys  = points.map(p => p.y);
    const x   = Math.min(...xs);
    const y   = Math.min(...ys);

    // Relative points (Drawing coords are relative to top-left of bounding box)
    const rel = points.map(p => ({ x: p.x - x, y: p.y - y }));

    const drawingData = {
      type:        CONST.DRAWING_TYPES.FREEHAND,   // "f"
      author:      game.user.id,
      x, y,
      shape: {
        points: rel.flatMap(p => [p.x, p.y]),
      },
      strokeWidth:  MAPCRAWLER.LINE_WIDTH,
      strokeColor:  `#${MAPCRAWLER.DEFAULT_COLOR.toString(16).padStart(6, "0")}`,
      strokeAlpha:  MAPCRAWLER.DEFAULT_ALPHA,
      fillType:     CONST.DRAWING_FILL_TYPES.NONE,
      bezierFactor: 0,
    };

    await canvas.scene.createEmbeddedDocuments("Drawing", [drawingData]);

    // Also persist the two dots as separate circle drawings
    const startPt = points[0];
    const endPt   = points[points.length - 1];
    const r       = MAPCRAWLER.DOT_RADIUS;

    await canvas.scene.createEmbeddedDocuments("Drawing", [
      TravelMode.#dotDrawingData(startPt.x - r, startPt.y - r, r * 2, r * 2),
      TravelMode.#dotDrawingData(endPt.x   - r, endPt.y   - r, r * 2, r * 2),
    ]);
  }

  static #dotDrawingData(x, y, w, h) {
    return {
      type:       CONST.DRAWING_TYPES.ELLIPSE,
      author:     game.user.id,
      x, y,
      shape:      { width: w, height: h },
      strokeWidth: 0,
      fillType:   CONST.DRAWING_FILL_TYPES.SOLID,
      fillColor:  `#${MAPCRAWLER.DEFAULT_COLOR.toString(16).padStart(6, "0")}`,
      fillAlpha:  MAPCRAWLER.DEFAULT_ALPHA,
    };
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

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

  static _cancelDrag = () => {
    if (TravelMode.#state !== "DRAGGING") return;
    TravelMode.#cleanup();
  };
}
```

---

## lang/en.json

```json
{
  "MAPCRAWLER.TravelMode": "Travel Mode",
  "MAPCRAWLER.TravelModeHint": "Click and drag to draw an animated travel path."
}
```

---

## styles/mapcrawler.css

```css
@layer mapcrawler-base, mapcrawler-components;

@layer mapcrawler-base {
  /* Currently no custom HUD styles needed — drawing happens on PIXI canvas */
}

@layer mapcrawler-components {
  /* Future: style a config dialog or HUD controls here */
}
```

---

## Key Implementation Rules (v13 / v14)

| Topic | Rule |
|-------|------|
| **CSS Layers** | Always declare `@layer` at the top of `mapcrawler.css`. |
| **No jQuery** | All DOM manipulation uses native APIs (`querySelector`, `addEventListener`). |
| **No FormApplication** | Any future settings dialog must use `HandlebarsApplicationMixin(ApplicationV2)`. |
| **PIXI version** | Foundry v13 ships PIXI 7.x; v14 ships PIXI 8.x. Avoid APIs removed between versions. `PIXI.Ticker` API is stable across both. |
| **Canvas readiness** | Never access `canvas.drawings` before `ready` hook. All canvas interaction is set up in `Hooks.once("ready")`. |
| **Drawing coords** | PIXI `mousedown`/`mousemove` positions from `event.data.getLocalPosition(canvas.stage)` are in world-space — same coordinates stored in Drawing documents. |
| **Drawing types** | Use `CONST.DRAWING_TYPES.FREEHAND` (`"f"`) for path, `CONST.DRAWING_TYPES.ELLIPSE` (`"e"`) for dots. |
| **Point reduction** | The raw `mousemove` stream produces hundreds of points. Consider throttling to every 5px of movement or running a Douglas-Peucker simplification before persisting. |
| **Permission** | Only users with `DRAWING_CREATE` permission can call `createEmbeddedDocuments("Drawing", ...)`. The tool button should be hidden or disabled for users without this permission. |

---

## Known Challenges & Decisions

### Dashed lines in PIXI
PIXI.Graphics has no native dash support. The `#drawDashedPath` method walks each
segment manually. This is slightly expensive for very long paths — but acceptable
for typical map distances. An alternative is to render to a `PIXI.RenderTexture`
and apply a dash shader, but that is significantly more complex.

### Throttling mouse points
Add a distance threshold to `#handleMouseMove`:
```js
const last = TravelMode.#points.at(-1);
if (Math.hypot(pos.x - last.x, pos.y - last.y) < 5) return; // skip jitter
```

### Multi-client animation
The animation currently plays only on the placing client; other connected clients
see the static Drawing documents appear when `createEmbeddedDocuments` resolves.
If synchronized animation is needed, use `game.socket.emit()` with `"socket": true`
in module.json to broadcast a play-animation event to all clients.

### Undo support
Foundry's built-in Ctrl+Z will undo the last Drawing document created. Since we
create 3 documents (path + 2 dots), undoing cleanly requires grouping them via a
custom flag or deleting as a batch. Consider storing their IDs in a module flag.

---

## Future Enhancements

- **Color picker** in scene controls or a module settings dialog
- **Line width / dot size** controls
- **Path smoothing** via Bezier interpolation (set `bezierFactor > 0`)
- **Sound effect** that plays during animation (like the Indiana Jones map music)
- **Looping animation** option instead of one-shot
- **Waypoints** — multiple intermediate dots along the path
