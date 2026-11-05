import { LOCK_TIMEOUT } from "../constants.js";
import { error as logError } from "../utils/logger.js";

/**
 * Per-set operation lock backed by the persistent registry so that two GM
 * clients cannot mutate the same grant simultaneously.
 */
export class OperationLock {
  #manager;
  #local = new Set();

  constructor(manager) {
    this.#manager = manager;
  }

  async run(setId, callback) {
    if (this.#local.has(setId)) {
      throw new Error(game.i18n.localize("JELI.Error.OperationBusy"));
    }
    this.#local.add(setId);
    let acquired = false;
    try {
      await this.#acquire(setId);
      acquired = true;
      return await callback();
    } finally {
      if (acquired) {
        try {
          await this.#release(setId);
        } catch (err) {
          logError("Failed to release operation lock", setId, err);
        }
      }
      this.#local.delete(setId);
    }
  }

  async #acquire(setId) {
    if (!this.#manager.registryOk) {
      throw new Error(game.i18n.localize(
        this.#manager.registryMissing ? "JELI.Error.RegistryMissing" : "JELI.Error.RegistryCorrupt"
      ));
    }
    const registry = await this.#manager.loadRegistry();
    if (!registry) {
      throw new Error(game.i18n.localize("JELI.Error.RegistryCorrupt"));
    }
    const lock = registry.locks?.[setId];
    const now = Date.now();
    if (lock && lock.userId !== game.user.id && (now - (lock.ts ?? 0)) < LOCK_TIMEOUT) {
      throw new Error(game.i18n.format("JELI.Error.OperationBusyDetail", {
        user: lock.userName || lock.userId
      }));
    }
    registry.locks ??= {};
    registry.locks[setId] = {
      userId: game.user.id,
      userName: game.user.name,
      ts: now
    };
    await this.#manager.saveRegistry(registry);
  }

  async #release(setId) {
    const registry = await this.#manager.loadRegistry();
    if (!registry) return;
    const lock = registry.locks?.[setId];
    if (lock?.userId !== game.user.id) return;
    delete registry.locks[setId];
    await this.#manager.saveRegistry(registry);
  }
}
