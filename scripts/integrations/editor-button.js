import { setManager } from "../core/services.js";
import { openGlobalManager } from "../applications/global-manager.js";
import { escapeHtml, linkForSet } from "../utils/display.js";
import { notifyInfo, notifyWarn } from "../utils/logger.js";

const { DialogV2 } = foundry.applications.api;

const BUTTON_CLASS = "jeli-insert-link";

function editorContent(editorElement) {
  return editorElement?.querySelector(".editor-content .ProseMirror")
    ?? editorElement?.querySelector(".editor-content")
    ?? editorElement;
}

function saveSelection(editorElement) {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const content = editorContent(editorElement);
  return content?.contains?.(range.commonAncestorContainer) ? range : null;
}

function restoreSelection(content, range) {
  const selection = document.getSelection();
  if (!selection) return false;
  if (range && content?.contains(range.commonAncestorContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  if (selection.rangeCount && content?.contains(selection.anchorNode)) return true;

  const fallback = document.createRange();
  fallback.selectNodeContents(content);
  fallback.collapse(false);
  selection.removeAllRanges();
  selection.addRange(fallback);
  return true;
}

/**
 * Insert link syntax at the caret captured before the dialog was opened.
 * Writing to `<prose-mirror>.value` does not refresh the live ProseMirror
 * view, so the text has to go through the contenteditable DOM instead.
 */
function insertLink(editorElement, link, savedRange = null) {
  const content = editorContent(editorElement);
  if (!content) return false;
  content.focus?.();
  restoreSelection(content, savedRange);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, link);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    const selection = document.getSelection();
    const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (liveRange && content.contains(liveRange.commonAncestorContainer)) {
      liveRange.deleteContents();
      const node = document.createTextNode(link);
      liveRange.insertNode(node);
      liveRange.setStartAfter(node);
      liveRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(liveRange);
      inserted = true;
    }
  }

  if (!inserted) {
    content.appendChild(document.createTextNode(link));
  }

  editorElement.dispatchEvent(new Event("input", { bubbles: true }));
  editorElement.dispatchEvent(new Event("change", { bubbles: true }));
  content.focus?.();
  return true;
}

async function openEffectLinkDialog(editorElement, savedRange = null) {
  if (!editorElement) return;
  try {
    await setManager.initialize();
  } catch (err) {
    notifyWarn(err.message);
    return;
  }

  const sets = setManager.getSets();
  if (!sets.length) {
    notifyWarn(game.i18n.localize("JELI.EditorButton.NoSets"));
    await openGlobalManager();
    return;
  }

  const options = sets
    .map(set => `<option value="${escapeHtml(set.id)}">${escapeHtml(set.name || set.id)}</option>`)
    .join("");
  const content = `
    <div class="jeli-link-dialog">
      <p>${game.i18n.localize("JELI.EditorButton.Hint")}</p>
      <label class="jeli-field">
        <span>${game.i18n.localize("JELI.EditorButton.SelectSet")}</span>
        <select name="setId">${options}</select>
      </label>
      <p class="notes">${game.i18n.localize("JELI.EditorButton.ManagerHint")}</p>
    </div>`;

  const choice = await DialogV2.wait({
    window: { title: game.i18n.localize("JELI.EditorButton.Title") },
    classes: ["jeli-dialog"],
    content,
    buttons: [
      {
        action: "insert",
        label: game.i18n.localize("JELI.EditorButton.Insert"),
        icon: "fa-solid fa-wand-magic-sparkles",
        default: true,
        callback: (event, button, dialog) => ({
          action: "insert",
          setId: dialog.element.querySelector('[name="setId"]')?.value ?? null
        })
      },
      {
        action: "manager",
        label: game.i18n.localize("JELI.EditorButton.OpenManager"),
        icon: "fa-solid fa-folder-tree",
        callback: () => ({ action: "manager" })
      },
      {
        action: "cancel",
        label: game.i18n.localize("JELI.Common.Cancel"),
        icon: "fa-solid fa-xmark",
        callback: () => ({ action: "cancel" })
      }
    ],
    rejectClose: false
  });

  if (!choice || choice.action === "cancel") return;
  if (choice.action === "manager") {
    await openGlobalManager();
    return;
  }
  if (!choice.setId) return;
  const set = setManager.getSet(choice.setId);
  if (!set) {
    notifyWarn(game.i18n.localize("JELI.Error.SetNotFoundGeneric"));
    return;
  }
  if (insertLink(editorElement, linkForSet(set), savedRange)) {
    notifyInfo(game.i18n.localize("JELI.EditorButton.Inserted"));
  } else {
    notifyWarn(game.i18n.localize("JELI.EditorButton.InsertFailed"));
  }
}

export function registerEditorButton() {
  const addEditorButton = root => {
    if (!game.user?.isGM) return;
    if (!root) return;
    const menus = [];
    if (root.matches?.("prose-mirror")) {
      const menu = root.querySelector(".editor-menu");
      if (menu) menus.push(menu);
    }
    menus.push(...root.querySelectorAll("prose-mirror .editor-menu"));

    for (const menu of new Set(menus)) {
      if (menu.querySelector(`.${BUTTON_CLASS}`)) continue;
      const linkButton = menu.querySelector('button[data-action="link"]');
      if (!linkButton) continue;

      const item = document.createElement("li");
      item.className = "text";

      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      const label = game.i18n.localize("JELI.EditorButton.Label");
      button.title = label;
      button.setAttribute("aria-label", label);
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-wand-magic-sparkles";
      button.appendChild(icon);

      // Keep the caret inside the editor when the toolbar button is pressed.
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => {
        const editor = button.closest("prose-mirror");
        void openEffectLinkDialog(editor, saveSelection(editor));
      });

      item.appendChild(button);
      linkButton.closest("li")?.after(item);
    }
  };

  const refresh = () => {
    document.querySelectorAll("prose-mirror").forEach(addEditorButton);
  };

  Hooks.on("renderJournalEntryPageSheet", () => requestAnimationFrame(refresh));
  Hooks.on("renderApplication", () => requestAnimationFrame(refresh));
  Hooks.on("renderApplicationV2", () => requestAnimationFrame(refresh));

  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("focusin", event => {
    const editor = event.target.closest?.("prose-mirror");
    if (editor) addEditorButton(editor);
  });

  refresh();
}
