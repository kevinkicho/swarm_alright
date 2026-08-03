/**
 * Consolidated run-directory path helpers.
 * Every `(runDir: string) => string` path function lives here.
 * Original modules re-export for backward compatibility.
 */
import path from "node:path"

// --- Materials ---
export function materialsPath(runDir: string): string {
  return path.join(runDir, "MATERIALS.md")
}
export function handoffHistoryPath(runDir: string): string {
  return path.join(runDir, "HANDOFF_HISTORY.md")
}
export function metricsFilePath(runDir: string): string {
  return path.join(runDir, "metrics.jsonl")
}
export function eventsLogPath(runDir: string): string {
  return path.join(runDir, "events.log")
}

// --- Prompts ---
export function backlogPath(runDir: string): string {
  return path.join(runDir, "BACKLOG.md")
}
export function exceptionFilePath(runDir: string): string {
  return path.join(runDir, "EXCEPTION.md")
}

// --- Run log ---
export function sessionsDir(runDir: string): string {
  return path.join(runDir, "sessions")
}
export function memorySnapshotsDir(runDir: string): string {
  return path.join(runDir, "memory")
}
export function shipsDir(runDir: string): string {
  return path.join(runDir, "ships")
}
export function sessionIndexPath(runDir: string): string {
  return path.join(runDir, "SESSION_INDEX.md")
}
export function shipLogPath(runDir: string): string {
  return path.join(runDir, "SHIP_LOG.md")
}

// --- Event bus ---
export function busJsonlPath(runDir: string): string {
  return path.join(runDir, "BUS.jsonl")
}
export function busMdPath(runDir: string): string {
  return path.join(runDir, "BUS.md")
}

// --- Host git ---
export function baselinePath(runDir: string): string {
  return path.join(runDir, "BASELINE.sha")
}

// --- Memory ---
export function memoryPath(runDir: string): string {
  return path.join(runDir, "MEMORY.md")
}
export function dialoguePath(runDir: string): string {
  return path.join(runDir, "DIALOGUE.md")
}
export function missionPath(runDir: string): string {
  return path.join(runDir, "MISSION.md")
}
