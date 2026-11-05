import {
  DEFAULT_SYNC_MODE,
  DOCUMENT_TYPES,
  GRANT_STATUS,
  INSTANCE_STATUS,
  RECIPIENT_STATUS,
  SCHEMA_VERSION
} from "../constants.js";
import { createSetId } from "./uuid.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function migrateTemplateObject(raw) {
  if (!isPlainObject(raw)) return null;
  const object = foundry.utils.deepClone(raw);
  object.schemaVersion ??= SCHEMA_VERSION;
  object.documentType = object.documentType === DOCUMENT_TYPES.EFFECT
    ? DOCUMENT_TYPES.EFFECT
    : DOCUMENT_TYPES.ITEM;
  object.source = isPlainObject(object.source) ? object.source : {};
  object.name ??= object.source.name ?? "";
  object.img ??= object.source.img ?? "";
  object.type ??= object.source.type ?? "";
  return object;
}

export function migrateSet(raw) {
  if (!isPlainObject(raw)) return null;
  const set = foundry.utils.deepClone(raw);
  set.schemaVersion ??= SCHEMA_VERSION;
  set.id ||= createSetId();
  set.name = String(set.name ?? "");
  set.description = String(set.description ?? "");
  set.img = String(set.img ?? "");
  set.objects = Array.isArray(set.objects)
    ? set.objects.map(migrateTemplateObject).filter(Boolean)
    : [];
  set.recipients = Array.isArray(set.recipients)
    ? [...new Set(set.recipients.filter(value => typeof value === "string"))]
    : [];
  set.distribution = isPlainObject(set.distribution)
    ? { mode: set.distribution.mode ?? DEFAULT_SYNC_MODE }
    : { mode: DEFAULT_SYNC_MODE };
  set.createdAt ??= Date.now();
  set.updatedAt ??= set.createdAt;
  set.lastActivatedAt ??= null;
  set.lastSyncedAt ??= null;
  set.journalLink ??= null;
  return set;
}

function migrateInstanceRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const record = foundry.utils.deepClone(raw);
  record.instanceId ??= null;
  record.documentType = record.documentType === DOCUMENT_TYPES.EFFECT
    ? DOCUMENT_TYPES.EFFECT
    : DOCUMENT_TYPES.ITEM;
  record.documentId ??= null;
  record.documentUuid ??= null;
  record.status ??= "missing";
  record.grantedAt ??= null;
  record.updatedAt ??= record.grantedAt;
  return record;
}

function isActorUuid(value) {
  return typeof value === "string" && value.startsWith("Actor.");
}

// Repair recipient maps split on dots by Document#update ({ Actor: { id } }).
function flattenRecipientMap(raw, depth = 0) {
  const result = {};
  if (!isPlainObject(raw) || depth > 4) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    if (isActorUuid(value.actorUuid) && isPlainObject(value.objects)) {
      result[value.actorUuid] = mergeRecipientSources(result[value.actorUuid], value);
      continue;
    }
    if (isActorUuid(key) && isPlainObject(value.objects)) {
      result[key] = mergeRecipientSources(result[key], value);
      continue;
    }
    const nested = flattenRecipientMap(value, depth + 1);
    for (const [uuid, record] of Object.entries(nested)) {
      result[uuid] = mergeRecipientSources(result[uuid], record);
    }
  }
  return result;
}

function mergeRecipientSources(base, incoming) {
  if (!base) return { ...incoming };
  return {
    ...base,
    ...incoming,
    objects: { ...(base.objects ?? {}), ...(incoming.objects ?? {}) }
  };
}

function hasNestedRecipients(raw) {
  if (!isPlainObject(raw)) return false;
  return Object.entries(raw).some(([key, value]) => {
    if (!isPlainObject(value)) return false;
    if (isActorUuid(value.actorUuid) && isPlainObject(value.objects)) return false;
    if (isActorUuid(key) && isPlainObject(value.objects)) return false;
    return true;
  });
}

function migrateRecipientMap(raw) {
  const result = {};
  for (const [actorUuid, source] of Object.entries(flattenRecipientMap(raw))) {
    const record = migrateRecipientRecord(source, actorUuid);
    if (record) result[actorUuid] = record;
  }
  return result;
}

function migrateRecipientRecord(raw, actorUuid) {
  if (!isPlainObject(raw)) return null;
  const record = foundry.utils.deepClone(raw);
  record.actorUuid ??= actorUuid;
  record.actorName ??= "";
  record.status ??= "active";
  record.addedAt ??= Date.now();
  record.updatedAt ??= record.addedAt;
  record.error ??= null;
  record.objects = isPlainObject(record.objects) ? record.objects : {};
  for (const [objectId, instance] of Object.entries(record.objects)) {
    record.objects[objectId] = migrateInstanceRecord(instance);
  }
  return record;
}

function migrateGrant(raw, setId, grantId) {
  if (!isPlainObject(raw)) return null;
  const grant = foundry.utils.deepClone(raw);
  grant.grantId ??= grantId;
  grant.setId ??= setId;
  grant.status ??= "active";
  grant.createdAt ??= Date.now();
  grant.activatedAt ??= grant.createdAt;
  grant.lastSyncAt ??= null;
  grant.lastSync ??= null;
  grant.recipients = migrateRecipientMap(grant.recipients);
  grant.revokedRecipients = migrateRecipientMap(grant.revokedRecipients);
  return grant;
}

function hasLiveInstances(grant) {
  return Object.values(grant?.recipients ?? {}).some(record =>
    record?.status !== RECIPIENT_STATUS.REVOKED
    && Object.values(record?.objects ?? {}).some(instance =>
      instance?.status !== INSTANCE_STATUS.REVOKED
      && instance?.status !== INSTANCE_STATUS.SKIPPED
    )
  );
}

function hasProblematicRecipients(grant) {
  return Object.values(grant?.recipients ?? {}).some(record =>
    record?.status === RECIPIENT_STATUS.FAILED
    || record?.status === RECIPIENT_STATUS.PARTIAL
    || record?.status === RECIPIENT_STATUS.MISSING_ACTOR
    || Object.values(record?.objects ?? {}).some(instance =>
      instance?.status === INSTANCE_STATUS.FAILED
      || instance?.status === INSTANCE_STATUS.CONFLICT
      || instance?.status === INSTANCE_STATUS.MISSING
    )
  );
}

// Undo the phantom-recipient revoke so its remaining documents can be removed.
function restoreActiveGrant(entry) {
  const active = entry.activeGrantId ? entry.generations?.[entry.activeGrantId] : null;
  if (active && active.status !== GRANT_STATUS.REVOKED) return;
  const candidates = Object.values(entry.generations ?? {})
    .filter(grant => grant?.status === GRANT_STATUS.REVOKED && hasLiveInstances(grant))
    .sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0));
  if (!candidates.length) return;
  const grant = candidates[0];
  grant.status = hasProblematicRecipients(grant) ? GRANT_STATUS.PARTIAL : GRANT_STATUS.ACTIVE;
  grant.revokedAt = null;
  grant.revokedBy = null;
  entry.activeGrantId = grant.grantId;
}

function migrateSetRegistry(raw, setId) {
  if (!isPlainObject(raw)) return null;
  const entry = foundry.utils.deepClone(raw);
  entry.setId ??= setId;
  entry.activeGrantId ??= null;
  entry.orphanedAt ??= null;
  entry.updatedAt ??= 0;
  entry.generations = isPlainObject(entry.generations) ? entry.generations : {};
  const repaired = Object.values(entry.generations)
    .some(grant => hasNestedRecipients(grant?.recipients));
  for (const [grantId, grant] of Object.entries(entry.generations)) {
    entry.generations[grantId] = migrateGrant(grant, setId, grantId);
  }
  if (repaired) restoreActiveGrant(entry);
  return entry;
}

/**
 * Validate and upgrade the persisted registry. Returns null when the stored
 * value is structurally unusable, which disables every destructive operation.
 */
export function migrateRegistry(raw) {
  if (!isPlainObject(raw)) return null;
  const registry = foundry.utils.deepClone(raw);
  registry.schemaVersion ??= SCHEMA_VERSION;
  if (!isPlainObject(registry.sets)) {
    if (registry.sets === undefined) registry.sets = {};
    else return null;
  }
  if (!isPlainObject(registry.locks)) registry.locks = {};
  if (!Array.isArray(registry.history)) registry.history = [];
  if (typeof registry.updatedAt !== "number") registry.updatedAt = 0;
  for (const [setId, entry] of Object.entries(registry.sets)) {
    registry.sets[setId] = migrateSetRegistry(entry, setId);
  }
  return registry;
}

export function migrateHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null;
  return { ...foundry.utils.deepClone(raw) };
}
