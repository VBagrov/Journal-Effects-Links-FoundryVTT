import { SYNC_MODE } from "../constants.js";
import { grantManager, setManager } from "../core/services.js";
import {
  computePlan,
  planModeHintKey,
  planModeLabelKey
} from "../core/synchronization.js";
import { allowDuplicateCopies } from "../settings.js";
import { documentTypeLabel } from "../utils/display.js";
import { notifyError } from "../utils/logger.js";
import { emitSetChanged, notifySummary } from "./dialogs.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function reasonLabel(reason) {
  if (!reason) return "";
  const key = `JELI.Reason.${reason}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : String(reason);
}

export class SyncPreviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "jeli-sync-preview",
    classes: ["jeli-app", "jeli-sync-preview"],
    tag: "div",
    window: {
      title: "JELI.Preview.Title",
      icon: "fa-solid fa-arrows-rotate",
      resizable: true,
      minimizable: true
    },
    position: { width: 780, height: 700 },
    actions: {
      confirm: SyncPreviewApp._onConfirm,
      cancel: SyncPreviewApp._onCancel
    }
  };

  static PARTS = {
    body: {
      template: "modules/journal-effects-links/templates/synchronization-preview.hbs",
      scrollable: [".jeli-preview-body"]
    }
  };

  static open({ set, mode = SYNC_MODE.APPLY }) {
    return new Promise(resolve => {
      const app = new SyncPreviewApp({ set, mode, resolve });
      app.render({ force: true });
    });
  }

  constructor(options = {}) {
    super({ ...options, id: options.id ?? `jeli-sync-preview-${foundry.utils.randomID(6)}` });
    this.set = options.set ?? null;
    this.mode = options.mode ?? SYNC_MODE.APPLY;
    this.busy = false;
    this.settled = false;
    this.resolvePromise = options.resolve ?? null;
  }

  _settle(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    let plan = null;
    let error = "";
    try {
      const registry = await setManager.loadRegistry();
      if (!registry) error = game.i18n.localize("JELI.Error.RegistryCorrupt");
      else plan = computePlan(this.set, registry, this.mode);
    } catch (err) {
      error = err.message;
    }

    const modes = [SYNC_MODE.ADD, SYNC_MODE.APPLY, SYNC_MODE.FULL].map(mode => ({
      id: mode,
      label: game.i18n.localize(planModeLabelKey(mode)),
      hint: game.i18n.localize(planModeHintKey(mode)),
      selected: mode === this.mode
    }));

    const decorate = list => (list ?? []).map(item => ({
      ...item,
      typeLabel: item.documentType ? documentTypeLabel(item.documentType) : ""
    }));

    const withReason = list => (list ?? []).map(item => ({
      ...item,
      reasonLabel: reasonLabel(item.reason)
    }));

    return {
      ...context,
      set: this.set,
      plan,
      error,
      modes,
      activate: plan?.activate === true,
      hasWork: plan?.hasWork !== false,
      confirmLabelKey: plan?.activate ? "JELI.Preview.Activate" : "JELI.Preview.Apply",
      addRecipients: plan?.recipientsToAdd ?? [],
      removeRecipients: plan?.recipientsToRemove ?? [],
      addObjects: decorate(plan?.objectsToAdd),
      removeObjects: decorate(plan?.objectsToRemove),
      updateObjects: decorate(plan?.objectsToUpdate),
      missingInstances: withReason(plan?.missingInstances),
      conflicts: withReason(plan?.conflicts),
      skippedExisting: plan?.skippedExisting ?? [],
      missingActors: plan?.missingActors ?? [],
      duplicatesDisabled: !allowDuplicateCopies(),
      totals: plan?.totals ?? { create: 0, remove: 0, update: 0, keep: 0, skip: 0 }
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const input of this.element.querySelectorAll('input[name="jeli-sync-mode"]')) {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        this.mode = input.value;
        this.render({ force: true });
      });
    }
  }

  async _onClose(options) {
    this._settle(null);
    return super._onClose(options);
  }

  static async _onConfirm(event, target) {
    if (this.busy) return;
    this.busy = true;
    try {
      const { summary, activated } = await grantManager.sync(this.set, this.mode);
      notifySummary(summary, { activated });
      emitSetChanged(this.set.id);
      this._settle(summary);
      this.close();
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static _onCancel() {
    this._settle(null);
    this.close();
  }
}
