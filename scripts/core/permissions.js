export function isGM() {
  return game.user?.isGM === true;
}

export function assertGM() {
  if (!isGM()) throw new Error(game.i18n.localize("JELI.Error.NotGM"));
}

export function assertRegistryUsable(registryOk, registryMissing = false) {
  if (!registryOk) {
    throw new Error(game.i18n.localize(
      registryMissing ? "JELI.Error.RegistryMissing" : "JELI.Error.RegistryCorrupt"
    ));
  }
}
