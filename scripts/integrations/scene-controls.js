import { openGlobalManager } from "../applications/global-manager.js";

const TOOL_NAME = "journal-effects-links-manager";

export function registerSceneControlButton() {
  Hooks.on("getSceneControlButtons", controls => {
    if (!game.user?.isGM) return;
    const group = controls?.tokens ?? controls?.basic;
    if (!group?.tools || group.tools[TOOL_NAME]) return;
    group.tools[TOOL_NAME] = {
      name: TOOL_NAME,
      order: 100,
      title: "JELI.SceneControl.OpenManager",
      icon: "fa-solid fa-wand-magic-sparkles",
      button: true,
      visible: true,
      onChange: () => {
        void openGlobalManager();
      }
    };
  });
}
