import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { setManager, grantManager, revocationManager } from "./core/services.js";
import { registerSettings } from "./settings.js";
import {
  registerEffectLinkEnricher,
  registerEffectLinkClickHandler
} from "./integrations/journal-enricher.js";
import { registerJournalDirectoryButton } from "./integrations/journal-directory.js";
import { registerEditorButton } from "./integrations/editor-button.js";
import { registerSceneControlButton } from "./integrations/scene-controls.js";
import { getSystemInfo } from "./integrations/dnd5e.js";
import { openGlobalManager } from "./applications/global-manager.js";
import { openSetManagement } from "./applications/set-management.js";
import { debug, log, error as logError } from "./utils/logger.js";

Hooks.once("init", () => {
  const steps = [
    ["settings", registerSettings],
    ["enricher", registerEffectLinkEnricher],
    ["journal directory button", registerJournalDirectoryButton],
    ["editor link button", registerEditorButton],
    ["scene control button", registerSceneControlButton],
    ["link click handler", registerEffectLinkClickHandler]
  ];
  for (const [label, step] of steps) {
    try {
      step();
    } catch (err) {
      logError(`Failed to register ${label}`, err);
    }
  }

  const system = getSystemInfo();
  log(`${MODULE_TITLE} initialized`, {
    systemId: system.id,
    systemVersion: system.version,
    dnd5e: system.isDnD5e
  });
});

Hooks.once("ready", async () => {
  if (game.user?.isGM) {
    try {
      await setManager.initialize();
      debug("Storage journal ready");
    } catch (err) {
      logError("Unable to initialize storage", err);
    }
  }

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      openGlobalManager,
      openSetManagement,
      setManager,
      grantManager,
      revocationManager
    };
  }
});
