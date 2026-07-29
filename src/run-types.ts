/**
 * Shared types for the swarm run loop (kept free of I/O).
 */
import type { Models } from "./config.ts"
import type { SessionProbeMeta } from "./session-probe.ts"

export type RunOptions = {
  project: string
  directive?: string
  models: Models
  maxCycles?: number
  apiKey?: string
  /** Continue a previous run by reusing its id, worktrees, and run folder. */
  resumeFrom?: string
}

export type AgentRef = {
  role: "system" | "worker"
  directory: string
  sessionID: string
  model: string
}

export type ShipResult = {
  cycle: number
  committed: boolean
  ahead: number
  rehomed: number
  verify?: { ok: boolean; exit: number | null; output: string }
}

export type RunPaths = {
  runId: string
  runDir: string
  project: string
  missionFile: string
  dialogueFile: string
  standardsFile: string
  workerSessionFile: string
  /** First-class engineer assignment written by the system lead. */
  handoffFile: string
  /** Append-only prior handoffs (work history). */
  handoffHistoryFile: string
  /** Host inventory map for system investigation. */
  materialsFile: string
  metricsFile: string
  eventsLogFile: string
  memoryFile: string
  /** Directory of archived WORKER_SESSION dumps. */
  sessionsDir: string
  sessionIndexFile: string
  shipLogFile: string
  baseBranch: string
  integrationBranch: string
  workerBranch: string
  workerWorktree: string
}

/** Host control from system reply. Empty = default continue + merge. */
export type HostSignal = "CONTINUE" | "DONE" | "STOP" | "REPASS" | "HOLD" | ""

export type ReviewPack = {
  pack: string
  sections: string[]
  anyCommits: boolean
}

export type { SessionProbeMeta }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
