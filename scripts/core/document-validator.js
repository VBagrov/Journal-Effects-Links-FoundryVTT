import {
  DOCUMENT_TYPES,
  INSTANCE_STATUS,
  MODULE_ID,
  RECIPIENT_STATUS
} from "../constants.js";

export function getManagedFlags(document) {
  return document?.flags?.[MODULE_ID] ?? null;
}

export async function resolveActor(uuid) {
  if (!uuid) return null;
  try {
    const document = await fromUuid(uuid);
    return document?.documentName === "Actor" ? document : null;
  } catch {
    return null;
  }
}

export function resolveActorSync(uuid) {
  if (!uuid || typeof fromUuidSync !== "function") return null;
  try {
    const document = fromUuidSync(uuid);
    return document?.documentName === "Actor" ? document : null;
  } catch {
    return null;
  }
}

export function getEmbeddedDocument(actor, record) {
  if (!actor || !record?.documentId) return null;
  const collection = record.documentType === DOCUMENT_TYPES.EFFECT ? actor.effects : actor.items;
  return collection?.get?.(record.documentId) ?? null;
}

/**
 * Positive ownership verification. Any mismatch means the document must not be
 * deleted or overwritten by the module.
 */
export function verifyInstance(actor, record, { setId, grantId, templateObjectId } = {}) {
  if (!record) return { ok: false, reason: "no-record" };
  if (!actor) return { ok: false, reason: "missing-actor" };
  if (!record.documentId) return { ok: false, reason: "no-document" };

  const document = getEmbeddedDocument(actor, record);
  if (!document) return { ok: false, reason: "no-document" };
  if (record.documentUuid && document.uuid !== record.documentUuid) {
    return { ok: false, reason: "uuid-mismatch", document };
  }

  const flags = getManagedFlags(document);
  if (!flags?.managed) return { ok: false, reason: "not-managed", document };
  if (flags.setId !== setId
    || flags.grantId !== grantId
    || flags.templateObjectId !== templateObjectId) {
    return { ok: false, reason: "flag-mismatch", document };
  }
  if (record.instanceId && flags.instanceId !== record.instanceId) {
    return { ok: false, reason: "instance-mismatch", document };
  }
  return { ok: true, document };
}

export function isSafeConflict(reason) {
  return reason === "not-managed"
    || reason === "flag-mismatch"
    || reason === "instance-mismatch"
    || reason === "uuid-mismatch";
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Look for a document already present on the actor that matches the template.
 * This is only used to avoid creating duplicates: matched documents are never
 * adopted, flagged, modified or deleted by the module.
 */
export function findEquivalentDocument(actor, templateObject) {
  if (!actor || !templateObject) return null;
  const name = normalizeName(templateObject.name);
  if (!name) return null;
  const type = templateObject.documentType === DOCUMENT_TYPES.EFFECT ? null : templateObject.type;
  const matches = document =>
    normalizeName(document.name) === name
    && (!type || document.type === type);
  if (templateObject.documentType === DOCUMENT_TYPES.EFFECT) {
    return actor.effects?.contents?.find(matches) ?? null;
  }
  return actor.items?.contents?.find(matches) ?? null;
}

/**
 * Live state of one recipient, derived from the documents currently on the
 * actor. The stored registry status is only used when nothing is granted yet.
 */
export function evaluateRecipient(actor, record, { setId, grantId, objects } = {}) {
  if (!record) return null;
  const templateObjects = Array.isArray(objects) ? objects : null;
  const total = templateObjects
    ? templateObjects.length
    : Object.keys(record.objects ?? {}).length;

  if (!actor) {
    const problems = Object.values(record.objects ?? {})
      .filter(instance => instance?.status !== INSTANCE_STATUS.REVOKED
        && instance?.status !== INSTANCE_STATUS.SKIPPED).length;
    return { status: RECIPIENT_STATUS.MISSING_ACTOR, granted: 0, problems, total };
  }

  const entries = templateObjects
    ? templateObjects
      .map(object => [object.id, record.objects?.[object.id]])
      .filter(([, instance]) => instance)
    : Object.entries(record.objects ?? {});

  let granted = 0;
  let problems = 0;
  for (const [objectId, instance] of entries) {
    if (instance.status === INSTANCE_STATUS.REVOKED) continue;
    if (instance.status === INSTANCE_STATUS.SKIPPED) continue;
    const check = verifyInstance(actor, instance, { setId, grantId, templateObjectId: objectId });
    if (check.ok) granted += 1;
    else problems += 1;
  }

  let status = record.status;
  if (granted + problems > 0) {
    if (problems === 0) status = RECIPIENT_STATUS.ACTIVE;
    else status = granted > 0 ? RECIPIENT_STATUS.PARTIAL : RECIPIENT_STATUS.FAILED;
  }
  return { status, granted, problems, total };
}

export function collectManagedDocuments(actor) {
  const results = [];
  for (const item of actor.items.contents) {
    if (getManagedFlags(item)?.managed) {
      results.push({ actor, document: item, flags: getManagedFlags(item) });
    }
    for (const effect of item.effects.contents) {
      if (getManagedFlags(effect)?.managed) {
        results.push({ actor, document: effect, flags: getManagedFlags(effect) });
      }
    }
  }
  for (const effect of actor.effects.contents) {
    if (getManagedFlags(effect)?.managed) {
      results.push({ actor, document: effect, flags: getManagedFlags(effect) });
    }
  }
  return results;
}
