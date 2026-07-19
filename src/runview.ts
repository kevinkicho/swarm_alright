import * as Registry from "./registry.ts"
import { wrapText } from "./pick.ts"

/** Detail-panel lines for a run record, wrapped to the given width. */
export function runDetail(r: Registry.RunRecord, width: number): string[] {
  const workers = r.workers ?? r.agents?.filter((a) => a.role === "worker").length
  const lines = [
    `status:    ${Registry.effectiveStatus(r)}`,
    `cycle:     ${r.cycle}`,
    `started:   ${r.startedAt.replace("T", " ").slice(0, 19)} UTC`,
    `agents:    planner + auditor + ${workers ?? "?"} worker(s)`,
    `planner:   ${r.models.planner}`,
    `worker:    ${r.models.worker}`,
    `auditor:   ${r.models.auditor}`,
    "",
    "project:",
    ...wrapText(r.project, width).map((l) => `  ${l}`),
    "",
    "directive:",
    ...wrapText(r.directive ?? "(none — planner inferred the mission)", width).map((l) => `  ${l}`),
  ]
  return lines
}
