import {
  CHANGE_HOOK,
  DEFAULT_SET_ICON,
  INSTANCE_STATUS,
  RECIPIENT_STATUS,
  SET_STATUS,
  SYNC_MODE
} from "../constants.js";
import {
  createEmptyRegistry,
  deriveSetStatus,
  getActiveGrant
} from "../core/grant-registry.js";
import { applyRepairPlan, buildRepairPlan } from "../core/registry-repair.js";
import { revocationManager, setManager } from "../core/services.js";
import { evaluateRecipient, verifyInstance } from "../core/document-validator.js";
import { defaultSyncMode } from "../settings.js";
import { findJournalLocation, openJournalLocation } from "../integrations/journal-location.js";
import { cloneTemplateObject } from "../utils/serialization.js";
import { createSetId } from "../utils/uuid.js";
import { mergeSummary, createSummary } from "../utils/summary.js";
import {
  escapeHtml,
  findActorSync,
  formatDateTime,
  instanceStatusLabel,
  operationLabel,
  recipientStatusLabel,
  resultLabel,
  setStatusLabel
} from "../utils/display.js";
import { notifyError, notifyInfo, notifyWarn } from "../utils/logger.js";
import {
  chooseAction,
  confirmAction,
  emitSetChanged,
  notifySummary,
  showLinkDialog
} from "./dialogs.js";
import { openSetManagement } from "./set-management.js";
import { SetEditorApp } from "./set-editor.js";
import { SyncPreviewApp } from "./synchronization-preview.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function summaryLine(summary) {
  if (!summary) return "";
  return game.i18n.format("JELI.Summary.Line", {
    created: summary.created ?? 0,
    removed: summary.removed ?? 0,
    updated: summary.updated ?? 0,
    failed: summary.failed ?? 0
  });
}

export class GlobalManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "jeli-global-manager",
    classes: ["jeli-app", "jeli-global-manager"],
    tag: "div",
    window: {
      title: "JELI.Manager.Title",
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true,
      minimizable: true
    },
    position: { width: 1040, height: 780 },
    actions: {
      createSet: GlobalManagerApp._onCreateSet,
      refresh: GlobalManagerApp._onRefresh,
      switchTab: GlobalManagerApp._onSwitchTab,
      openSet: GlobalManagerApp._onOpenSet,
      editSet: GlobalManagerApp._onEditSet,
      activateSet: GlobalManagerApp._onActivateSet,
      syncSet: GlobalManagerApp._onSyncSet,
      revokeSet: GlobalManagerApp._onRevokeSet,
      revokeRecipient: GlobalManagerApp._onRevokeRecipient,
      revokeActor: GlobalManagerApp._onRevokeActor,
      revokeOrphan: GlobalManagerApp._onRevokeOrphan,
      copyLink: GlobalManagerApp._onCopyLink,
      duplicateSet: GlobalManagerApp._onDuplicateSet,
      deleteSet: GlobalManagerApp._onDeleteSet,
      revokeAll: GlobalManagerApp._onRevokeAll,
      findJournal: GlobalManagerApp._onFindJournal,
      repairRegistry: GlobalManagerApp._onRepairRegistry
    }
  };

  static PARTS = {
    body: {
      template: "modules/journal-effects-links/templates/global-manager.hbs",
      scrollable: [".jeli-manager-body"]
    }
  };

  constructor(options = {}) {
    super(options);
    this.tab = "sets";
    this.search = "";
    this.statusFilter = "all";
    this.sort = "updated-desc";
    this.busy = false;
    this.searchTimer = null;
    this.hooked = false;
    this.onSetChanged = () => this.render({ force: true });
  }

  async _onClose(options) {
    clearTimeout(this.searchTimer);
    Hooks.off(CHANGE_HOOK, this.onSetChanged);
    this.hooked = false;
    return super._onClose(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!game.user.isGM) {
      this.close();
      return { ...context, notAllowed: true, tabs: [], sets: [], activeGrants: [], issues: [], history: [] };
    }

    try {
      await setManager.initialize();
    } catch (err) {
      notifyError(err.message);
    }

    const registry = await setManager.loadRegistry() ?? createEmptyRegistry();
    const allSets = setManager.getSets();
    const rows = allSets.map(set => this.#prepareSetRow(set, registry));
    const visibleRows = this.#filterAndSort(rows);
    const activeGrants = this.#activeGrants(allSets, registry);
    const issues = this.#issues(allSets, registry);
    const history = this.#history(registry);

    const tabs = [
      { id: "sets", label: game.i18n.localize("JELI.Manager.TabSets"), count: rows.length, active: this.tab === "sets" },
      { id: "grants", label: game.i18n.localize("JELI.Manager.TabGrants"), count: activeGrants.length, active: this.tab === "grants" },
      { id: "issues", label: game.i18n.localize("JELI.Manager.TabIssues"), count: issues.length, active: this.tab === "issues" },
      { id: "history", label: game.i18n.localize("JELI.Manager.TabHistory"), count: history.length, active: this.tab === "history" }
    ];

    const statusFilters = [
      { value: "all", label: game.i18n.localize("JELI.Manager.AllStatuses"), selected: this.statusFilter === "all" },
      ...Object.values(SET_STATUS).map(status => ({
        value: status,
        label: setStatusLabel(status),
        selected: this.statusFilter === status
      }))
    ];

    const sortOptions = [
      { value: "updated-desc", label: game.i18n.localize("JELI.Manager.SortUpdatedDesc"), selected: this.sort === "updated-desc" },
      { value: "updated-asc", label: game.i18n.localize("JELI.Manager.SortUpdatedAsc"), selected: this.sort === "updated-asc" },
      { value: "name-asc", label: game.i18n.localize("JELI.Manager.SortNameAsc"), selected: this.sort === "name-asc" },
      { value: "name-desc", label: game.i18n.localize("JELI.Manager.SortNameDesc"), selected: this.sort === "name-desc" },
      { value: "status", label: game.i18n.localize("JELI.Manager.SortStatus"), selected: this.sort === "status" }
    ];

    return {
      ...context,
      notAllowed: false,
      tabs,
      isSets: this.tab === "sets",
      isGrants: this.tab === "grants",
      isIssues: this.tab === "issues",
      isHistory: this.tab === "history",
      search: this.search,
      statusFilters,
      sortOptions,
      sets: visibleRows,
      totalSets: rows.length,
      activeGrants,
      issues,
      history,
      registryIssue: !setManager.registryOk || setManager.registryMissing
    };
  }

  #prepareSetRow(set, registry) {
    let status = deriveSetStatus(set, registry);
    const entry = registry.sets?.[set.id] ?? null;
    const grant = entry?.activeGrantId ? entry.generations?.[entry.activeGrantId] : null;
    const activeRecipients = grant
      ? Object.values(grant.recipients ?? {}).filter(record => record.status !== RECIPIENT_STATUS.REVOKED)
      : [];
    let grantedCount = 0;
    let liveProblems = 0;
    if (grant) {
      for (const [uuid, record] of Object.entries(grant.recipients ?? {})) {
        if (record.status === RECIPIENT_STATUS.REVOKED) continue;
        const state = evaluateRecipient(findActorSync(uuid), record, {
          setId: set.id,
          grantId: grant.grantId,
          objects: set.objects
        });
        grantedCount += state.granted;
        if (state.status !== RECIPIENT_STATUS.ACTIVE) liveProblems += 1;
      }
    }
    if (status === SET_STATUS.ACTIVE && liveProblems > 0) status = SET_STATUS.PARTIAL;
    return {
      id: set.id,
      name: set.name || set.id,
      description: set.description || "",
      img: set.img || DEFAULT_SET_ICON,
      status,
      statusLabel: setStatusLabel(status),
      objectCount: set.objects?.length ?? 0,
      recipientCount: set.recipients?.length ?? 0,
      activeRecipientCount: activeRecipients.length,
      grantedCount,
      hasActiveGrant: Boolean(grant),
      canActivate: !grant && (set.objects?.length ?? 0) > 0 && (set.recipients?.length ?? 0) > 0,
      updatedAt: set.updatedAt ?? 0,
      updatedLabel: formatDateTime(set.updatedAt),
      activatedLabel: formatDateTime(set.lastActivatedAt),
      search: `${set.name} ${set.description}`.toLowerCase()
    };
  }

  #filterAndSort(rows) {
    const query = this.search.trim().toLowerCase();
    let result = rows;
    if (query) result = result.filter(row => row.search.includes(query));
    if (this.statusFilter !== "all") result = result.filter(row => row.status === this.statusFilter);

    switch (this.sort) {
      case "name-asc":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "updated-asc":
        result.sort((a, b) => a.updatedAt - b.updatedAt);
        break;
      case "status":
        result.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));
        break;
      default:
        result.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return result;
  }

  #activeGrants(sets, registry) {
    const setMap = new Map(sets.map(set => [set.id, set]));
    const results = [];
    for (const [setId, entry] of Object.entries(registry.sets ?? {})) {
      const grant = entry.activeGrantId ? entry.generations?.[entry.activeGrantId] : null;
      if (!grant || grant.status === "revoked") continue;
      const set = setMap.get(setId);
      const recipients = Object.values(grant.recipients ?? {})
        .filter(record => record.status !== RECIPIENT_STATUS.REVOKED)
        .map(record => {
          const actor = findActorSync(record.actorUuid);
          const state = evaluateRecipient(actor, record, {
            setId,
            grantId: grant.grantId,
            objects: set?.objects ?? null
          });
          return {
            setId,
            uuid: record.actorUuid,
            name: actor?.name ?? record.actorName ?? record.actorUuid,
            img: actor?.img ?? DEFAULT_SET_ICON,
            status: state.status,
            statusLabel: recipientStatusLabel(state.status),
            granted: state.granted,
            total: state.total,
            problemCount: state.problems + state.missing,
            canRevoke: Boolean(actor)
          };
        });
      results.push({
        setId,
        setName: set?.name ?? game.i18n.format("JELI.Manager.OrphanSetName", { id: setId }),
        orphaned: !set,
        status: grant.status,
        statusLabel: setStatusLabel(grant.status),
        grantId: grant.grantId,
        activatedLabel: formatDateTime(grant.activatedAt),
        recipients
      });
    }
    return results;
  }

  #issues(sets, registry) {
    const issues = [];
    if (!setManager.registryOk) {
      issues.push({
        kind: "corrupt",
        setName: game.i18n.localize("JELI.Issue.RegistryTitle"),
        message: game.i18n.localize("JELI.Issue.RegistryCorrupt"),
        canRepair: true
      });
    } else if (setManager.registryMissing) {
      issues.push({
        kind: "missing",
        setName: game.i18n.localize("JELI.Issue.RegistryTitle"),
        message: game.i18n.localize("JELI.Issue.RegistryMissing"),
        canRepair: true
      });
    }

    const setMap = new Map(sets.map(set => [set.id, set]));
    for (const [setId, entry] of Object.entries(registry.sets ?? {})) {
      const set = setMap.get(setId);
      const grant = entry.activeGrantId ? entry.generations?.[entry.activeGrantId] : null;
      if (!grant) continue;

      if (!set) {
        issues.push({
          kind: "orphan",
          setId,
          setName: game.i18n.format("JELI.Manager.OrphanSetName", { id: setId }),
          message: game.i18n.localize("JELI.Issue.OrphanGrant"),
          canRevokeOrphan: true
        });
      }

      for (const record of Object.values(grant.recipients ?? {})) {
        if (record.status === RECIPIENT_STATUS.REVOKED) continue;
        const actor = findActorSync(record.actorUuid);
        if (record.status === RECIPIENT_STATUS.MISSING_ACTOR || !actor) {
          issues.push({
            kind: "missing-actor",
            setId,
            setName: set?.name ?? setId,
            message: game.i18n.format("JELI.Issue.MissingActor", {
              actor: record.actorName || record.actorUuid
            })
          });
          continue;
        }
        for (const [objectId, instance] of Object.entries(record.objects ?? {})) {
          if (instance.status === INSTANCE_STATUS.REVOKED
            || instance.status === INSTANCE_STATUS.SKIPPED) continue;
          const check = verifyInstance(actor, instance, {
            setId,
            grantId: grant.grantId,
            templateObjectId: objectId
          });
          if (check.ok) continue;
          let status;
          if (check.reason === "no-document") status = INSTANCE_STATUS.MISSING;
          else if (check.reason === "no-record") status = INSTANCE_STATUS.MISSING;
          else status = INSTANCE_STATUS.CONFLICT;
          const template = set?.objects?.find(object => object.id === objectId);
          issues.push({
            kind: status,
            setId,
            setName: set?.name ?? setId,
            message: game.i18n.format("JELI.Issue.Instance", {
              actor: actor.name,
              object: instance.name || template?.name || objectId,
              status: instanceStatusLabel(status),
              error: instance.error ?? ""
            })
          });
        }
      }
    }
    return issues;
  }

  #history(registry) {
    return (registry.history ?? []).slice(0, 200).map(entry => ({
      ...entry,
      timeLabel: formatDateTime(entry.ts),
      operationLabel: operationLabel(entry.operation),
      resultLabel: resultLabel(entry.result),
      summaryLine: summaryLine(entry.summary)
    }));
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (context.notAllowed) return;
    if (!this.hooked) {
      Hooks.on(CHANGE_HOOK, this.onSetChanged);
      this.hooked = true;
    }
    const root = this.element;

    const search = root.querySelector("[data-jeli-search]");
    if (search) {
      search.value = this.search;
      search.addEventListener("input", () => {
        const value = search.value;
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(async () => {
          this.search = value;
          await this.render({ force: true });
          const input = this.element.querySelector("[data-jeli-search]");
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        }, 180);
      });
    }

    root.querySelector("[data-jeli-status-filter]")?.addEventListener("change", event => {
      this.statusFilter = event.target.value;
      this.render({ force: true });
    });
    root.querySelector("[data-jeli-sort]")?.addEventListener("change", event => {
      this.sort = event.target.value;
      this.render({ force: true });
    });
  }

  static _onCreateSet() {
    new SetEditorApp().render({ force: true });
  }

  static _onRefresh() {
    this.render({ force: true });
  }

  static _onSwitchTab(event, target) {
    const tab = target.dataset.tab;
    if (!tab || tab === this.tab) return;
    this.tab = tab;
    this.render({ force: true });
  }

  static async _onOpenSet(event, target) {
    await openSetManagement(target.dataset.setId);
  }

  static _onEditSet(event, target) {
    new SetEditorApp({ setId: target.dataset.setId }).render({ force: true });
  }

  static async _onActivateSet(event, target) {
    if (this.busy) return;
    const set = setManager.getSet(target.dataset.setId);
    if (!set) {
      notifyWarn(game.i18n.localize("JELI.Error.SetNotFoundGeneric"));
      return;
    }
    const result = await SyncPreviewApp.open({ set, mode: SYNC_MODE.ADD });
    if (result) this.render({ force: true });
  }

  static async _onSyncSet(event, target) {
    const set = setManager.getSet(target.dataset.setId);
    if (!set) return;
    await SyncPreviewApp.open({ set, mode: defaultSyncMode() });
    this.render({ force: true });
  }

  static async _onRevokeSet(event, target) {
    if (this.busy) return;
    const set = setManager.getSet(target.dataset.setId);
    if (!set) return;
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.SetTitle",
      content: game.i18n.format("JELI.Revoke.SetConfirm", { name: set.name }),
      yesKey: "JELI.Revoke.Confirm",
      danger: true
    });
    if (!confirmed) return;
    this.busy = true;
    try {
      const result = await revocationManager.revokeSet(set);
      if (result.noGrant) notifyInfo(game.i18n.localize("JELI.Revoke.NoActiveGrant"));
      else notifySummary(result.summary, { revoked: true });
      emitSetChanged(set.id);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static async _onRevokeRecipient(event, target) {
    if (this.busy) return;
    const setId = target.dataset.setId;
    const actorUuid = target.dataset.actorUuid;
    const set = setManager.getSet(setId);
    if (!set || !actorUuid) return;
    const name = findActorSync(actorUuid)?.name ?? actorUuid;
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.RecipientTitle",
      content: game.i18n.format("JELI.Revoke.RecipientConfirm", { name, set: set.name }),
      yesKey: "JELI.Revoke.Confirm",
      danger: true
    });
    if (!confirmed) return;
    this.busy = true;
    try {
      const result = await revocationManager.revokeRecipient(set, actorUuid);
      if (result.noRecipient) notifyInfo(game.i18n.localize("JELI.Revoke.NoRecipient"));
      else notifySummary(result.summary, { revoked: true });
      emitSetChanged(set.id);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static async _onRevokeActor(event, target) {
    if (this.busy) return;
    const actorUuid = target.dataset.actorUuid;
    if (!actorUuid) return;
    const name = findActorSync(actorUuid)?.name ?? actorUuid;
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.ActorTitle",
      content: game.i18n.format("JELI.Revoke.ActorConfirm", { name }),
      yesKey: "JELI.Revoke.Confirm",
      danger: true
    });
    if (!confirmed) return;
    this.busy = true;
    try {
      const results = await revocationManager.revokeActor(actorUuid);
      if (!results.length) {
        notifyInfo(game.i18n.localize("JELI.Revoke.ActorNone"));
        return;
      }
      const aggregate = createSummary();
      for (const result of results) if (result.summary) mergeSummary(aggregate, result.summary);
      notifySummary(aggregate, { revoked: true });
      emitSetChanged(null);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static async _onCopyLink(event, target) {
    const set = setManager.getSet(target.dataset.setId);
    if (set) await showLinkDialog(set);
  }

  static async _onDuplicateSet(event, target) {
    const set = setManager.getSet(target.dataset.setId);
    if (!set) return;
    const copy = foundry.utils.deepClone(set);
    copy.id = createSetId();
    copy.name = game.i18n.format("JELI.Manager.DuplicateName", { name: set.name });
    copy.createdAt = Date.now();
    copy.updatedAt = copy.createdAt;
    copy.lastActivatedAt = null;
    copy.lastSyncedAt = null;
    copy.journalLink = null;
    copy.objects = copy.objects.map(object => cloneTemplateObject(object));
    try {
      await setManager.saveSet(copy);
      notifyInfo(game.i18n.localize("JELI.Manager.Duplicated"));
      emitSetChanged(copy.id);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    }
  }

  static async _onDeleteSet(event, target) {
    if (this.busy) return;
    const set = setManager.getSet(target.dataset.setId);
    if (!set) return;
    const registry = await setManager.loadRegistry();
    const grant = getActiveGrant(registry, set.id);
    let mode = "retain";

    if (grant) {
      const choice = await chooseAction({
        titleKey: "JELI.Delete.Title",
        content: game.i18n.format("JELI.Delete.ActiveConfirm", { name: set.name }),
        buttons: [
          { action: "retain", labelKey: "JELI.Delete.Retain", icon: "fa-solid fa-box-archive", default: true },
          { action: "revoke", labelKey: "JELI.Delete.Revoke", icon: "fa-solid fa-trash" },
          { action: "cancel", labelKey: "JELI.Common.Cancel", icon: "fa-solid fa-xmark" }
        ]
      });
      if (!choice || choice === "cancel") return;
      mode = choice;
    } else {
      const confirmed = await confirmAction({
        titleKey: "JELI.Delete.Title",
        content: game.i18n.format("JELI.Delete.Confirm", { name: set.name }),
        yesKey: "JELI.Delete.ConfirmButton",
        danger: true
      });
      if (!confirmed) return;
    }

    this.busy = true;
    try {
      if (grant && mode === "revoke") {
        const result = await revocationManager.revokeSet(set);
        if (!result.noGrant) notifySummary(result.summary, { revoked: true });
      }
      await setManager.deleteSet(set.id);
      if (grant) await setManager.markOrphaned(set.id);
      notifyInfo(game.i18n.localize("JELI.Delete.Done"));
      emitSetChanged(set.id);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static async _onRevokeAll() {
    if (this.busy) return;
    const sets = setManager.getSets();
    const registry = await setManager.loadRegistry() ?? createEmptyRegistry();
    const activeSets = sets.filter(set => getActiveGrant(registry, set.id));
    const orphanActive = Object.entries(registry.sets ?? {})
      .filter(([setId, entry]) => entry.activeGrantId && !sets.some(set => set.id === setId))
      .length;
    const total = activeSets.length + orphanActive;
    if (!total) {
      notifyInfo(game.i18n.localize("JELI.Revoke.AllNone"));
      return;
    }
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.AllTitle",
      content: game.i18n.format("JELI.Revoke.AllConfirm", { count: total }),
      yesKey: "JELI.Revoke.AllConfirmButton",
      danger: true
    });
    if (!confirmed) return;

    this.busy = true;
    try {
      const results = await revocationManager.revokeAll();
      const aggregate = createSummary();
      for (const result of results) if (result.summary) mergeSummary(aggregate, result.summary);
      notifySummary(aggregate, { revoked: true });
      emitSetChanged(null);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    } finally {
      this.busy = false;
    }
  }

  static _onFindJournal(event, target) {
    const setId = target.dataset.setId;
    const location = findJournalLocation(setId);
    if (!location) {
      notifyWarn(game.i18n.localize("JELI.Manager.NoJournalLink"));
      return;
    }
    if (!openJournalLocation(location)) notifyWarn(game.i18n.localize("JELI.Manager.JournalOpenFailed"));
  }

  static async _onRepairRegistry() {
    const registry = await setManager.loadRegistry() ?? createEmptyRegistry();
    const plan = buildRepairPlan(registry);
    if (!plan.recovered.length) {
      notifyInfo(game.i18n.localize("JELI.Repair.None"));
      return;
    }
    const preview = plan.recovered.slice(0, 10).map(item =>
      `<li>${escapeHtml(item.documentName)} — ${escapeHtml(item.actorName)} <code>${escapeHtml(item.setId)}</code></li>`
    ).join("");
    const confirmed = await confirmAction({
      titleKey: "JELI.Repair.Title",
      content: `<p>${game.i18n.format("JELI.Repair.Confirm", { count: plan.recovered.length })}</p><ul>${preview}</ul>`,
      yesKey: "JELI.Repair.Apply"
    });
    if (!confirmed) return;
    try {
      const target = registry ?? createEmptyRegistry();
      const count = applyRepairPlan(target, plan);
      await setManager.saveRegistry(target);
      notifyInfo(game.i18n.format("JELI.Repair.Done", { count }));
      emitSetChanged(null);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    }
  }

  static async _onRevokeOrphan(event, target) {
    const setId = target.dataset.setId;
    if (!setId) return;
    const confirmed = await confirmAction({
      titleKey: "JELI.Revoke.OrphanTitle",
      content: game.i18n.format("JELI.Revoke.OrphanConfirm", { id: setId }),
      yesKey: "JELI.Revoke.Confirm",
      danger: true
    });
    if (!confirmed) return;
    try {
      const result = await revocationManager.revokeSet({ id: setId, name: setId });
      if (!result.noGrant) notifySummary(result.summary, { revoked: true });
      await setManager.clearOrphaned(setId);
      emitSetChanged(null);
      this.render({ force: true });
    } catch (err) {
      notifyError(err.message);
    }
  }
}

let managerInstance = null;

export async function openGlobalManager() {
  if (!game.user.isGM) {
    notifyWarn(game.i18n.localize("JELI.Link.PlayerDenied"));
    return null;
  }
  try {
    await setManager.initialize();
  } catch (err) {
    notifyError(err.message);
  }
  managerInstance ??= new GlobalManagerApp();
  managerInstance.render({ force: true });
  return managerInstance;
}
