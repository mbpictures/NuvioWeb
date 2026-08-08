export function catalogSupportsExtra(catalog = {}, name = "") {
  const target = String(name || "")
    .trim()
    .toLowerCase();
  if (!target) return false;
  return (
    Array.isArray(catalog.extra) &&
    catalog.extra.some(
      (entry) =>
        String(entry?.name || "")
          .trim()
          .toLowerCase() === target
    )
  );
}

export function buildSearchTargets(addons = []) {
  const targets = [];
  addons.forEach((addon) => {
    (addon.catalogs || []).forEach((catalog) => {
      if (!catalogSupportsExtra(catalog, "search")) return;
      targets.push({
        addonBaseUrl: addon.baseUrl,
        addonId: addon.id,
        addonName: addon.displayName,
        catalogId: catalog.id,
        catalogName: catalog.name,
        type: catalog.apiType,
        supportsSkip: catalogSupportsExtra(catalog, "skip")
      });
    });
  });
  return targets;
}
