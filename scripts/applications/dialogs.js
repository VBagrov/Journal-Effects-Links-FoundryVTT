import { CHANGE_HOOK } from "../constants.js";
import { copyToClipboard, escapeHtml, linkForSet } from "../utils/display.js";
import { notifyError, notifyInfo, notifyWarn } from "../utils/logger.js";

const { DialogV2 } = foundry.applications.api;

function localize(key) {
  return game.i18n.localize(key);
}

export async function confirmAction({ titleKey, content, yesKey = "JELI.Common.Confirm", danger = false }) {
  const result = await DialogV2.confirm({
    window: { title: localize(titleKey) },
    classes: danger ? ["jeli-dialog", "jeli-dialog-danger"] : ["jeli-dialog"],
    content,
    yes: {
      label: localize(yesKey),
      icon: danger ? "fa-solid fa-triangle-exclamation" : "fa-solid fa-check",
      default: true
    },
    no: {
      label: localize("JELI.Common.Cancel"),
      icon: "fa-solid fa-xmark"
    },
    rejectClose: false
  });
  return result === true;
}

export async function chooseAction({ titleKey, content, buttons = [] }) {
  return DialogV2.wait({
    window: { title: localize(titleKey) },
    classes: ["jeli-dialog"],
    content,
    buttons: buttons.map(button => ({
      action: button.action,
      label: localize(button.labelKey),
      icon: button.icon,
      default: button.default === true
    })),
    rejectClose: false
  });
}

export async function showLinkDialog(set) {
  const link = linkForSet(set);
  const content = `
    <div class="jeli-link-dialog">
      <p>${localize("JELI.Link.Hint")}</p>
      <input type="text" readonly value="${escapeHtml(link)}">
      <p class="notes">${localize("JELI.Link.StabilityHint")}</p>
    </div>`;
  const choice = await DialogV2.wait({
    window: { title: localize("JELI.Link.Title") },
    classes: ["jeli-dialog"],
    content,
    buttons: [
      {
        action: "copy",
        label: localize("JELI.Link.Copy"),
        icon: "fa-solid fa-copy",
        default: true
      },
      {
        action: "close",
        label: localize("JELI.Common.Close"),
        icon: "fa-solid fa-xmark"
      }
    ],
    rejectClose: false
  });
  if (choice !== "copy") return false;
  const copied = await copyToClipboard(link);
  if (copied) notifyInfo(localize("JELI.Link.Copied"));
  else notifyWarn(localize("JELI.Link.CopyFailed"));
  return copied;
}

export function notifySummary(summary, { activated = false, revoked = false } = {}) {
  if (!summary) return;
  const counts = {
    created: summary.created ?? 0,
    removed: summary.removed ?? 0,
    updated: summary.updated ?? 0,
    skipped: summary.skipped ?? 0,
    failed: summary.failed ?? 0,
    conflicts: summary.conflicts ?? 0
  };
  const key = revoked
    ? "JELI.Summary.Revoked"
    : activated
      ? "JELI.Summary.ActivationDone"
      : "JELI.Summary.SyncDone";
  const message = game.i18n.format(key, counts);
  if (counts.failed > 0 || counts.conflicts > 0) notifyWarn(message);
  else notifyInfo(message);

  const errors = Array.isArray(summary.errors) ? summary.errors.slice(0, 3) : [];
  for (const error of errors) notifyError(error);
  if (Array.isArray(summary.errors) && summary.errors.length > errors.length) {
    notifyError(game.i18n.format("JELI.Summary.MoreErrors", {
      count: summary.errors.length - errors.length
    }));
  }
}

export function emitSetChanged(setId = null) {
  Hooks.callAll(CHANGE_HOOK, { setId });
}
