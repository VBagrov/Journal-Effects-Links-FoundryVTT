import {
  GRANT_STATUS,
  INSTANCE_STATUS,
  MAX_HISTORY,
  RECIPIENT_STATUS,
  SCHEMA_VERSION,
  SET_STATUS
} from "../constants.js";
import { createGrantId } from "../utils/uuid.js";

export function createEmptyRegistry() {
  return {
    schemaVersion: SCHEMA_VERSION,
    sets: {},
    locks: {},
    history: [],
    updatedAt: 0
  };
}

export function getSetRegistry(registry, setId) {
  return registry?.sets?.[setId] ?? null;
}

export function getGrant(registry, setId, grantId) {
  if (!grantId) return null;
  return registry?.sets?.[setId]?.generations?.[grantId] ?? null;
}

export function getActiveGrant(registry, setId) {
  const entry = getSetRegistry(registry, setId);
  if (!entry?.activeGrantId) return null;
  const grant = entry.generations?.[entry.activeGrantId];
  if (!grant || grant.status === GRANT_STATUS.REVOKED) return null;
  return grant;
}

export function getLatestGrant(registry, setId) {
  const entry = getSetRegistry(registry, setId);
  if (!entry) return null;
  if (entry.activeGrantId && entry.generations?.[entry.activeGrantId]) {
    return entry.generations[entry.activeGrantId];
  }
  const generations = Object.values(entry.generations ?? {});
  generations.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return generations[0] ?? null;
}

export function ensureSetRegistry(registry, setId) {
  let entry = registry.sets[setId];
  if (!entry) {
    entry = {
      setId,
      activeGrantId: null,
      generations: {},
      orphanedAt: null,
      updatedAt: Date.now()
    };
    registry.sets[setId] = entry;
  }
  entry.generations ??= {};
  return entry;
}

export function createGrant(setId, user = game.user) {
  const now = Date.now();
  return {
    grantId: createGrantId(),
    setId,
    status: GRANT_STATUS.ACTIVE,
    createdAt: now,
    createdBy: { id: user?.id ?? null, name: user?.name ?? "" },
    activatedAt: now,
    lastSyncAt: null,
    lastSync: null,
    recipients: {},
    revokedRecipients: {},
    revokedAt: null,
    revokedBy: null
  };
}

export function ensureActiveGrant(registry, setId, user = game.user) {
  const entry = ensureSetRegistry(registry, setId);
  let grant = getActiveGrant(registry, setId);
  let created = false;
  if (!grant) {
    grant = createGrant(setId, user);
    entry.generations[grant.grantId] = grant;
    entry.activeGrantId = grant.grantId;
    created = true;
  }
  return { entry, grant, created };
}

export function createRecipientRecord(actorUuid, actor = null) {
  const now = Date.now();
  return {
    actorUuid,
    actorName: actor?.name ?? "",
    status: RECIPIENT_STATUS.ACTIVE,
    objects: {},
    addedAt: now,
    updatedAt: now,
    error: null
  };
}

export function archiveRevokedRecipient(grant, actorUuid) {
  const record = grant.recipients?.[actorUuid];
  if (!record) return null;
  grant.revokedRecipients ??= {};
  const archived = foundry.utils.deepClone(record);
  grant.revokedRecipients[actorUuid] = archived;
  delete grant.recipients[actorUuid];
  return archived;
}

export function recomputeRecipientStatus(record) {
  if (!record) return;
  if (record.status === RECIPIENT_STATUS.REVOKED) return;
  if (record.status === RECIPIENT_STATUS.MISSING_ACTOR) return;

  const objects = Object.values(record.objects ?? {});
  if (!objects.length) {
    record.status = RECIPIENT_STATUS.ACTIVE;
    return;
  }
  const failed = objects.some(record =>
    record.status === INSTANCE_STATUS.FAILED
    || record.status === INSTANCE_STATUS.CONFLICT
  );
  const missing = objects.some(record => record.status === INSTANCE_STATUS.MISSING);
  const granted = objects.some(record => record.status === INSTANCE_STATUS.GRANTED);

  if (failed) record.status = RECIPIENT_STATUS.FAILED;
  else if (missing) record.status = granted ? RECIPIENT_STATUS.PARTIAL : RECIPIENT_STATUS.FAILED;
  else if (granted || objects.every(record =>
    record.status === INSTANCE_STATUS.REVOKED || record.status === INSTANCE_STATUS.SKIPPED
  )) {
    record.status = RECIPIENT_STATUS.ACTIVE;
  } else record.status = RECIPIENT_STATUS.PARTIAL;
}

export function recomputeGrantStatus(grant) {
  if (!grant || grant.status === GRANT_STATUS.REVOKED) return;
  const records = Object.values(grant.recipients ?? {})
    .filter(record => record.status !== RECIPIENT_STATUS.REVOKED);
  if (!records.length) {
    grant.status = GRANT_STATUS.REVOKED;
    return;
  }
  const problematic = records.some(record =>
    record.status === RECIPIENT_STATUS.FAILED
    || record.status === RECIPIENT_STATUS.PARTIAL
    || record.status === RECIPIENT_STATUS.MISSING_ACTOR
  );
  grant.status = problematic ? GRANT_STATUS.PARTIAL : GRANT_STATUS.ACTIVE;
}

export function deriveSetStatus(set, registry) {
  const entry = getSetRegistry(registry, set?.id);
  if (!entry) return SET_STATUS.DRAFT;
  const grant = entry.activeGrantId ? entry.generations?.[entry.activeGrantId] : null;
  if (!grant) {
    return Object.keys(entry.generations ?? {}).length ? SET_STATUS.REVOKED : SET_STATUS.DRAFT;
  }
  if (grant.status === GRANT_STATUS.REVOKED) return SET_STATUS.REVOKED;
  if (grant.status === GRANT_STATUS.ERROR) return SET_STATUS.ERROR;
  if (grant.status === GRANT_STATUS.PARTIAL) return SET_STATUS.PARTIAL;
  return SET_STATUS.ACTIVE;
}

export function addHistory(registry, entry) {
  registry.history ??= [];
  const record = {
    id: foundry.utils.randomID(12),
    ts: Date.now(),
    userId: game.user?.id ?? null,
    userName: game.user?.name ?? "",
    setId: null,
    setName: "",
    grantId: null,
    actorUuid: null,
    objectId: null,
    operation: "unknown",
    result: "success",
    message: "",
    ...entry
  };
  registry.history.unshift(record);
  if (registry.history.length > MAX_HISTORY) registry.history.length = MAX_HISTORY;
  return record;
}

export function countGrantedForRecipient(recipientRecord) {
  return Object.values(recipientRecord?.objects ?? {})
    .filter(record => record?.status === INSTANCE_STATUS.GRANTED).length;
}

export function recipientHasActiveObjects(recipientRecord) {
  return Object.values(recipientRecord?.objects ?? {})
    .some(record => record?.status === INSTANCE_STATUS.GRANTED);
}
