import { DOCUMENT_TYPES, MODULE_ID } from "../constants.js";
import { cleanInstanceSource } from "../utils/serialization.js";

export function buildManagedFlags({ setId, grantId, templateObjectId, instanceId }) {
  return {
    managed: true,
    setId,
    grantId,
    templateObjectId,
    instanceId
  };
}

export function buildInstanceData(templateObject, ids) {
  const data = cleanInstanceSource(templateObject.source);
  data.flags ??= {};
  data.flags[MODULE_ID] = buildManagedFlags({
    ...ids,
    templateObjectId: templateObject.id
  });
  return data;
}

export async function createInstance(actor, templateObject, ids) {
  const data = buildInstanceData(templateObject, ids);
  const documentType = templateObject.documentType === DOCUMENT_TYPES.EFFECT
    ? DOCUMENT_TYPES.EFFECT
    : DOCUMENT_TYPES.ITEM;
  const created = await actor.createEmbeddedDocuments(documentType, [data]);
  const document = created?.[0] ?? null;
  if (!document) throw new Error(game.i18n.format("JELI.Error.CreationFailed", { name: templateObject.name }));
  return document;
}

/**
 * Replace a managed instance with its template data. This is only called for
 * documents already verified as module-owned instances of this grant.
 */
export async function updateInstance(document, templateObject, ids) {
  const data = buildInstanceData(templateObject, ids);
  const sourceEffects = Array.isArray(data.effects) ? data.effects : [];
  delete data.effects;

  await document.update(data);

  if (templateObject.documentType === DOCUMENT_TYPES.ITEM && document.documentName === "Item") {
    const existingEffects = document.effects.contents.map(effect => effect.id);
    if (existingEffects.length) {
      await document.deleteEmbeddedDocuments("ActiveEffect", existingEffects);
    }
    if (sourceEffects.length) {
      await document.createEmbeddedDocuments("ActiveEffect", sourceEffects);
    }
  }
  return document;
}
