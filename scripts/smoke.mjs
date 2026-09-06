import { EFFORT_ORDER, fetchRadarSnapshot } from "../src/radar.js";

const snapshot = await fetchRadarSnapshot();
const availableEfforts = new Set(snapshot.models.flatMap((model) => model.efforts.map(({ effort }) => effort)));
const efforts = [
  ...EFFORT_ORDER.filter((effort) => availableEfforts.has(effort)),
  ...[...availableEfforts].filter((effort) => !EFFORT_ORDER.includes(effort)).sort(),
];
const rows = snapshot.models.map((model) => {
  const scores = new Map(model.efforts.map((effort) => [effort.effort, effort.iq]));
  return {
    model: model.label,
    runtime: model.runtimeLabel,
    overall: model.iq ?? "—",
    ...Object.fromEntries(efforts.map((effort) => [effort, scores.get(effort) ?? "—"])),
  };
});

console.log(
  `Codex Radar ${snapshot.benchmarkId}: ${snapshot.models.length} models, ` +
    `${new Set(snapshot.models.map((model) => model.runtime)).size} runtimes, ${snapshot.taskCount} tasks, ` +
    `${snapshot.comboCount} monitored model/effort combinations`,
);
console.table(rows);
