import { TravelMode } from "../travel-mode.mjs";

export function registerControls(controls) {
  // Find the "drawings" control group — always by name, never by index
  const drawingControls = controls.find(c => c.name === "drawings");
  if (!drawingControls) return;

  drawingControls.tools.push({
    name:    "travel-mode",
    title:   "MAPCRAWLER.TravelMode",
    icon:    "fas fa-route",
    toggle:  true,
    active:  TravelMode.active,
    onClick: (toggled) => TravelMode.setActive(toggled),
  });
}
