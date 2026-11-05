import {
  DEFAULT_SET_ICON,
  KIND_REGISTRY,
  KIND_SET,
  MODULE_ID,
  SCHEMA_VERSION,
  STORAGE_JOURNAL_NAME,
  STORAGE_REGISTRY_PAGE_NAME
} from "../constants.js";
import { migrateRegistry, migrateSet } from "../utils/migration.js";
import { createSetId } from "../utils/uuid.js";
import { debug, error as logError, warn } from "../utils/logger.js";
import { isGM } from "./permissions.js";

const REGISTRY_NOTE = "<p>Journal Effects Links — persistent grant registry. Do not edit this page.</p>";
const SET_NOTE = "<p>Journal Effects Links — Effect Set data. Edit this set from the module manager.</p>";

function journalEntryClass() {
  return CONFIG.JournalEntry?.documentClass ?? globalThis.JournalEntry;
}

export function createSetDraft() {
  const now = Date.now();
  const recipients = (game.actors?.contents ?? [])
    .filter(actor => actor.type === "character" && actor.hasPlayerOwner)
    .map(actor => actor.uuid);
  return {
    id: createSetId(),
    schemaVersion: SCHEMA_VERSION,
    name: game.i18n.localize("JELI.Editor.DefaultName"),
    description: "",
    img: DEFAULT_SET_ICON,
    objects: [],
    recipients,
    distribution: { mode: "apply" },
    createdAt: now,
    updatedAt: now,
    lastActivatedAt: null,
    lastSyncedAt: null,
    journalLink: null
  };
}

export class SetManager {
  #journal = null;
  #registryPage = null;
  #ready = null;
  #registryOk = true;
  #registryMissing = false;

  get registryOk() {
    return this.#registryOk;
  }

  get registryMissing() {
    return this.#registryMissing;
  }

  get initialized() {
    return Boolean(this.#journal && this.#registryPage);
  }

  get storageJournal() {
    return this.#journal;
  }

  async initialize() {
    if (!isGM()) return null;
    if (this.#ready) return this.#ready;
    this.#ready = this.#initialize().catch(err => {
      this.#ready = null;
      logError("Failed to initialize storage", err);
      throw err;
    });
    return this.#ready;
  }

  async #initialize() {
    let journal = game.journal.contents.find(entry => entry.flags?.[MODULE_ID]?.storage === true);
    const isNewStorage = !journal;
    if (!journal) {
      const JournalEntryClass = journalEntryClass();
      journal = await JournalEntryClass.create({
        name: STORAGE_JOURNAL_NAME,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
        flags: {
          [MODULE_ID]: {
            storage: true,
            schemaVersion: SCHEMA_VERSION
          }
        }
      });
      debug("Created storage journal", journal.uuid);
    }
    this.#journal = journal;

    let page = journal.pages.contents.find(page => page.flags?.[MODULE_ID]?.kind === KIND_REGISTRY);
    if (!page) {
      const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
        name: STORAGE_REGISTRY_PAGE_NAME,
        type: "text",
        text: { content: REGISTRY_NOTE, format: 1 },
        flags: {
          [MODULE_ID]: {
            kind: KIND_REGISTRY,
            schemaVersion: SCHEMA_VERSION,
            // An existing storage journal without a registry means the registry
            // was lost: keep it missing so destructive operations stay disabled
            // until the GM rebuilds it from document flags.
            registryData: isNewStorage
              ? JSON.stringify(migrateRegistry({}) ?? {})
              : undefined
          }
        }
      }]);
      page = created;
      if (isNewStorage) debug("Created registry page", page.uuid);
      else warn("Registry page was missing from existing storage; awaiting repair.");
    }
    this.#registryPage = page;
    this.#readRegistry();
    return journal;
  }

  #findSetPage(setId) {
    return this.#journal?.pages?.contents.find(page =>
      page.flags?.[MODULE_ID]?.kind === KIND_SET
      && page.flags?.[MODULE_ID]?.set?.id === setId
    ) ?? null;
  }

  #setPages() {
    return this.#journal?.pages?.contents.filter(page =>
      page.flags?.[MODULE_ID]?.kind === KIND_SET
      && page.flags?.[MODULE_ID]?.set
    ) ?? [];
  }

  getSets() {
    return this.#setPages()
      .map(page => migrateSet(page.flags[MODULE_ID].set))
      .filter(Boolean);
  }

  getSet(setId) {
    const page = this.#findSetPage(setId);
    if (!page) return null;
    return migrateSet(page.flags?.[MODULE_ID]?.set);
  }

  async saveSet(set, { touch = true } = {}) {
    await this.initialize();
    if (!this.#journal) throw new Error(game.i18n.localize("JELI.Error.StorageUnavailable"));
    const data = migrateSet(set);
    if (!data) throw new Error(game.i18n.localize("JELI.Error.SetInvalid"));
    if (touch) data.updatedAt = Date.now();
    set.updatedAt = data.updatedAt;

    const flagData = {
      [`flags.${MODULE_ID}.kind`]: KIND_SET,
      [`flags.${MODULE_ID}.schemaVersion`]: SCHEMA_VERSION,
      [`flags.${MODULE_ID}.set`]: data
    };
    const page = this.#findSetPage(data.id);
    if (page) {
      await page.update({ name: data.name, ...flagData });
      return page;
    }
    const [created] = await this.#journal.createEmbeddedDocuments("JournalEntryPage", [{
      name: data.name,
      type: "text",
      text: { content: SET_NOTE, format: 1 },
      sort: data.createdAt,
      flags: {
        [MODULE_ID]: {
          kind: KIND_SET,
          schemaVersion: SCHEMA_VERSION,
          set: data
        }
      }
    }]);
    return created;
  }

  async deleteSet(setId) {
    await this.initialize();
    const page = this.#findSetPage(setId);
    if (page) await page.delete();
  }

  #readRegistry() {
    if (!this.#registryPage) {
      this.#registryMissing = true;
      this.#registryOk = false;
      return migrateRegistry({}) ?? null;
    }
    const flags = this.#registryPage.flags?.[MODULE_ID] ?? {};
    let raw;
    if (typeof flags.registryData === "string") {
      try {
        raw = JSON.parse(flags.registryData);
      } catch (err) {
        logError("Registry data is not valid JSON; destructive operations are disabled.", err);
        this.#registryOk = false;
        this.#registryMissing = false;
        return null;
      }
    } else if (flags.registry === undefined) {
      this.#registryMissing = true;
      this.#registryOk = false;
      return migrateRegistry({}) ?? null;
    } else {
      // Older builds stored the registry as an object; migration repairs it.
      raw = flags.registry;
    }
    const registry = migrateRegistry(raw);
    if (!registry) {
      this.#registryOk = false;
      this.#registryMissing = false;
      logError("Registry data is corrupted; destructive operations are disabled.");
      return null;
    }
    this.#registryOk = true;
    this.#registryMissing = false;
    return registry;
  }

  async loadRegistry() {
    if (isGM()) await this.initialize();
    return this.#readRegistry();
  }

  async saveRegistry(registry) {
    await this.initialize();
    if (!this.#registryPage) throw new Error(game.i18n.localize("JELI.Error.StorageUnavailable"));
    registry.schemaVersion ??= SCHEMA_VERSION;
    registry.updatedAt = Date.now();
    // JSON string: Foundry expands dotted keys, corrupting Actor.<id> maps.
    await this.#registryPage.update({
      [`flags.${MODULE_ID}.registryData`]: JSON.stringify(registry)
    });
    this.#registryOk = true;
    this.#registryMissing = false;
  }

  async markOrphaned(setId) {
    const registry = await this.loadRegistry();
    if (!registry?.sets?.[setId]) return;
    registry.sets[setId].orphanedAt = Date.now();
    await this.saveRegistry(registry);
  }

  async clearOrphaned(setId) {
    const registry = await this.loadRegistry();
    if (!registry?.sets?.[setId]) return;
    registry.sets[setId].orphanedAt = null;
    await this.saveRegistry(registry);
  }
}
