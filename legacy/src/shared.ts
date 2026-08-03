/**
 * Shared utility functions used by multiple CLI/UI modules.
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

/** Interactive readline question — resolves with trimmed answer. */
export function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim())
    }),
  )
}

/** Fetch available model names from Ollama Cloud API. */
export async function fetchModels(apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch("https://ollama.com/api/tags", {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    })
    if (!res.ok) throw new Error()
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    return (data.models ?? []).map((m) => m.name)
  } catch {
    return []
  }
}

/** Read the last N non-empty lines from a run's events.log. */
export function lastLogLines(runDir: string, n = 8): string[] {
  try {
    return fs
      .readFileSync(path.join(runDir, "events.log"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-n)
  } catch {
    return []
  }
}
