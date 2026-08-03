import * as Registry from "./registry.ts"
import { wrapText } from "./pick.ts"
import { Style } from "./style.ts"

/** Detail-panel lines for a run record, wrapped to the given width. */
export function runDetail(r: Registry.RunRecord, width: number): string[] {
  const lines = [
    Style.kv("status:", Style.status(Registry.effectiveStatus(r))),
    Style.kv("cycle:", Style.cyan(String(r.cycle))),
    Style.kv("started:", Style.muted(r.startedAt.replace("T", " ").slice(0, 19) + " UTC")),
    Style.kv("agents:", `system + worker`),
    Style.kv("system:", Style.muted(r.models.system)),
    Style.kv("worker:", Style.muted(r.models.worker)),
    "",
    Style.bold("project:"),
    ...wrapText(r.project, width).map((l) => `  ${l}`),
    "",
    Style.bold("directive:"),
    ...wrapText(r.directive ?? "(none — system inferred the mission)", width).map((l) => `  ${Style.muted(l)}`),
  ]
  return lines
}