import { TravelMode } from "../travel-mode.mjs";

export function registerControls(controls) {
  // v13+: controls is a plain object keyed by group name
  // v12:  controls is an array — handle both defensively
  const drawingControls = Array.isArray(controls)
    ? controls.find(c => c.name === "drawings")
    : controls.drawings;

  if (!drawingControls) return;

  const tool = {
    name:    "travel-mode",
    title:   "MAPCRAWLER.TravelMode",
    icon:    "fas fa-route",
    toggle:  true,
    active:  TravelMode.active,
    onClick: (toggled) => TravelMode.setActive(toggled),
  };

  // v13+: tools is a plain object keyed by tool name
  // v12:  tools is an array
  if (Array.isArray(drawingControls.tools)) {
    drawingControls.tools.push(tool);
  } else {
    drawingControls.tools[tool.name] = tool;
  }
}
