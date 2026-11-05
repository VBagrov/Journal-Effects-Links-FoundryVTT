import { DOCUMENT_TYPES, MODULE_ID } from "../constants.js";
import { createObjectId } from "./uuid.js";

export function stripManagedFlags(data) {
  if (data?.flags && typeof data.flags === "object") delete data.flags[MODULE_ID];
  return data;
}

function cleanEmbeddedSource(source) {
  delete source._id;
  delete source._stats;
  delete source.ownership;
  stripManagedFlags(source);
  return source;
}

/**
 * Clone a document's complete source data without any identity or ownership
 * information that must not be reused by a newly created embedded document.
 */
export function cleanDocumentSource(document) {
  const source = document.toObject();
  delete source._id;
  delete source._stats;
  delete source.folder;
  delete source.ownership;
  delete source.sort;
  stripManagedFlags(source);
  if (Array.isArray(source.effects)) {
    source.effects = source.effects.map(effect => cleanEmbeddedSource(effect));
  }
  return source;
}

export function buildTemplateObject(document) {
  const documentType = document.documentName === "ActiveEffect"
    ? DOCUMENT_TYPES.EFFECT
    : DOCUMENT_TYPES.ITEM;
  const now = Date.now();
  return {
    id: createObjectId(),
    documentType,
    name: document.name ?? "",
    img: document.img ?? "",
    type: document.type ?? "",
    sourceUuid: document.uuid ?? null,
    source: cleanDocumentSource(document),
    createdAt: now,
    updatedAt: now
  };
}

export function cloneTemplateObject(templateObject) {
  const copy = foundry.utils.deepClone(templateObject);
  copy.id = createObjectId();
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  return copy;
}

export function cleanInstanceSource(source) {
  const data = foundry.utils.deepClone(source ?? {});
  delete data._id;
  delete data._stats;
  delete data.folder;
  delete data.ownership;
  delete data.sort;
  stripManagedFlags(data);
  if (Array.isArray(data.effects)) {
    data.effects = data.effects.map(effect => cleanEmbeddedSource(effect));
  }
  return data;
}
