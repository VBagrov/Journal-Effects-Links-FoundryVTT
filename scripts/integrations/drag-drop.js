import { buildTemplateObject } from "../utils/serialization.js";
import { notifyWarn } from "../utils/logger.js";

export function getDragEventData(event) {
  const TextEditor = foundry.applications?.ux?.TextEditor;
  if (typeof TextEditor?.getDragEventData === "function") {
    try {
      return TextEditor.getDragEventData(event);
    } catch {
      // fall back to raw data transfer parsing
    }
  }
  try {
    return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "null");
  } catch {
    return null;
  }
}

/**
 * Resolve a dropped document into a template object. An Active Effect that is
 * embedded in an Item is imported as the complete Item so its effects are not
 * extracted from their parent.
 */
export async function resolveDroppedTemplateObject(event) {
  const data = getDragEventData(event);
  const uuid = data?.uuid;
  if (!uuid) return null;

  let document;
  try {
    document = await fromUuid(uuid);
  } catch {
    document = null;
  }
  if (!document) return { unsupported: data?.type ?? "unknown" };

  if (document.documentName === "ActiveEffect" && document.parent?.documentName === "Item") {
    return { object: buildTemplateObject(document.parent), convertedFromEffect: true };
  }
  if (document.documentName === "Item" || document.documentName === "ActiveEffect") {
    return { object: buildTemplateObject(document), convertedFromEffect: false };
  }
  return { unsupported: document.documentName };
}

export function bindDropTarget(html, handler) {
  const DragDropClass = foundry.applications?.ux?.DragDrop;
  if (!DragDropClass) return null;
  const dragDrop = new DragDropClass({
    dragSelector: null,
    dropSelector: "[data-jeli-drop]",
    permissions: {
      drop: () => game.user.isGM
    },
    callbacks: {
      drop: event => handler(event)
    }
  });
  dragDrop.bind(html);
  return dragDrop;
}

export async function importWorldItem(uuid) {
  try {
    const document = await fromUuid(uuid);
    if (!document || document.documentName !== "Item") {
      notifyWarn(game.i18n.format("JELI.Error.UnsupportedDocument", {
        type: document?.documentName ?? "unknown"
      }));
      return null;
    }
    return buildTemplateObject(document);
  } catch {
    notifyWarn(game.i18n.localize("JELI.Error.UnsupportedDocumentGeneric"));
    return null;
  }
}
