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
  _patchDrawingClick();
});

/**
 * Patch Drawing._onClickLeft so that clicking a Mapcrawler drawing replays
 * its animation instead of just selecting it.
 * Skipped while Travel Mode is active (the stage-level mousedown owns that).
 */
function _patchDrawingClick() {
  const _onClickLeft = Drawing.prototype._onClickLeft;
  Drawing.prototype._onClickLeft = function (event) {
    // Only intercept when Travel Mode is off and we're not mid-animation
    if (!TravelMode.active && TravelMode.isIdle) {
      const points = this.document.getFlag("mapcrawler", "points");
      if (points) {
        TravelMode.replayAnimation(points);
        return;   // suppress normal select behaviour for mapcrawler drawings
      }
    }
    return _onClickLeft.call(this, event);
  };
}

// Inject the Travel Mode toggle button into the Drawing tools panel
Hooks.on("getSceneControlButtons", (controls) => {
  registerControls(controls);
});

// Add "Replay Travel Path" to the right-click context menu on Drawings
Hooks.on("getDrawingEntryContext", (html, options) => {
  options.push({
    name:      "MAPCRAWLER.ReplayPath",
    icon:      '<i class="fas fa-play"></i>',
    condition: (li) => {
      const doc = canvas.drawings.get(li.data("documentId"));
      return !!doc?.getFlag("mapcrawler", "points");
    },
    callback: (li) => {
      const doc    = canvas.drawings.get(li.data("documentId"));
      const points = doc.getFlag("mapcrawler", "points");
      TravelMode.replayAnimation(points);
    },
  });
});
