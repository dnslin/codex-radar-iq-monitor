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

const PROVIDERS = [
  { info: { id: "openai", label: "ChatGPT", company: "OpenAI", aliases: ["GPT"] }, pattern: /^gpt(?:-|$)/ },
  { info: { id: "deepseek", label: "DeepSeek", company: "深度求索", aliases: [] }, pattern: /^(?:dsh-)?deepseek(?:-|$)/ },
  { info: { id: "anthropic", label: "Claude", company: "Anthropic", aliases: ["克劳德"] }, pattern: /^claude(?:-|$)/ },
  { info: { id: "google", label: "Gemini", company: "Google", aliases: ["谷歌"] }, pattern: /^gemini(?:-|$)/ },
  { info: { id: "xai", label: "Grok", company: "xAI", aliases: ["x.ai"] }, pattern: /^grok(?:-|$)/ },
  { info: { id: "moonshot", label: "Kimi", company: "月之暗面", aliases: ["Moonshot"] }, pattern: /^(?:kimi|k3)(?:-|$)/ },
  { info: { id: "zhipu", label: "GLM", company: "智谱", aliases: ["Zhipu", "BigModel"] }, pattern: /^glm(?:-|$)/ },
  { info: { id: "tencent", label: "混元", company: "腾讯", aliases: ["Tencent", "Hunyuan"] }, pattern: /^(?:hy4|hunyuan)(?:-|$)/ },
];

const OTHER_PROVIDER = { id: "other", label: "其他", company: "", aliases: [] };

export function modelProvider(model) {
  const modelId = String(model.modelId ?? model.id ?? "").toLowerCase();
  return PROVIDERS.find(({ pattern }) => pattern.test(modelId))?.info ?? OTHER_PROVIDER;
}

export function providerGroups(models) {
  const groups = new Map();
  for (const model of models) {
    const provider = modelProvider(model);
    if (!groups.has(provider.id)) groups.set(provider.id, { ...provider, models: [] });
    groups.get(provider.id).models.push(model);
  }
  return [...PROVIDERS.map(({ info }) => info), OTHER_PROVIDER]
    .map(({ id }) => groups.get(id))
    .filter(Boolean);
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

export function selectModels(models, { query = "", provider = "", runtime = "", sort = "iq" } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const selected = models.filter((model) => {
    const owner = modelProvider(model);
    if (provider && owner.id !== provider) return false;
    if (runtime && model.runtime !== runtime) return false;
    const searchable = [model.label, model.id, model.modelId, model.runtime, model.runtimeLabel,
      owner.label, owner.company, ...owner.aliases]
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
