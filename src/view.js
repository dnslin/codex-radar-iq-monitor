export function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function valueDelta(previous, current) {
  if (!isNumber(previous) || !isNumber(current)) return null;
  return current - previous;
}

export function hasLowCoverage(sampledTaskCount, taskCount) {
  return isNumber(sampledTaskCount) && taskCount > 0 && sampledTaskCount / taskCount < 0.6;
}

export function runtimeOptions(models) {
  const runtimes = new Map();
  for (const model of models) {
    const option = runtimes.get(model.runtime);
    if (option) option.count += 1;
    else runtimes.set(model.runtime, {
      value: model.runtime,
      label: model.runtimeLabel,
      count: 1,
    });
  }
  return [...runtimes.values()];
}

export function selectModels(models, { query = "", runtime = "", sort = "iq" } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const selected = models.filter((model) => {
    if (runtime && model.runtime !== runtime) return false;
    const searchable = [model.label, model.id, model.modelId, model.runtime, model.runtimeLabel]
      .join(" ").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });

  if (sort === "name") {
    selected.sort((left, right) => left.label.localeCompare(right.label, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    }));
  } else if (sort === "iq") {
    selected.sort((left, right) => {
      const leftIq = isNumber(left.iq) ? left.iq : -Infinity;
      const rightIq = isNumber(right.iq) ? right.iq : -Infinity;
      return leftIq === rightIq ? 0 : rightIq - leftIq;
    });
  }
  return selected;
}
