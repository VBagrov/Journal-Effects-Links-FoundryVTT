import {
  DEFAULT_OBJECT_ICON,
  DEFAULT_SET_ICON,
  DOCUMENT_TYPES,
  INSTANCE_STATUS,
  RECIPIENT_STATUS,
  SET_STATUS
} from "../constants.js";

const SET_STATUS_KEYS = {
  [SET_STATUS.DRAFT]: "JELI.Status.Draft",
  [SET_STATUS.ACTIVE]: "JELI.Status.Active",
  [SET_STATUS.PARTIAL]: "JELI.Status.Partial",
  [SET_STATUS.REVOKED]: "JELI.Status.Revoked",
  [SET_STATUS.ERROR]: "JELI.Status.Error"
};

const RECIPIENT_STATUS_KEYS = {
  [RECIPIENT_STATUS.ACTIVE]: "JELI.RecipientStatus.Active",
  [RECIPIENT_STATUS.PARTIAL]: "JELI.RecipientStatus.Partial",
  [RECIPIENT_STATUS.FAILED]: "JELI.RecipientStatus.Failed",
  [RECIPIENT_STATUS.MISSING_ACTOR]: "JELI.RecipientStatus.MissingActor",
  [RECIPIENT_STATUS.REVOKED]: "JELI.RecipientStatus.Revoked"
};

const INSTANCE_STATUS_KEYS = {
  [INSTANCE_STATUS.GRANTED]: "JELI.InstanceStatus.Granted",
  [INSTANCE_STATUS.MISSING]: "JELI.InstanceStatus.Missing",
  [INSTANCE_STATUS.FAILED]: "JELI.InstanceStatus.Failed",
  [INSTANCE_STATUS.REVOKED]: "JELI.InstanceStatus.Revoked",
  [INSTANCE_STATUS.CONFLICT]: "JELI.InstanceStatus.Conflict",
  [INSTANCE_STATUS.SKIPPED]: "JELI.InstanceStatus.Skipped"
};

export function setStatusLabel(status) {
  return game.i18n.localize(SET_STATUS_KEYS[status] ?? "JELI.Status.Unknown");
}

export function recipientStatusLabel(status) {
  return game.i18n.localize(RECIPIENT_STATUS_KEYS[status] ?? "JELI.Status.Unknown");
}

export function instanceStatusLabel(status) {
  return game.i18n.localize(INSTANCE_STATUS_KEYS[status] ?? "JELI.Status.Unknown");
}

export function formatDateTime(timestamp) {
  if (!timestamp) return game.i18n.localize("JELI.Common.Never");
  try {
    return new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "short", timeStyle: "short" })
      .format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

export function findActorSync(uuid) {
  if (!uuid || typeof fromUuidSync !== "function") return null;
  try {
    const document = fromUuidSync(uuid);
    return document?.documentName === "Actor" ? document : null;
  } catch {
    return null;
  }
}

export function actorDisplayName(uuid, fallback = "") {
  return findActorSync(uuid)?.name ?? fallback ?? uuid;
}

export function ownerLabel(actor) {
  if (!actor) return game.i18n.localize("JELI.Common.NoOwner");
  try {
    const owners = game.users.filter(user => actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
    if (!owners.length) return game.i18n.localize("JELI.Common.NoOwner");
    return owners.map(user => user.name).join(", ");
  } catch {
    return game.i18n.localize("JELI.Common.NoOwner");
  }
}

export function isNpcActor(actor) {
  return actor?.type === "npc";
}

export function isDefaultPlayerCharacter(actor) {
  // Worlds often grant players default ownership instead of per-actor OWNER,
  // so hasPlayerOwner alone can hide every playable character.
  return Boolean(actor) && (actor.type === "character" || Boolean(actor.hasPlayerOwner));
}

export function itemTypeLabel(type, documentType) {
  if (documentType === DOCUMENT_TYPES.EFFECT) return game.i18n.localize("JELI.Common.ActiveEffect");
  const labels = CONFIG.Item?.typeLabels ?? {};
  const key = labels[type];
  if (!key) return type || game.i18n.localize("JELI.Common.Item");
  return game.i18n.localize(key);
}

export function documentTypeLabel(documentType) {
  return documentType === DOCUMENT_TYPES.EFFECT
    ? game.i18n.localize("JELI.Common.ActiveEffect")
    : game.i18n.localize("JELI.Common.Item");
}

export function sourceLabel(sourceUuid) {
  if (!sourceUuid) return game.i18n.localize("JELI.Common.SourceSnapshot");
  if (sourceUuid.startsWith("Compendium.")) return game.i18n.localize("JELI.Common.SourceCompendium");
  if (sourceUuid.includes(".Item.") || sourceUuid.includes(".ActiveEffect.")) {
    return game.i18n.localize("JELI.Common.SourceActor");
  }
  return game.i18n.localize("JELI.Common.SourceWorld");
}

export function setIcon(set) {
  return set?.img || DEFAULT_SET_ICON;
}

export function objectIcon(object) {
  return object?.img || object?.source?.img || DEFAULT_OBJECT_ICON;
}

export function linkForSet(set) {
  const label = String(set?.name ?? set?.id ?? "").replace(/[{}[\]]/g, "").trim();
  return `@EffectLink[${set?.id}]{${label}}`;
}

export async function copyToClipboard(text) {
  try {
    if (game.clipboard?.copyPlainText) {
      await game.clipboard.copyPlainText(text);
      return true;
    }
  } catch {
    // fall through to the browser clipboard
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export function operationLabel(operation) {
  const key = `JELI.Op.${String(operation ?? "unknown")}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : String(operation ?? "—");
}

export function resultLabel(result) {
  const key = `JELI.Result.${String(result ?? "unknown")}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : String(result ?? "—");
}
