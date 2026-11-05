import {
  CHANGE_HOOK,
  DEFAULT_SET_ICON,
  INSTANCE_STATUS,
  RECIPIENT_STATUS,
  SET_STATUS,
  SYNC_MODE
} from "../constants.js";
import {
  deriveSetStatus,
  getActiveGrant,
  getLatestGrant
} from "../core/grant-registry.js";
import {
  revocationManager,
  setManager
} from "../core/services.js";
import { evaluateRecipient, verifyInstance } from "../core/document-validator.js";
import {
  findActorSync,
  formatDateTime,
  itemTypeLabel,
  objectIcon,
  recipientStatusLabel,
  setStatusLabel
} from "../utils/display.js";
import { notifyError, notifyWarn } from "../utils/logger.js";
import { defaultSyncMode } from "../settings.js";
import { confirmAction, emitSetChanged, notifySummary, showLinkDialog } from "./dialogs.js";
import { SetEditorApp } from "./set-editor.js";
import { SyncPreviewApp } from "./synchronization-preview.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function syncSummaryText(summary) {
  if (!summary) return "";
  return game.i18n.format("JELI.Summary.Line", {
    created: summary.created ?? 0,
    removed: summary.removed ?? 0,
    updated: summary.updated ?? 0,
    failed: summary.failed ?? 0
  });
}

export class SetManagementApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #open = new Map();

  static DEFAULT_OPTIONS = {
    id: "jeli-set-management",
    classes: ["jeli-app", "jeli-set-management"],
    tag: "div",
    window: {
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true,
      minimizable: true
    },
    position: { width: 980, height: 760 },
    actions: {
      editSet: SetManagementApp._onEditSet,
      activate: SetManagementApp._onActivate,
      synchronize: SetManagementApp._onSynchronize,
      revokeSet: SetManagementApp._onRevokeSet,
      revokeRecipient: SetManagementApp._onRevokeRecipient,
      copyLink: SetManagementApp._onCopyLink,
      close: SetManagementApp._onClose
    }
  };

  static PARTS = {
    body: {
      template: "modules/journal-effects-links/templates/set-management.hbs",
      scrollable: [".jeli-management-body"]
    }
  };

  static open(setId) {
    let app = SetManagementApp.#open.get(setId);
    if (!app) {
      app = new SetManagementApp({ setId });
      SetManagementApp.#open.set(setId, app);
    }
    app.render({ force: true });
    return app;
  }

  constructor(options = {}) {
    super({ ...options, id: options.id ?? `jeli-set-management-${options.setId ?? "unknown"}` });
    this.setId = options.setId ?? null;
    this.set = null;
    this.missing = false;
    this.busy = false;
    this.onSetChanged = ({ setId } = {}) => {
      if (setId && setId !== this.setId) return;
      this.render({ force: true });
    };
    Hooks.on(CHANGE_HOOK, this.onSetChanged);
  }

  get title() {
    return this.set?.name ?? game.i18n.localize("JELI.Management.Title");
  }

  async _onClose(options) {
    Hooks.off(CHANGE_HOOK, this.onSetChanged);
    SetManagementApp.#open.delete(this.setId);
    return super._onClose(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    try {
      await setManager.initialize();
    } catch (err) {
      notifyError(err.message);
    }

    const set = this.setId ? setManager.getSet(this.setId) : null;
    if (!set) {
      this.missing = true;
      this.set = null;
      return { ...context, missing: true, setId: this.setId };
    }
    this.set = { ...set, img: set.img || DEFAULT_SET_ICON };
    this.missing = false;

    const registry = await setManager.loadRegistry();
    const grant = getActiveGrant(registry, set.id);
    const latest = grant ?? getLatestGrant(registry, set.id);
    let status = deriveSetStatus(set, registry);
    const recipients = this.#recipientRows(set, grant);
    const objects = this.#objectRows(set, grant);
    if (status === SET_STATUS.ACTIVE
      && recipients.some(row => row.missingActor || row.problemCount > 0 || row.status !== RECIPIENT_STATUS.ACTIVE)) {
      status = SET_STATUS.PARTIAL;
    }
    const lastSync = latest?.lastSync ?? null;

    return {
      ...context,
      missing: false,
      set,
      status,
      statusLabel: setStatusLabel(status),
      grantId: latest?.grantId ?? "",
      hasActiveGrant: Boolean(grant),
      recipients,
      objects,
      recipientCount: recipients.length,
      objectCount: objects.length,
      activeRecipients: recipients.filter(row => row.canRevoke).length,
      lastSyncAt: latest?.lastSyncAt ?? null,
      lastSyncLabel: formatDateTime(latest?.lastSyncAt),
      lastSyncSummary: syncSummaryText(lastSync),
      lastSyncErrors: Array.isArray(lastSync?.errors) ? lastSync.errors.slice(0, 5) : [],
      updatedLabel: formatDateTime(set.updatedAt),
      activatedLabel: formatDateTime(set.lastActivatedAt),
      hasObjects: objects.length > 0,
      hasRecipients: recipients.length > 0,
      canActivate: !grant && objects.length > 0 && recipients.length > 0
    };
  }

  #recipientRows(set, grant) {
    if (!grant) {
      return set.recipients.map(uuid => {
        const actor = findActorSync(uuid);
        return {
          uuid,
          name: actor?.name ?? uuid,
          img: actor?.img ?? DEFAULT_SET_ICON,
          status: "draft",
          statusLabel: game.i18n.localize("JELI.RecipientStatus.NotActive"),
          granted: 0,
          total: set.objects.length,
          problemCount: 0,
          canRevoke: false,
          missingActor: !actor
        };
      });
    }

    const rows = [];
    for (const [uuid, record] of Object.entries(grant.recipients ?? {})) {
      if (record.status === RECIPIENT_STATUS.REVOKED) continue;
      const actor = findActorSync(uuid);
      const state = evaluateRecipient(actor, record, {
        setId: set.id,
        grantId: grant.grantId,
        objects: set.objects
      });
      rows.push({
        uuid,
        name: actor?.name ?? record.actorName ?? uuid,
        img: actor?.img ?? DEFAULT_SET_ICON,
        status: state.status,
        statusLabel: recipientStatusLabel(state.status),
        granted: state.granted,
        total: state.total,
        problemCount: state.problems,
        canRevoke: Boolean(actor),
        missingActor: !actor
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  #objectRows(set, grant) {
    const recipients = grant
      ? Object.entries(grant.recipients ?? {}).filter(([, record]) => record.status !== RECIPIENT_STATUS.REVOKED)
      : [];
    return set.objects.map(object => {
      let granted = 0;
      let problems = 0;
      for (const [uuid, record] of recipients) {
        const instance = record.objects?.[object.id];
        if (!instance
          || instance.status === INSTANCE_STATUS.REVOKED
          || instance.status === INSTANCE_STATUS.SKIPPED) continue;
        const actor = findActorSync(uuid);
        if (!actor) {
          problems += 1;
          continue;
        }
        const check = verifyInstance(actor, instance, {
          setId: set.id,
          grantId: grant.grantId,
          templateObjectId: object.id
        });
        if (check.ok) granted += 1;
        else problems += 1;
      }
      return {
        id: object.id,
        name: object.name,
        img: objectIcon(object),
        typeLabel: itemTypeLabel(object.type, object.documentType),
        granted,
        total: recipients.length,
        problems
      };
    });
  }

  static _onEditSet() {
    new SetEditorApp({ setId: this.setId }).render({ force: true });
  }

  static async _onActivate() {
    if (this.busy || !this.set) return;
    const result = await SyncPreviewApp.open({ set: this.set, mode: SYNC_MODE.ADD });
    if (result) this.render({ force: true });
  }

  static async _onSynchronize() {
    if (this.busy || !this.set) return;
    const result = await SyncPreviewApp.open({ set: this.set, mode: defaultSyncMode() });
    if (result) this.render({ force: true });
  }

  static async _onRevokeSet() {
    if (this.busy || !this.set) return;
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.SetTitle",
      content: game.i18n.format("JELI.Revoke.SetConfirm", { name: this.set.name }),
      yesKey: "JELI.Revoke.Confirm",
      danger: true
    });
    if (!confirmed) return;
    this.busy = true;
    try {
      const result = await revocationManager.revokeSet(this.set);
      if (result.noGrant) notifyWarn(game.i18n.localize("JELI.Revoke.NoActiveGrant"));
      else notifySummary(result.summary, { revoked: true });
      emitSetChanged(this.setId);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static async _onRevokeRecipient(event, target) {
    if (this.busy || !this.set) return;
    const actorUuid = target.dataset.actorUuid;
    if (!actorUuid) return;
    const name = findActorSync(actorUuid)?.name
      ?? this.element.querySelector(`[data-actor-uuid="${actorUuid}"]`)?.dataset.actorName
      ?? actorUuid;
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.RecipientTitle",
      content: game.i18n.format("JELI.Revoke.RecipientConfirm", { name, set: this.set.name }),
      yesKey: "JELI.Revoke.Confirm",
      danger: true
    });
    if (!confirmed) return;
    this.busy = true;
    try {
      const result = await revocationManager.revokeRecipient(this.set, actorUuid);
      if (result.noRecipient) notifyWarn(game.i18n.localize("JELI.Revoke.NoRecipient"));
      else notifySummary(result.summary, { revoked: true });
      emitSetChanged(this.setId);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static async _onCopyLink() {
    if (this.set) await showLinkDialog(this.set);
  }

  static _onClose() {
    this.close();
  }
}

export async function openSetManagement(setId) {
  if (!game.user.isGM) {
    notifyWarn(game.i18n.localize("JELI.Link.PlayerDenied"));
    return null;
  }
  try {
    await setManager.initialize();
  } catch (err) {
    notifyError(err.message);
    return null;
  }
  const set = setManager.getSet(setId);
  if (!set) {
    ui.notifications.error(game.i18n.format("JELI.Link.MissingSet", { id: setId }));
    return null;
  }
  return SetManagementApp.open(setId);
}
