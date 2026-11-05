import { INSTANCE_STATUS, RECIPIENT_STATUS } from "../constants.js";
import { collectManagedDocuments } from "./document-validator.js";
import {
  addHistory,
  createRecipientRecord,
  ensureSetRegistry,
  recomputeGrantStatus,
  recomputeRecipientStatus
} from "./grant-registry.js";
import { migrateRegistry } from "../utils/migration.js";
import { createInstanceId } from "../utils/uuid.js";

function indexKnownDocuments(registry) {
  const known = new Set();
  for (const entry of Object.values(registry?.sets ?? {})) {
    for (const grant of Object.values(entry.generations ?? {})) {
      for (const record of Object.values(grant.recipients ?? {})) {
        for (const instance of Object.values(record.objects ?? {})) {
          if (instance?.documentUuid) known.add(instance.documentUuid);
        }
      }
    }
  }
  return known;
}

/**
 * Compare the registry with module flags found on world documents. Only
 * documents carrying a complete managed flag set are considered.
 */
export function buildRepairPlan(registry) {
  const known = indexKnownDocuments(registry);
  const recovered = [];

  for (const actor of game.actors.contents) {
    for (const { document, flags } of collectManagedDocuments(actor)) {
      if (!flags?.setId || !flags?.grantId || !flags?.templateObjectId) continue;
      if (known.has(document.uuid)) continue;
      recovered.push({
        actorUuid: actor.uuid,
        actorName: actor.name,
        documentType: document.documentName,
        documentId: document.id,
        documentUuid: document.uuid,
        documentName: document.name,
        setId: flags.setId,
        grantId: flags.grantId,
        templateObjectId: flags.templateObjectId,
        instanceId: flags.instanceId || createInstanceId()
      });
    }
  }
  return { recovered };
}

export function applyRepairPlan(registry, plan) {
  const target = registry ?? migrateRegistry({});
  if (!target) return 0;
  const now = Date.now();
  let count = 0;

  for (const item of plan.recovered) {
    const entry = ensureSetRegistry(target, item.setId);
    let grant = entry.generations[item.grantId];
    if (!grant) {
      grant = {
        grantId: item.grantId,
        setId: item.setId,
        status: "partial",
        createdAt: now,
        createdBy: { id: null, name: "recovery" },
        activatedAt: now,
        lastSyncAt: null,
        lastSync: null,
        recipients: {},
        revokedRecipients: {},
        revokedAt: null,
        revokedBy: null
      };
      entry.generations[item.grantId] = grant;
      if (!entry.activeGrantId) entry.activeGrantId = item.grantId;
    }

    const recipient = grant.recipients[item.actorUuid]
      ?? createRecipientRecord(item.actorUuid, { name: item.actorName });
    grant.recipients[item.actorUuid] = recipient;
    recipient.actorName = item.actorName;
    if (recipient.status === RECIPIENT_STATUS.REVOKED) {
      recipient.status = RECIPIENT_STATUS.ACTIVE;
    }

    recipient.objects[item.templateObjectId] = {
      instanceId: item.instanceId,
      name: item.documentName,
      documentType: item.documentType,
      documentId: item.documentId,
      documentUuid: item.documentUuid,
      status: INSTANCE_STATUS.GRANTED,
      grantedAt: now,
      updatedAt: now,
      error: null,
      recovered: true
    };
    recomputeRecipientStatus(recipient);
    recomputeGrantStatus(grant);
    count += 1;
  }

  if (count > 0) {
    addHistory(target, {
      operation: "repair",
      result: "success",
      message: "",
      summary: { recovered: count }
    });
  }
  return count;
}
