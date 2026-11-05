import { itemTypeLabel } from "../utils/display.js";

export function getSystemInfo() {
  return {
    id: game.system?.id ?? "",
    version: game.system?.version ?? game.system?.data?.version ?? "",
    isDnD5e: game.system?.id === "dnd5e"
  };
}

export function isSupportedDocument(document) {
  return document?.documentName === "Item" || document?.documentName === "ActiveEffect";
}

export function getDocumentTypeLabel(document) {
  if (document?.documentName === "ActiveEffect") return itemTypeLabel(document.type, "ActiveEffect");
  return itemTypeLabel(document?.type, document?.documentName);
}
