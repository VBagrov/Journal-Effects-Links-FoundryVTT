export const MODULE_ID = "journal-effects-links";
export const MODULE_TITLE = "Journal Effects Links";
export const SCHEMA_VERSION = 1;

export const STORAGE_JOURNAL_NAME = "Journal Effects Links — Data";
export const STORAGE_REGISTRY_PAGE_NAME = "Registry";

export const KIND_STORAGE = "storage";
export const KIND_SET = "set";
export const KIND_REGISTRY = "registry";

export const DOCUMENT_TYPES = Object.freeze({
  ITEM: "Item",
  EFFECT: "ActiveEffect"
});

export const SET_STATUS = Object.freeze({
  DRAFT: "draft",
  ACTIVE: "active",
  PARTIAL: "partial",
  REVOKED: "revoked",
  ERROR: "error"
});

export const GRANT_STATUS = Object.freeze({
  ACTIVE: "active",
  PARTIAL: "partial",
  REVOKED: "revoked",
  ERROR: "error"
});

export const RECIPIENT_STATUS = Object.freeze({
  ACTIVE: "active",
  PARTIAL: "partial",
  FAILED: "failed",
  MISSING_ACTOR: "missing-actor",
  REVOKED: "revoked"
});

export const INSTANCE_STATUS = Object.freeze({
  GRANTED: "granted",
  MISSING: "missing",
  FAILED: "failed",
  REVOKED: "revoked",
  CONFLICT: "conflict",
  SKIPPED: "skipped"
});

export const SYNC_MODE = Object.freeze({
  ADD: "add",
  APPLY: "apply",
  FULL: "full"
});

export const DEFAULT_SYNC_MODE = SYNC_MODE.APPLY;

export const MAX_HISTORY = 300;
export const LOCK_TIMEOUT = 120000;

export const SET_ID_RE = /^set_[A-Za-z0-9]{4,64}$/;
export const LINK_RE = /@EffectLink\[([^\]]+)\](?:\{([^}]*)\})?/g;

export const DEFAULT_SET_ICON = "icons/svg/aura.svg";
export const DEFAULT_OBJECT_ICON = "icons/svg/item-bag.svg";

export const CHANGE_HOOK = "journalEffectsLinks.setChanged";
