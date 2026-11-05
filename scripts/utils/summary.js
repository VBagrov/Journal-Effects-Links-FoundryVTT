export function createSummary() {
  return {
    created: 0,
    removed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    conflicts: 0,
    removedRecipients: 0,
    errors: []
  };
}

export function mergeSummary(target, source) {
  for (const key of ["created", "removed", "updated", "skipped", "failed", "conflicts", "removedRecipients"]) {
    target[key] = (target[key] ?? 0) + (source[key] ?? 0);
  }
  if (Array.isArray(source.errors)) target.errors.push(...source.errors);
  return target;
}

export function summarizeTotals(summary) {
  return game.i18n.format("JELI.Summary.Line", {
    created: summary.created ?? 0,
    removed: summary.removed ?? 0,
    updated: summary.updated ?? 0,
    failed: summary.failed ?? 0
  });
}
