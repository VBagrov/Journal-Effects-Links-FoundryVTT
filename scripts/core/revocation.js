import { GRANT_STATUS, INSTANCE_STATUS, RECIPIENT_STATUS } from "../constants.js";
import { createSummary } from "../utils/summary.js";
import { error as logError } from "../utils/logger.js";
import {
  addHistory,
  recomputeGrantStatus
} from "./grant-registry.js";
import {
  collectManagedDocuments,
  isSafeConflict,
  resolveActor,
  verifyInstance
} from "./document-validator.js";
import { OperationLock } from "./operation-lock.js";
import { assertGM, assertRegistryUsable } from "./permissions.js";

function reasonText(reason) {
  const key = `JELI.Reason.${reason}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : String(reason ?? "");
}

export async function revokeInstanceRecord(actor, recipientRecord, objectId, grant, setId, summary) {
  const record = recipientRecord.objects?.[objectId];
  if (!record) return { result: "no-record" };
  if (record.status === INSTANCE_STATUS.REVOKED) return { result: "already-revoked" };
  // Skipped records point at documents the module never owned, so they must
  // never be deleted or marked as failed.
  if (record.status === INSTANCE_STATUS.SKIPPED) return { result: "skipped" };

  const check = verifyInstance(actor, record, {
    setId,
    grantId: grant.grantId,
    templateObjectId: objectId
  });

  if (!check.ok) {
    if (isSafeConflict(check.reason)) {
      record.status = INSTANCE_STATUS.CONFLICT;
      record.error = check.reason;
    } else if (check.reason === "no-document") {
      record.status = INSTANCE_STATUS.MISSING;
      record.error = "missing-document";
    } else {
      record.status = INSTANCE_STATUS.FAILED;
      record.error = check.reason;
    }
    record.updatedAt = Date.now();
    summary.failed += 1;
    summary.errors.push(game.i18n.format("JELI.Summary.RevokeSkipped", {
      object: record.name || objectId,
      actor: actor?.name ?? recipientRecord.actorName ?? "",
      reason: reasonText(check.reason)
    }));
    return { result: "skipped", reason: check.reason };
  }

  try {
    await actor.deleteEmbeddedDocuments(record.documentType, [record.documentId]);
    record.status = INSTANCE_STATUS.REVOKED;
    record.error = null;
    record.revokedAt = Date.now();
    record.updatedAt = Date.now();
    summary.removed += 1;
    return { result: "revoked" };
  } catch (err) {
    logError("Failed to delete managed document", err);
    record.status = INSTANCE_STATUS.FAILED;
    record.error = err.message;
    record.updatedAt = Date.now();
    summary.failed += 1;
    summary.errors.push(game.i18n.format("JELI.Summary.DeleteFailed", {
      object: record.name || objectId,
      actor: actor?.name ?? recipientRecord.actorName ?? "",
      error: err.message
    }));
    return { result: "failed", error: err.message };
  }
}

export async function revokeAllRecipientObjects(actor, recipientRecord, grant, setId, summary) {
  for (const objectId of Object.keys(recipientRecord.objects ?? {})) {
    await revokeInstanceRecord(actor, recipientRecord, objectId, grant, setId, summary);
  }
}

function grantNeedsRevocation(grant) {
  if (!grant) return false;
  if (grant.status !== GRANT_STATUS.REVOKED) return true;
  return Object.values(grant.recipients ?? {}).some(record =>
    record.status !== RECIPIENT_STATUS.REVOKED
    && Object.values(record.objects ?? {}).some(instance =>
      instance.status !== INSTANCE_STATUS.REVOKED
      && instance.status !== INSTANCE_STATUS.SKIPPED
    )
  );
}

function collectKnownDocuments(entry) {
  const known = new Set();
  for (const grant of Object.values(entry?.generations ?? {})) {
    for (const record of Object.values(grant?.recipients ?? {})) {
      for (const instance of Object.values(record?.objects ?? {})) {
        // Skipped documents are only protected when the module never adopted them.
        if (!instance || instance.status === INSTANCE_STATUS.SKIPPED) continue;
        if (instance.documentId) known.add(`${instance.documentType}:${instance.documentId}`);
        if (instance.documentUuid) known.add(instance.documentUuid);
      }
    }
  }
  return known;
}

function collectTemplateIds(entry, set) {
  const ids = new Set();
  for (const object of set?.objects ?? []) {
    if (object?.id) ids.add(object.id);
  }
  for (const grant of Object.values(entry?.generations ?? {})) {
    for (const record of Object.values(grant?.recipients ?? {})) {
      for (const objectId of Object.keys(record?.objects ?? {})) ids.add(objectId);
    }
  }
  return ids;
}

function entryHasRecipient(entry, actorUuid) {
  return Object.values(entry?.generations ?? {}).some(grant => {
    const record = grant?.recipients?.[actorUuid];
    return record && record.status !== RECIPIENT_STATUS.REVOKED;
  });
}

// Remove flagged documents that are missing from this set's registry records.
async function sweepLeftovers(actors, setId, entry, set, summary) {
  if (!setId || !entry) return;
  const grantIds = new Set(Object.keys(entry.generations ?? {}));
  const templateIds = collectTemplateIds(entry, set);
  if (!grantIds.size || !templateIds.size) return;
  const known = collectKnownDocuments(entry);

  for (const actor of actors) {
    if (!actor) continue;
    for (const { document, flags } of collectManagedDocuments(actor)) {
      if (!flags?.managed || flags.setId !== setId) continue;
      if (!grantIds.has(flags.grantId)) continue;
      if (!templateIds.has(flags.templateObjectId)) continue;
      if (!flags.instanceId) continue;
      if (known.has(document.uuid) || known.has(`${document.documentName}:${document.id}`)) continue;
      try {
        const parent = document.parent && document.parent !== actor ? document.parent : actor;
        await parent.deleteEmbeddedDocuments(document.documentName, [document.id]);
        summary.removed += 1;
      } catch (err) {
        logError("Failed to delete leftover managed document", err);
        summary.failed += 1;
        summary.errors.push(game.i18n.format("JELI.Summary.DeleteFailed", {
          object: document.name ?? flags.templateObjectId,
          actor: actor.name ?? "",
          error: err.message
        }));
      }
    }
  }
}

export class RevocationManager {
  #manager;
  #lock;

  constructor(manager) {
    this.#manager = manager;
    this.#lock = new OperationLock(manager);
  }

  async revokeSet(set) {
    assertGM();
    if (!set?.id) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));

    return this.#lock.run(set.id, async () => {
      const registry = await this.#manager.loadRegistry();
      assertRegistryUsable(this.#manager.registryOk, this.#manager.registryMissing);
      const entry = registry.sets?.[set.id];
      const summary = createSummary();
      // Older generations can still own live documents after a registry repair.
      const grants = Object.values(entry?.generations ?? {}).filter(grantNeedsRevocation);
      if (!grants.length) return { noGrant: true, summary };

      for (const grant of grants) {
        await this.#revokeGrant(set, registry, entry, grant, summary);
      }
      await sweepLeftovers(game.actors?.contents ?? [], set.id, entry, set, summary);

      const grantId = grants.at(-1).grantId;
      addHistory(registry, {
        setId: set.id,
        setName: set.name ?? "",
        grantId,
        operation: "revoke-set",
        result: summary.failed > 0 ? "partial" : "success",
        message: "",
        summary
      });
      await this.#manager.saveRegistry(registry);
      return { noGrant: false, summary, grantId };
    });
  }

  async revokeRecipient(set, actorUuid) {
    assertGM();
    if (!set?.id) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));

    return this.#lock.run(set.id, async () => {
      const registry = await this.#manager.loadRegistry();
      assertRegistryUsable(this.#manager.registryOk, this.#manager.registryMissing);
      const entry = registry.sets?.[set.id];
      const summary = createSummary();
      if (!entry || !Object.keys(entry.generations ?? {}).length) {
        return { noGrant: true, summary };
      }
      const grants = Object.values(entry.generations).filter(grant => {
        const record = grant?.recipients?.[actorUuid];
        return record && record.status !== RECIPIENT_STATUS.REVOKED;
      });
      if (!grants.length) return { noRecipient: true, summary };

      const actor = await resolveActor(actorUuid);
      let missingReported = false;
      for (const grant of grants) {
        const record = grant.recipients[actorUuid];
        if (!actor) {
          record.status = RECIPIENT_STATUS.MISSING_ACTOR;
          record.error = "missing-actor";
          record.updatedAt = Date.now();
          if (!missingReported) {
            missingReported = true;
            summary.failed += 1;
            summary.errors.push(game.i18n.format("JELI.Summary.ActorMissing", {
              actor: record.actorName || actorUuid
            }));
          }
        } else {
          await revokeAllRecipientObjects(actor, record, grant, set.id, summary);
          record.status = RECIPIENT_STATUS.REVOKED;
          record.updatedAt = Date.now();
        }
        recomputeGrantStatus(grant);
        if (grant.status === GRANT_STATUS.REVOKED && entry.activeGrantId === grant.grantId) {
          entry.activeGrantId = null;
        }
      }

      if (actor) await sweepLeftovers([actor], set.id, entry, set, summary);

      const grantId = grants.at(-1).grantId;
      addHistory(registry, {
        setId: set.id,
        setName: set.name ?? "",
        grantId,
        actorUuid,
        operation: "revoke-recipient",
        result: summary.failed > 0 ? "partial" : "success",
        message: "",
        summary
      });
      await this.#manager.saveRegistry(registry);
      return { noGrant: false, summary, grantId };
    });
  }

  async revokeAll() {
    assertGM();
    await this.#manager.initialize();
    const results = [];
    const handled = new Set();

    for (const set of this.#manager.getSets()) {
      handled.add(set.id);
      const registry = await this.#manager.loadRegistry();
      const entry = registry.sets?.[set.id];
      if (!Object.values(entry?.generations ?? {}).some(grantNeedsRevocation)) continue;
      results.push({ setId: set.id, name: set.name, ...(await this.revokeSet(set)) });
    }

    const registry = await this.#manager.loadRegistry();
    for (const [setId, entry] of Object.entries(registry.sets ?? {})) {
      if (handled.has(setId)) continue;
      if (!Object.values(entry?.generations ?? {}).some(grantNeedsRevocation)) continue;
      results.push({
        setId,
        name: entry.setName ?? setId,
        ...(await this.revokeSet({ id: setId, name: entry.setName ?? setId }))
      });
    }
    return results;
  }

  /**
   * Revoke every active grant of one actor across all sets, including orphaned
   * grants whose Effect Set page no longer exists.
   */
  async revokeActor(actorUuid) {
    assertGM();
    if (!actorUuid) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));
    await this.#manager.initialize();

    const sets = this.#manager.getSets();
    const results = [];
    for (const set of sets) {
      const registry = await this.#manager.loadRegistry();
      if (!entryHasRecipient(registry.sets?.[set.id], actorUuid)) continue;
      results.push({ setId: set.id, name: set.name, ...(await this.revokeRecipient(set, actorUuid)) });
    }

    const registry = await this.#manager.loadRegistry();
    for (const [setId, entry] of Object.entries(registry.sets ?? {})) {
      if (sets.some(set => set.id === setId)) continue;
      if (!entryHasRecipient(entry, actorUuid)) continue;
      const name = entry.setName ?? setId;
      results.push({ setId, name, ...(await this.revokeRecipient({ id: setId, name }, actorUuid)) });
    }
    return results;
  }

  async #revokeGrant(set, registry, entry, grant, summary) {
    for (const [actorUuid, record] of Object.entries(grant.recipients ?? {})) {
      if (record.status === RECIPIENT_STATUS.REVOKED) continue;
      const actor = await resolveActor(actorUuid);
      if (!actor) {
        record.status = RECIPIENT_STATUS.MISSING_ACTOR;
        record.error = "missing-actor";
        record.updatedAt = Date.now();
        summary.failed += 1;
        summary.errors.push(game.i18n.format("JELI.Summary.ActorMissing", {
          actor: record.actorName || actorUuid
        }));
        addHistory(registry, {
          setId: set.id,
          setName: set.name ?? "",
          grantId: grant.grantId,
          actorUuid,
          operation: "revoke-set",
          result: "failed",
          message: "missing-actor"
        });
        continue;
      }
      await revokeAllRecipientObjects(actor, record, grant, set.id, summary);
      record.status = RECIPIENT_STATUS.REVOKED;
      record.updatedAt = Date.now();
    }

    grant.status = GRANT_STATUS.REVOKED;
    grant.revokedAt = Date.now();
    grant.revokedBy = { id: game.user.id, name: game.user.name };
    entry.activeGrantId = null;
  }
}
