import { DEFAULT_SET_ICON } from "../constants.js";
import { evaluateRecipient } from "../core/document-validator.js";
import { getActiveGrant } from "../core/grant-registry.js";
import { setManager } from "../core/services.js";
import { createSetDraft } from "../core/set-manager.js";
import { defaultSyncMode } from "../settings.js";
import {
  bindDropTarget,
  importWorldItem,
  resolveDroppedTemplateObject
} from "../integrations/drag-drop.js";
import {
  formatDateTime,
  isDefaultPlayerCharacter,
  isNpcActor,
  itemTypeLabel,
  objectIcon,
  ownerLabel,
  recipientStatusLabel,
  sourceLabel
} from "../utils/display.js";
import { notifyError, notifyInfo, notifyWarn } from "../utils/logger.js";
import { confirmAction, emitSetChanged, showLinkDialog } from "./dialogs.js";
import { SyncPreviewApp } from "./synchronization-preview.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SetEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "jeli-set-editor",
    classes: ["jeli-app", "jeli-set-editor"],
    tag: "form",
    window: {
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true,
      minimizable: true
    },
    position: { width: 1160, height: 820 },
    actions: {
      save: SetEditorApp._onSave,
      cancel: SetEditorApp._onCancel,
      openBrowser: SetEditorApp._onOpenBrowser,
      closeBrowser: SetEditorApp._onCloseBrowser,
      browseAdd: SetEditorApp._onBrowseAdd,
      removeObject: SetEditorApp._onRemoveObject,
      moveObject: SetEditorApp._onMoveObject,
      pickIcon: SetEditorApp._onPickIcon,
      copyLink: SetEditorApp._onCopyLink,
      selectPlayers: SetEditorApp._onSelectPlayers,
      clearRecipients: SetEditorApp._onClearRecipients
    }
  };

  static PARTS = {
    body: {
      template: "modules/journal-effects-links/templates/set-editor.hbs",
      scrollable: [".jeli-editor-body"]
    }
  };

  constructor(options = {}) {
    const setId = options.setId ?? null;
    super({ ...options, id: options.id ?? `jeli-set-editor-${setId ?? "new"}` });
    this.setId = setId;
    this.set = null;
    this.browsing = false;
    this.showNpcs = false;
    this.dirty = false;
    this.dropTarget = null;
    this.missing = false;
  }

  get title() {
    if (this.set?.name) {
      return game.i18n.format("JELI.Editor.WindowTitle", { name: this.set.name });
    }
    return game.i18n.localize(this.setId ? "JELI.Editor.TitleEdit" : "JELI.Editor.TitleNew");
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this.set) await this.#loadDraft();
    if (!this.set) {
      this.missing = true;
      return { ...context, missing: true };
    }
    this.missing = false;

    const registry = await setManager.loadRegistry();
    const grant = getActiveGrant(registry, this.set.id);
    const actorOptions = this.#buildActorOptions(grant);
    if (actorOptions.some(option => option.selected && option.npc)) this.showNpcs = true;

    return {
      ...context,
      missing: false,
      set: this.set,
      isEdit: Boolean(this.setId),
      updatedLabel: formatDateTime(this.set.updatedAt),
      hasActiveGrant: Boolean(grant),
      primaryLabelKey: grant ? "JELI.Editor.ApplyChanges" : "JELI.Editor.Save",
      objects: this.#buildObjectRows(),
      actorOptions,
      selectedCount: this.set.recipients.length,
      browsing: this.browsing,
      browseItems: this.#buildBrowseItems(),
      showNpcs: this.showNpcs
    };
  }

  async #loadDraft() {
    try {
      await setManager.initialize();
    } catch (err) {
      notifyError(err.message);
      this.close();
      return;
    }
    if (this.setId) {
      const set = setManager.getSet(this.setId);
      if (!set) {
        notifyError(game.i18n.format("JELI.Error.SetNotFound", { id: this.setId }));
        this.close();
        return;
      }
      this.set = set;
      if (!this.set.img) this.set.img = DEFAULT_SET_ICON;
    } else {
      this.set = createSetDraft();
    }
    this.dirty = false;
  }

  #buildObjectRows() {
    return this.set.objects.map((object, index) => ({
      id: object.id,
      name: object.name,
      img: objectIcon(object),
      typeLabel: itemTypeLabel(object.type, object.documentType),
      sourceLabel: sourceLabel(object.sourceUuid),
      first: index === 0,
      last: index === this.set.objects.length - 1
    }));
  }

  #buildActorOptions(grant = null) {
    const selected = new Set(this.set.recipients);
    const options = [];
    for (const actor of game.actors?.contents ?? []) {
      const record = grant?.recipients?.[actor.uuid] ?? null;
      const state = record && this.set.id
        ? evaluateRecipient(actor, record, {
          setId: this.set.id,
          grantId: grant.grantId,
          objects: this.set.objects
        })
        : null;
      options.push({
        uuid: actor.uuid,
        name: actor.name,
        img: actor.img,
        npc: isNpcActor(actor),
        default: isDefaultPlayerCharacter(actor),
        selected: selected.has(actor.uuid),
        ownerLabel: ownerLabel(actor),
        typeLabel: actor.type,
        search: actor.name.toLowerCase(),
        missing: false,
        hasGrant: Boolean(state),
        grantStatus: state?.status ?? "",
        grantStatusLabel: state ? recipientStatusLabel(state.status) : ""
      });
    }
    for (const uuid of selected) {
      if (options.some(option => option.uuid === uuid)) continue;
      options.push({
        uuid,
        name: uuid,
        img: DEFAULT_SET_ICON,
        npc: false,
        default: false,
        selected: true,
        ownerLabel: "",
        typeLabel: "",
        search: "",
        missing: true,
        hasGrant: false,
        grantStatus: "",
        grantStatusLabel: ""
      });
    }
    options.sort((a, b) =>
      (Number(b.default) - Number(a.default))
      || (Number(a.npc) - Number(b.npc))
      || a.name.localeCompare(b.name)
    );
    return options;
  }

  #buildBrowseItems() {
    if (!this.browsing) return [];
    return (game.items?.contents ?? []).map(item => ({
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      typeLabel: itemTypeLabel(item.type, "Item"),
      search: item.name.toLowerCase()
    }));
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (this.missing) return;

    this.dropTarget?.unbind?.();
    this.dropTarget = bindDropTarget(this.element, event => this.#onDrop(event));

    const root = this.element;
    root.addEventListener("submit", event => event.preventDefault());
    for (const input of root.querySelectorAll("[data-jeli-field]")) {
      input.addEventListener("input", () => {
        this.dirty = true;
      });
    }
    for (const input of root.querySelectorAll("[data-jeli-recipient]")) {
      input.addEventListener("change", () => {
        this.dirty = true;
        this.#filterActors();
      });
    }

    root.querySelector("[data-jeli-actor-search]")?.addEventListener("input", () => this.#filterActors());
    root.querySelector("[data-jeli-browse-search]")?.addEventListener("input", () => this.#filterBrowse());

    const npcToggle = root.querySelector("[data-jeli-show-npcs]");
    if (npcToggle) {
      npcToggle.addEventListener("change", () => {
        this.showNpcs = npcToggle.checked;
        this.#filterActors();
      });
    }

    this.#filterActors();
    this.#filterBrowse();
  }

  #applyFormValues() {
    const root = this.element;
    if (!root) return;
    const name = root.querySelector('[data-jeli-field="name"]');
    if (name) this.set.name = name.value.trim();
    const description = root.querySelector('[data-jeli-field="description"]');
    if (description) this.set.description = description.value;
    const img = root.querySelector('[data-jeli-field="img"]');
    if (img) this.set.img = img.value.trim() || DEFAULT_SET_ICON;
    const recipients = [...root.querySelectorAll("[data-jeli-recipient]")]
      .filter(input => input.checked)
      .map(input => input.value);
    this.set.recipients = [...new Set(recipients)];
  }

  #filterActors() {
    const root = this.element;
    if (!root) return;
    const query = (root.querySelector("[data-jeli-actor-search]")?.value ?? "").toLowerCase();
    for (const row of root.querySelectorAll(".jeli-actor-row")) {
      const matches = !query || (row.dataset.search ?? "").includes(query);
      const isNpc = row.dataset.npc === "true";
      const isSelected = row.querySelector("input[data-jeli-recipient]")?.checked === true;
      row.hidden = !(matches && (this.showNpcs || !isNpc || isSelected));
    }
  }

  #filterBrowse() {
    const root = this.element;
    if (!root) return;
    const query = (root.querySelector("[data-jeli-browse-search]")?.value ?? "").toLowerCase();
    for (const row of root.querySelectorAll(".jeli-browse-row")) {
      row.hidden = Boolean(query) && !(row.dataset.search ?? "").includes(query);
    }
  }

  async #onDrop(event) {
    const result = await resolveDroppedTemplateObject(event);
    if (!result) return;
    if (result.unsupported) {
      notifyWarn(game.i18n.format("JELI.Error.UnsupportedDocument", { type: result.unsupported }));
      return;
    }
    this.#applyFormValues();
    const row = event.target.closest?.("[data-object-id]");
    if (row) {
      const existing = this.set.objects.find(object => object.id === row.dataset.objectId);
      if (existing) {
        Object.assign(existing, result.object, {
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: Date.now()
        });
        notifyInfo(game.i18n.localize("JELI.Editor.ObjectReplaced"));
      }
    } else {
      this.set.objects.push(result.object);
    }
    if (result.convertedFromEffect) {
      notifyInfo(game.i18n.localize("JELI.Editor.EffectImportedAsItem"));
    }
    this.dirty = true;
    await this.render({ force: true });
  }

  static async _onSave() {
    this.#applyFormValues();
    if (!this.set.name.trim()) {
      notifyWarn(game.i18n.localize("JELI.Error.NameRequired"));
      return;
    }
    if (!this.set.objects.length) {
      const proceed = await confirmAction({
        titleKey: "JELI.Editor.EmptyTitle",
        content: game.i18n.localize("JELI.Editor.EmptyConfirm"),
        yesKey: "JELI.Editor.SaveDraft"
      });
      if (!proceed) return;
    }

    try {
      await setManager.saveSet(this.set);
      this.dirty = false;
      const registry = await setManager.loadRegistry();
      const grant = getActiveGrant(registry, this.set.id);
      emitSetChanged(this.set.id);
      notifyInfo(game.i18n.localize("JELI.Editor.Saved"));
      const snapshot = foundry.utils.deepClone(this.set);
      this.close();
      if (grant) {
        void SyncPreviewApp.open({ set: snapshot, mode: defaultSyncMode() });
      }
    } catch (err) {
      notifyError(err.message);
    }
  }

  static async _onCancel() {
    if (!this.dirty) {
      this.close();
      return;
    }
    const confirmed = await confirmAction({
      titleKey: "JELI.Editor.DiscardTitle",
      content: game.i18n.localize("JELI.Editor.DiscardConfirm"),
      yesKey: "JELI.Editor.Discard",
      danger: true
    });
    if (confirmed) this.close();
  }

  static _onOpenBrowser() {
    this.#applyFormValues();
    this.browsing = true;
    this.render({ force: true });
  }

  static _onCloseBrowser() {
    this.browsing = false;
    this.render({ force: true });
  }

  static async _onBrowseAdd(event, target) {
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    this.#applyFormValues();
    const object = await importWorldItem(uuid);
    if (!object) return;
    this.set.objects.push(object);
    this.dirty = true;
    await this.render({ force: true });
  }

  static async _onRemoveObject(event, target) {
    this.#applyFormValues();
    const objectId = target.closest("[data-object-id]")?.dataset.objectId;
    if (!objectId) return;
    this.set.objects = this.set.objects.filter(object => object.id !== objectId);
    this.dirty = true;
    await this.render({ force: true });
  }

  static async _onMoveObject(event, target) {
    this.#applyFormValues();
    const row = target.closest("[data-object-id]");
    if (!row) return;
    const index = this.set.objects.findIndex(object => object.id === row.dataset.objectId);
    if (index < 0) return;
    const delta = Number(target.dataset.direction) || 0;
    const next = index + delta;
    if (next < 0 || next >= this.set.objects.length) return;
    const [moved] = this.set.objects.splice(index, 1);
    this.set.objects.splice(next, 0, moved);
    this.dirty = true;
    await this.render({ force: true });
  }

  static _onPickIcon() {
    this.#applyFormValues();
    const FilePickerClass = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    if (!FilePickerClass) return;
    new FilePickerClass({
      type: "image",
      current: this.set.img,
      callback: path => {
        this.set.img = path;
        this.dirty = true;
        this.render({ force: true });
      }
    }).browse();
  }

  static async _onCopyLink() {
    if (!this.setId) {
      notifyWarn(game.i18n.localize("JELI.Link.SaveFirst"));
      return;
    }
    await showLinkDialog(this.set);
  }

  static _onSelectPlayers() {
    this.#applyFormValues();
    for (const input of this.element.querySelectorAll("[data-jeli-recipient]")) {
      if (input.closest(".jeli-actor-row")?.dataset.default === "true") {
        input.checked = true;
      }
    }
    this.dirty = true;
    this.#filterActors();
  }

  static _onClearRecipients() {
    for (const input of this.element.querySelectorAll("[data-jeli-recipient]")) {
      input.checked = false;
    }
    this.dirty = true;
    this.#filterActors();
  }
}
