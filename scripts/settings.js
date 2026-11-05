import { MODULE_ID } from "./constants.js";

export function registerSettings() {
  game.settings.register(MODULE_ID, "debug", {
    name: "JELI.Settings.Debug.Name",
    hint: "JELI.Settings.Debug.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "defaultSyncMode", {
    name: "JELI.Settings.DefaultSyncMode.Name",
    hint: "JELI.Settings.DefaultSyncMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      add: "JELI.SyncMode.Add",
      apply: "JELI.SyncMode.Apply",
      full: "JELI.SyncMode.Full"
    },
    default: "apply"
  });

  game.settings.register(MODULE_ID, "createDuplicateCopies", {
    name: "JELI.Settings.CreateDuplicateCopies.Name",
    hint: "JELI.Settings.CreateDuplicateCopies.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

export function defaultSyncMode() {
  try {
    return game.settings.get(MODULE_ID, "defaultSyncMode") || "apply";
  } catch {
    return "apply";
  }
}

export function allowDuplicateCopies() {
  try {
    return game.settings.get(MODULE_ID, "createDuplicateCopies") === true;
  } catch {
    return false;
  }
}
