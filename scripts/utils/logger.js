import { MODULE_ID } from "../constants.js";

const PREFIX = `${MODULE_ID} |`;

function debugEnabled() {
  try {
    return game.settings.get(MODULE_ID, "debug") === true;
  } catch {
    return false;
  }
}

export function log(...args) {
  console.log(PREFIX, ...args);
}

export function debug(...args) {
  if (debugEnabled()) console.debug(PREFIX, ...args);
}

export function warn(...args) {
  console.warn(PREFIX, ...args);
}

export function error(...args) {
  console.error(PREFIX, ...args);
}

export function notifyError(message) {
  ui.notifications.error(String(message));
}

export function notifyWarn(message) {
  ui.notifications.warn(String(message));
}

export function notifyInfo(message) {
  ui.notifications.info(String(message));
}
