import { EFFORT_ORDER, fetchRadarSnapshot } from "../src/radar.js";

const snapshot = await fetchRadarSnapshot();
const rows = snapshot.models.map((model) => {
  const efforts = new Map(model.efforts.map((effort) => [effort.effort, effort.iq]));
  return {
    model: model.label,
    overall: model.iq ?? "—",
    ...Object.fromEntries(EFFORT_ORDER.map((effort) => [effort, efforts.get(effort) ?? "—"])),
  };
});

console.log(
  `Codex Radar ${snapshot.benchmarkId}: ${snapshot.taskCount} tasks, ` +
    `${snapshot.comboCount} monitored model/effort combinations`,
);
console.table(rows);
