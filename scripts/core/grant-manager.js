import {
  GRANT_STATUS,
  INSTANCE_STATUS,
  RECIPIENT_STATUS,
  SYNC_MODE
} from "../constants.js";
import { createInstanceId } from "../utils/uuid.js";
import { createSummary } from "../utils/summary.js";
import { error as logError } from "../utils/logger.js";
import {
  addHistory,
  archiveRevokedRecipient,
  createRecipientRecord,
  ensureActiveGrant,
  getActiveGrant,
  recomputeGrantStatus,
  recomputeRecipientStatus
} from "./grant-registry.js";
import {
  createInstance as createManagedInstance,
  updateInstance as updateManagedInstance
} from "./document-factory.js";
import {
  findEquivalentDocument,
  getEmbeddedDocument,
  isSafeConflict,
  resolveActor,
  verifyInstance
} from "./document-validator.js";
import { OperationLock } from "./operation-lock.js";
import { assertGM, assertRegistryUsable } from "./permissions.js";
import { allowDuplicateCopies } from "../settings.js";
import { revokeAllRecipientObjects, revokeInstanceRecord } from "./revocation.js";

function recordHasLiveInstances(record) {
  return Object.values(record?.objects ?? {}).some(instance =>
    instance
    && instance.status !== INSTANCE_STATUS.REVOKED
    && instance.status !== INSTANCE_STATUS.SKIPPED
  );
}

export function validateSet(set, { requireObjects = true, requireRecipients = true } = {}) {
  if (!set?.id) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));
  if (!String(set.name ?? "").trim()) throw new Error(game.i18n.localize("JELI.Error.NameRequired"));
  if (requireObjects && !(set.objects?.length > 0)) throw new Error(game.i18n.localize("JELI.Error.NoObjects"));
  if (requireRecipients && !(set.recipients?.length > 0)) throw new Error(game.i18n.localize("JELI.Error.NoRecipients"));
}

export class GrantManager {
  #manager;
  #lock;

  constructor(manager) {
    this.#manager = manager;
    this.#lock = new OperationLock(manager);
  }

  async activate(set) {
    assertGM();
    validateSet(set);
    const registry = await this.#manager.loadRegistry();
    assertRegistryUsable(this.#manager.registryOk, this.#manager.registryMissing);
    const existing = getActiveGrant(registry, set.id);
    if (existing) {
      return {
        summary: createSummary(),
        activated: false,
        alreadyActive: true,
        grantId: existing.grantId
      };
    }
    return this.sync(set, SYNC_MODE.ADD);
  }

  /**
   * Revoke documents that belong to recipients or objects removed from an
   * active set. Saving a set never grants newly added entries: those are
   * created only by an explicit synchronization.
   */
  async prune(set) {
    assertGM();
    if (!set?.id) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));

    return this.#lock.run(set.id, async () => {
      const registry = await this.#manager.loadRegistry();
      assertRegistryUsable(this.#manager.registryOk, this.#manager.registryMissing);
      const entry = registry.sets?.[set.id];
      const grant = getActiveGrant(registry, set.id);
      const summary = createSummary();
      if (!grant) return { noGrant: true, summary };

      await this.#removeUndesiredRecipients(set, grant, registry, summary, { quiet: true });
      await this.#removeUndesiredObjects(set, grant, summary, { quiet: true });

      for (const record of Object.values(grant.recipients ?? {})) {
        if (record.status !== RECIPIENT_STATUS.REVOKED
          && record.status !== RECIPIENT_STATUS.MISSING_ACTOR) {
          recomputeRecipientStatus(record);
        }
      }
      recomputeGrantStatus(grant);
      if (grant.status === GRANT_STATUS.REVOKED && entry) entry.activeGrantId = null;

      if (summary.removed || summary.removedRecipients || summary.failed) {
        addHistory(registry, {
          setId: set.id,
          setName: set.name ?? "",
          grantId: grant.grantId,
          operation: "prune",
          result: summary.failed > 0 ? "partial" : "success",
          message: "",
          summary
        });
        await this.#manager.saveRegistry(registry);
      }
      return { noGrant: false, summary, grantId: grant.grantId };
    });
  }

  async sync(set, mode = SYNC_MODE.APPLY) {
    assertGM();
    if (!set?.id) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));
    if (!String(set.name ?? "").trim()) {
      throw new Error(game.i18n.localize("JELI.Error.NameRequired"));
    }

    return this.#lock.run(set.id, async () => {
      const registry = await this.#manager.loadRegistry();
      assertRegistryUsable(this.#manager.registryOk, this.#manager.registryMissing);

      // Empty configurations are allowed when an active grant already exists,
      // so that removing every object or recipient can revoke that grant.
      if (!getActiveGrant(registry, set.id)) validateSet(set);

      const { entry, grant, created } = ensureActiveGrant(registry, set.id, game.user);
      const summary = createSummary();

      if (!created && mode !== SYNC_MODE.ADD) {
        await this.#removeUndesiredRecipients(set, grant, registry, summary);
        await this.#removeUndesiredObjects(set, grant, summary);
      }

      for (const actorUuid of set.recipients) {
        await this.#grantRecipient(set, grant, registry, actorUuid, summary, {
          update: mode === SYNC_MODE.FULL
        });
      }

      for (const record of Object.values(grant.recipients)) {
        if (record.status !== RECIPIENT_STATUS.REVOKED
          && record.status !== RECIPIENT_STATUS.MISSING_ACTOR) {
          recomputeRecipientStatus(record);
        }
      }

      grant.lastSyncAt = Date.now();
      grant.lastSync = summary;
      recomputeGrantStatus(grant);
      if (grant.status === GRANT_STATUS.REVOKED) entry.activeGrantId = null;

      if (created) set.lastActivatedAt = grant.activatedAt;
      set.lastSyncedAt = grant.lastSyncAt;

      addHistory(registry, {
        setId: set.id,
        setName: set.name,
        grantId: grant.grantId,
        operation: created ? "activate" : "sync",
        result: summary.failed > 0 || summary.conflicts > 0 ? "partial" : "success",
        message: "",
        summary
      });

      await this.#manager.saveSet(set, { touch: false });
      await this.#manager.saveRegistry(registry);
      return { summary, activated: created, grantId: grant.grantId };
    });
  }

  async #removeUndesiredRecipients(set, grant, registry, summary, { quiet = false } = {}) {
    for (const [actorUuid, record] of Object.entries(grant.recipients ?? {})) {
      if (record.status === RECIPIENT_STATUS.REVOKED && !recordHasLiveInstances(record)) continue;
      if (set.recipients.includes(actorUuid)) continue;

      const actor = await resolveActor(actorUuid);
      if (!actor) {
        record.status = RECIPIENT_STATUS.REVOKED;
        record.error = "missing-actor";
        record.updatedAt = Date.now();
        summary.skipped += 1;
        if (!quiet) {
          summary.failed += 1;
          summary.errors.push(game.i18n.format("JELI.Summary.ActorMissing", {
            actor: record.actorName || actorUuid
          }));
        }
        addHistory(registry, {
          setId: set.id,
          setName: set.name,
          grantId: grant.grantId,
          actorUuid,
          operation: "revoke-recipient",
          result: quiet ? "success" : "failed",
          message: "missing-actor"
        });
        continue;
      }

      await revokeAllRecipientObjects(actor, record, grant, set.id, summary);
      record.status = RECIPIENT_STATUS.REVOKED;
      record.updatedAt = Date.now();
      summary.removedRecipients += 1;
      addHistory(registry, {
        setId: set.id,
        setName: set.name,
        grantId: grant.grantId,
        actorUuid,
        operation: "revoke-recipient",
        result: "success",
        message: "recipient-removed"
      });
    }
  }

  async #removeUndesiredObjects(set, grant, summary, { quiet = false } = {}) {
    const desiredObjectIds = new Set(set.objects.map(object => object.id));
    for (const [actorUuid, record] of Object.entries(grant.recipients ?? {})) {
      if (record.status === RECIPIENT_STATUS.REVOKED && !recordHasLiveInstances(record)) continue;

      const actor = await resolveActor(actorUuid);
      for (const objectId of Object.keys(record.objects ?? {})) {
        if (desiredObjectIds.has(objectId)) continue;
        const instance = record.objects[objectId];
        if (instance.status === INSTANCE_STATUS.REVOKED) continue;
        if (instance.status === INSTANCE_STATUS.SKIPPED) {
          // Skipped entries only reference documents the module never owned.
          delete record.objects[objectId];
          continue;
        }
        if (!actor) {
          instance.status = INSTANCE_STATUS.MISSING;
          instance.error = "missing-actor";
          instance.updatedAt = Date.now();
          if (!quiet) summary.failed += 1;
          continue;
        }
        await revokeInstanceRecord(actor, record, objectId, grant, set.id, summary);
      }
      if (record.status !== RECIPIENT_STATUS.REVOKED
        && record.status !== RECIPIENT_STATUS.MISSING_ACTOR) {
        recomputeRecipientStatus(record);
      }
    }
  }

  async #grantRecipient(set, grant, registry, actorUuid, summary, { update = false } = {}) {
    const actor = await resolveActor(actorUuid);
    let record = grant.recipients?.[actorUuid];

    if (record && record.status === RECIPIENT_STATUS.REVOKED) {
      archiveRevokedRecipient(grant, actorUuid);
      record = null;
    }
    if (!record) {
      record = createRecipientRecord(actorUuid, actor);
      grant.recipients[actorUuid] = record;
    }

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
        setName: set.name,
        grantId: grant.grantId,
        actorUuid,
        operation: "grant",
        result: "failed",
        message: "missing-actor"
      });
      return;
    }

    record.actorName = actor.name;
    record.error = null;

    for (const object of set.objects) {
      const existing = record.objects?.[object.id];
      if (existing?.status === INSTANCE_STATUS.SKIPPED) {
        const duplicate = allowDuplicateCopies() ? null : findEquivalentDocument(actor, object);
        if (duplicate) {
          existing.documentId = duplicate.id;
          existing.documentUuid = duplicate.uuid;
          existing.updatedAt = Date.now();
          summary.skipped += 1;
          continue;
        }
        delete record.objects[object.id];
      }
      const current = record.objects?.[object.id];
      const reuseInstance = current && current.status !== INSTANCE_STATUS.REVOKED;
      const instanceId = reuseInstance
        ? (current.instanceId ?? createInstanceId())
        : createInstanceId();

      if (reuseInstance) {
        const check = verifyInstance(actor, current, {
          setId: set.id,
          grantId: grant.grantId,
          templateObjectId: object.id
        });
        if (check.ok) {
          if (update) {
            await this.#updateRecipientInstance(actor, object, grant, set, record, current, summary);
          } else {
            summary.skipped += 1;
          }
          continue;
        }
        if (isSafeConflict(check.reason)) {
          current.status = INSTANCE_STATUS.CONFLICT;
          current.error = check.reason;
          current.updatedAt = Date.now();
          summary.conflicts += 1;
          summary.errors.push(game.i18n.format("JELI.Summary.Conflict", {
            object: object.name,
            actor: actor.name
          }));
          addHistory(registry, {
            setId: set.id,
            setName: set.name,
            grantId: grant.grantId,
            actorUuid,
            objectId: object.id,
            operation: "grant",
            result: "failed",
            message: check.reason
          });
          continue;
        }
      }

      if (!allowDuplicateCopies()) {
        const duplicate = findEquivalentDocument(actor, object);
        if (duplicate) {
          record.objects[object.id] = {
            instanceId,
            name: object.name,
            documentType: object.documentType,
            documentId: duplicate.id,
            documentUuid: duplicate.uuid,
            status: INSTANCE_STATUS.SKIPPED,
            grantedAt: null,
            updatedAt: Date.now(),
            error: null
          };
          summary.skipped += 1;
          continue;
        }
      }

      await this.#createRecipientInstance(actor, object, grant, set, record, summary, instanceId, registry);
    }

    recomputeRecipientStatus(record);
    record.updatedAt = Date.now();
  }

  async #createRecipientInstance(actor, object, grant, set, record, summary, instanceId, registry) {
    const ids = { setId: set.id, grantId: grant.grantId, instanceId };
    const now = Date.now();
    try {
      const document = await createManagedInstance(actor, object, ids);
      record.objects[object.id] = {
        instanceId,
        name: object.name,
        documentType: object.documentType,
        documentId: document.id,
        documentUuid: document.uuid,
        status: INSTANCE_STATUS.GRANTED,
        grantedAt: now,
        updatedAt: now,
        error: null
      };
      summary.created += 1;
    } catch (err) {
      logError("Failed to create managed instance", err);
      record.objects[object.id] = {
        instanceId,
        name: object.name,
        documentType: object.documentType,
        documentId: null,
        documentUuid: null,
        status: INSTANCE_STATUS.FAILED,
        grantedAt: now,
        updatedAt: now,
        error: err.message
      };
      summary.failed += 1;
      summary.errors.push(game.i18n.format("JELI.Summary.CreateFailed", {
        object: object.name,
        actor: actor.name,
        error: err.message
      }));
      addHistory(registry, {
        setId: set.id,
        setName: set.name,
        grantId: grant.grantId,
        actorUuid: actor.uuid,
        objectId: object.id,
        operation: "grant",
        result: "failed",
        message: err.message
      });
    }
  }

  async #updateRecipientInstance(actor, object, grant, set, record, instance, summary) {
    const ids = {
      setId: set.id,
      grantId: grant.grantId,
      instanceId: instance.instanceId
    };
    try {
      const target = getEmbeddedDocument(actor, instance);
      if (!target) throw new Error("missing-document");
      const document = await updateManagedInstance(target, object, ids);
      instance.documentId = document.id;
      instance.documentUuid = document.uuid;
      instance.name = object.name;
      instance.status = INSTANCE_STATUS.GRANTED;
      instance.error = null;
      instance.updatedAt = Date.now();
      summary.updated += 1;
    } catch (err) {
      logError("Failed to update managed instance", err);
      instance.status = INSTANCE_STATUS.FAILED;
      instance.error = err.message;
      instance.updatedAt = Date.now();
      summary.failed += 1;
      summary.errors.push(game.i18n.format("JELI.Summary.UpdateFailed", {
        object: object.name,
        actor: actor.name,
        error: err.message
      }));
    }
  }
}
