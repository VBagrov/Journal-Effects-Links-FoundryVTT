export function findJournalLocation(setId) {
  const token = `@EffectLink[${setId}]`;
  for (const entry of game.journal?.contents ?? []) {
    for (const page of entry.pages?.contents ?? []) {
      const content = page.text?.content ?? "";
      if (content.includes(token)) return { entry, page };
    }
  }
  return null;
}

export function openJournalLocation(location) {
  if (!location?.entry) return false;
  try {
    location.entry.sheet.render({ force: true });
    if (location.page?.id) location.entry.sheet.goToPage?.(location.page.id);
    return true;
  } catch {
    return false;
  }
}
