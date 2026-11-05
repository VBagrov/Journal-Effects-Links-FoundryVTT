import { openGlobalManager } from "../applications/global-manager.js";

const BUTTON_CLASS = "jeli-effect-sets-button";
const ROOT_SELECTORS = [
  "#journal",
  '.sidebar-tab[data-tab="journal"]',
  '.tab[data-tab="journal"]'
];

function journalDirectory() {
  return game.journal?.directory
    ?? globalThis.ui?.sidebar?.tabs?.journal
    ?? globalThis.ui?.journal
    ?? null;
}

function createButton() {
  const label = game.i18n.localize("JELI.Button.Label");
  const button = document.createElement("button");
  button.type = "button";
  button.className = `jeli-directory-button ${BUTTON_CLASS}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-wand-magic-sparkles";
  const text = document.createElement("span");
  text.textContent = label;
  button.append(icon, text);
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    void openGlobalManager();
  });
  return button;
}

function addButton(root) {
  if (!game.user?.isGM) return;
  if (!root?.querySelector || root.querySelector(`.${BUTTON_CLASS}`)) return;
  const header = root.querySelector(".directory-header, .window-header, header");
  if (!header) {
    const host = document.createElement("div");
    host.className = "jeli-directory-host";
    host.appendChild(createButton());
    root.prepend(host);
    return;
  }
  const host = header.querySelector(".header-actions, .action-buttons, .window-controls") ?? header;
  host.appendChild(createButton());
}

function refresh() {
  const roots = new Set();
  const app = journalDirectory();
  if (app?.element) roots.add(app.element);
  for (const selector of ROOT_SELECTORS) {
    document.querySelectorAll(selector).forEach(element => roots.add(element));
  }
  for (const root of roots) addButton(root);
}

export function registerJournalDirectoryButton() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  };

  Hooks.on("renderJournalDirectory", schedule);
  Hooks.on("renderApplicationV2", schedule);
  Hooks.on("renderApplication", schedule);

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  refresh();
}
