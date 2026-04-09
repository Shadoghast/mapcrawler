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
