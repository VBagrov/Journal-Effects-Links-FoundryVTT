import { LINK_RE } from "../constants.js";
import { setManager } from "../core/services.js";
import { isGM } from "../core/permissions.js";
import { notifyWarn } from "../utils/logger.js";
import { openSetManagement } from "../applications/set-management.js";

let registered = false;
let clickBound = false;

function hasSet(setId) {
  if (!isGM() || !setManager.initialized) return null;
  return setManager.getSet(setId);
}

function buildLink(setId, label) {
  const known = hasSet(setId);
  const anchor = document.createElement("a");
  anchor.className = "jeli-effect-link";
  anchor.dataset.jeliEffectLink = setId;
  // No href: Foundry opens any a[href] in a new tab.
  anchor.setAttribute("role", "button");
  anchor.tabIndex = 0;
  anchor.title = game.i18n.format("JELI.Link.Tooltip", { id: setId });

  let text = label;
  if (!text) text = known?.name ?? game.i18n.localize("JELI.Link.DefaultLabel");
  anchor.textContent = text;

  if (isGM() && setManager.initialized && !known) {
    anchor.classList.add("missing");
    anchor.title = game.i18n.format("JELI.Link.MissingSet", { id: setId });
  }
  return anchor;
}

export function registerEffectLinkEnricher() {
  if (registered) return;
  const enrichers = CONFIG.TextEditor?.enrichers;
  if (!Array.isArray(enrichers)) return;
  const pattern = new RegExp(LINK_RE.source, "g");
  enrichers.push({
    pattern,
    enricher: match => buildLink(match[1], match[2]?.trim() ?? "")
  });
  registered = true;
}

function handleLinkActivation(event) {
  const target = event.target?.closest?.("a.jeli-effect-link");
  if (!target) return;
  // Capture phase so Foundry's hyperlink handler never opens a browser tab.
  event.preventDefault();
  event.stopPropagation();
  const setId = target.dataset.jeliEffectLink;
  if (!setId) return;
  if (!isGM()) {
    notifyWarn(game.i18n.localize("JELI.Link.PlayerDenied"));
    return;
  }
  void openSetManagement(setId);
}

export function registerEffectLinkClickHandler() {
  if (clickBound) return;
  document.addEventListener("click", handleLinkActivation, { capture: true });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    handleLinkActivation(event);
  }, { capture: true });
  clickBound = true;
}
