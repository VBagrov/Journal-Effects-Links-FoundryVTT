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
 * Resolve a dropped Actor. Recipients are added by dropping an Actor document
 * from the Actors sidebar or an Actor directory entry.
 */
export async function resolveDroppedActor(event) {
  const data = getDragEventData(event);
  const uuid = data?.uuid;
  if (!uuid) return null;
  if (data.type && data.type !== "Actor") return null;
  try {
    const document = await fromUuid(uuid);
    return document?.documentName === "Actor" ? document : null;
  } catch {
    return null;
  }
}

async function resolveTemplateFromUuid(uuid) {
  let document;
  try {
    document = await fromUuid(uuid);
  } catch {
    document = null;
  }
  if (!document) return { unsupported: "unknown" };

  if (document.documentName === "ActiveEffect" && document.parent?.documentName === "Item") {
    return { object: buildTemplateObject(document.parent), convertedFromEffect: true };
  }
  if (document.documentName === "Item" || document.documentName === "ActiveEffect") {
    return { object: buildTemplateObject(document), convertedFromEffect: false };
  }
  return { unsupported: document.documentName };
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
  const result = await resolveTemplateFromUuid(uuid);
  if (result?.unsupported === "unknown") return { unsupported: data?.type ?? "unknown" };
  return result;
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

/**
 * Import an Item or Active Effect from the world or a compendium by UUID.
 */
export async function importTemplateDocument(uuid) {
  try {
    const result = await resolveTemplateFromUuid(uuid);
    if (!result || result.unsupported) {
      notifyWarn(game.i18n.format("JELI.Error.UnsupportedDocument", {
        type: result?.unsupported ?? "unknown"
      }));
      return null;
    }
    return result;
  } catch {
    notifyWarn(game.i18n.localize("JELI.Error.UnsupportedDocumentGeneric"));
    return null;
  }
}
