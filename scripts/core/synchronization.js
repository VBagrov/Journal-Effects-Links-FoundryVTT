import {
  INSTANCE_STATUS,
  RECIPIENT_STATUS,
  SYNC_MODE
} from "../constants.js";
import { allowDuplicateCopies } from "../settings.js";
import {
  countGrantedForRecipient,
  getActiveGrant
} from "./grant-registry.js";
import { findEquivalentDocument, resolveActorSync, verifyInstance } from "./document-validator.js";

function createPlan(mode) {
  return {
    activate: false,
    mode,
    hasWork: false,
    recipientsToAdd: [],
    recipientsToRemove: [],
    objectsToAdd: [],
    objectsToRemove: [],
    objectsToUpdate: [],
    missingInstances: [],
    conflicts: [],
    missingActors: [],
    skippedExisting: [],
    perRecipient: [],
    totals: { create: 0, remove: 0, update: 0, keep: 0, skip: 0 }
  };
}

function bumpObject(map, object, amount = 1) {
  const entry = map.get(object.id);
  if (entry) {
    entry.recipientCount += amount;
    return entry;
  }
  const created = {
    objectId: object.id,
    name: object.name,
    documentType: object.documentType,
    recipientCount: amount
  };
  map.set(object.id, created);
  return created;
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function pushSkipped(plan, uuid, name, object) {
  plan.skippedExisting.push({
    actorUuid: uuid,
    actorName: name,
    objectId: object.id,
    objectName: object.name
  });
  plan.totals.skip += 1;
}

function duplicateFor(actor, object) {
  if (!actor || allowDuplicateCopies()) return null;
  return findEquivalentDocument(actor, object);
}

/**
 * Build a differential plan between the desired Effect Set configuration and
 * the currently registered grant. The plan is read-only and never mutates
 * documents or registry records.
 */
export function computePlan(set, registry, mode = SYNC_MODE.APPLY) {
  const plan = createPlan(mode);
  const grant = getActiveGrant(registry, set.id);
  const objects = Array.isArray(set.objects) ? set.objects : [];
  const objectIds = new Set(objects.map(object => object.id));
  const desiredRecipients = [...new Set(Array.isArray(set.recipients) ? set.recipients : [])];

  if (!grant) {
    plan.activate = true;
    for (const uuid of desiredRecipients) {
      const actor = resolveActorSync(uuid);
      plan.recipientsToAdd.push({ uuid, name: actor?.name ?? uuid });
      if (!actor) plan.missingActors.push({ uuid, name: uuid });
    }
    for (const object of objects) {
      let recipientCount = 0;
      for (const recipient of plan.recipientsToAdd) {
        const actor = resolveActorSync(recipient.uuid);
        if (duplicateFor(actor, object)) {
          pushSkipped(plan, recipient.uuid, recipient.name, object);
          continue;
        }
        recipientCount += 1;
      }
      if (!recipientCount) continue;
      plan.objectsToAdd.push({
        objectId: object.id,
        name: object.name,
        documentType: object.documentType,
        recipientCount
      });
      plan.totals.create += recipientCount;
    }
    plan.hasWork = plan.totals.create > 0 || plan.recipientsToAdd.length > 0;
    return plan;
  }

  const addMap = new Map();
  const removeMap = new Map();
  const updateMap = new Map();
  const recipientRows = new Map();

  const rowFor = (uuid, name, record) => {
    if (!recipientRows.has(uuid)) {
      recipientRows.set(uuid, {
        uuid,
        name,
        status: record?.status ?? RECIPIENT_STATUS.ACTIVE,
        add: [],
        remove: [],
        update: [],
        missing: [],
        conflicts: []
      });
    }
    return recipientRows.get(uuid);
  };

  for (const uuid of desiredRecipients) {
    const record = grant.recipients?.[uuid];
    const isReadd = !record || record.status === RECIPIENT_STATUS.REVOKED;
    const actor = resolveActorSync(uuid);
    const name = actor?.name ?? record?.actorName ?? uuid;

    if (isReadd) {
      plan.recipientsToAdd.push({ uuid, name });
      const row = rowFor(uuid, name, record);
      for (const object of objects) {
        if (duplicateFor(actor, object)) {
          pushSkipped(plan, uuid, name, object);
          continue;
        }
        bumpObject(addMap, object);
        plan.totals.create += 1;
        pushUnique(row.add, object.name);
      }
      if (!actor) plan.missingActors.push({ uuid, name });
      continue;
    }

    const row = rowFor(uuid, name, record);
    if (!actor) {
      plan.missingActors.push({ uuid, name });
      row.status = RECIPIENT_STATUS.MISSING_ACTOR;
      continue;
    }

    for (const object of objects) {
      const instance = record.objects?.[object.id];
      if (!instance
        || instance.status === INSTANCE_STATUS.REVOKED
        || instance.status === INSTANCE_STATUS.SKIPPED) {
        if (duplicateFor(actor, object)) {
          pushSkipped(plan, uuid, name, object);
          continue;
        }
        bumpObject(addMap, object);
        plan.totals.create += 1;
        pushUnique(row.add, object.name);
        continue;
      }
      const check = verifyInstance(actor, instance, {
        setId: set.id,
        grantId: grant.grantId,
        templateObjectId: object.id
      });
      if (check.ok) {
        plan.totals.keep += 1;
        if (mode === SYNC_MODE.FULL) {
          bumpObject(updateMap, object);
          plan.totals.update += 1;
          pushUnique(row.update, object.name);
        }
        continue;
      }
      if (check.reason === "no-document") {
        bumpObject(addMap, object);
        plan.totals.create += 1;
        pushUnique(row.add, object.name);
        plan.missingInstances.push({
          actorUuid: uuid,
          actorName: name,
          objectId: object.id,
          objectName: object.name,
          reason: check.reason
        });
        continue;
      }
      // An existing document failed ownership verification. Never touch it.
      const conflict = {
        actorUuid: uuid,
        actorName: name,
        objectId: object.id,
        objectName: object.name,
        reason: check.reason
      };
      plan.conflicts.push(conflict);
      pushUnique(row.conflicts, object.name);
    }

    if (mode !== SYNC_MODE.ADD) {
      for (const [objectId, instance] of Object.entries(record.objects ?? {})) {
        if (objectIds.has(objectId)) continue;
        if (instance.status === INSTANCE_STATUS.REVOKED
          || instance.status === INSTANCE_STATUS.SKIPPED) continue;
        const object = {
          id: objectId,
          name: instance.name || objectId,
          documentType: instance.documentType
        };
        bumpObject(removeMap, object);
        plan.totals.remove += 1;
        pushUnique(row.remove, object.name);
      }
    }
  }

  if (mode !== SYNC_MODE.ADD) {
    for (const [uuid, record] of Object.entries(grant.recipients ?? {})) {
      if (record.status === RECIPIENT_STATUS.REVOKED) continue;
      if (desiredRecipients.includes(uuid)) continue;
      const actor = resolveActorSync(uuid);
      const name = actor?.name ?? record.actorName ?? uuid;
      plan.recipientsToRemove.push({
        uuid,
        name,
        objectCount: countGrantedForRecipient(record)
      });
      plan.totals.remove += countGrantedForRecipient(record);
      rowFor(uuid, name, record).status = RECIPIENT_STATUS.REVOKED;
    }
  }

  plan.objectsToAdd = [...addMap.values()];
  plan.objectsToRemove = [...removeMap.values()];
  plan.objectsToUpdate = [...updateMap.values()];
  plan.perRecipient = [...recipientRows.values()];
  plan.hasWork = plan.totals.create > 0
    || plan.totals.remove > 0
    || plan.totals.update > 0
    || plan.recipientsToAdd.length > 0
    || plan.recipientsToRemove.length > 0;
  return plan;
}

export function planModeLabelKey(mode) {
  switch (mode) {
    case SYNC_MODE.ADD: return "JELI.SyncMode.Add";
    case SYNC_MODE.FULL: return "JELI.SyncMode.Full";
    default: return "JELI.SyncMode.Apply";
  }
}

export function planModeHintKey(mode) {
  switch (mode) {
    case SYNC_MODE.ADD: return "JELI.SyncMode.AddHint";
    case SYNC_MODE.FULL: return "JELI.SyncMode.FullHint";
    default: return "JELI.SyncMode.ApplyHint";
  }
}
