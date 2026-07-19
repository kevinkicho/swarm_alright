import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * Start a run as a detached, console-less background process.
 * It survives any terminal closing; only `swarm stop` (or Ctrl+C-free crash) ends it.
 */
export function spawnDetachedRun(cliArgs: string[]): number {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url))
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  })
  child.unref()
  return child.pid ?? 0
}
