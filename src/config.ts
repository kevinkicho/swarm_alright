import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export const PROVIDER_ID = "ollama"

export type Models = { planner: string; worker: string; auditor: string }

export const DEFAULT_MODELS: Models = {
  planner: "deepseek-v4-flash",
  worker: "deepseek-v4-flash",
  auditor: "gemma4:31b",
}

// Context/output token limits for known Ollama Cloud models (used by opencode for compaction).
const KNOWN_LIMITS: Record<string, { context: number; output: number }> = {
  "deepseek-v4-flash": { context: 1_000_000, output: 64_000 },
  "deepseek-v4-pro": { context: 1_000_000, output: 64_000 },
  "gemma4:31b": { context: 262_144, output: 16_384 },
  "nemotron-3-nano:30b": { context: 262_144, output: 16_384 },
  "nemotron-3-nano:4b": { context: 131_072, output: 16_384 },
}

function fromDotenv(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf8")
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*OLLAMA_API_KEY\s*=\s*(.+?)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, "")
    }
  } catch {}
  return undefined
}

/** Install root when launched via `swarm` / node src/cli.ts (works from any cwd). */
function installRoots(): string[] {
  const roots: string[] = []
  if (process.env.SWARM_HOME) roots.push(path.resolve(process.env.SWARM_HOME))
  // node .../swarm_alright/src/cli.ts  →  .../swarm_alright
  try {
    const argv1 = process.argv[1]
    if (argv1) {
      const dir = path.dirname(path.resolve(argv1))
      // src/ or bin/
      const parent = path.basename(dir) === "src" || path.basename(dir) === "bin" ? path.dirname(dir) : dir
      roots.push(parent)
    }
  } catch {}
  return [...new Set(roots)]
}

/**
 * Resolve Ollama Cloud API key. Search order (first hit wins):
 * 1. explicit argument / --api-key
 * 2. OLLAMA_API_KEY env
 * 3. .env in cwd
 * 4. SWARM_HOME/.env and install-root/.env (so `swarm` works from any folder)
 * 5. ~/.swarm/.env
 * 6. optional projectDir/.env and projectDir/.swarm/.env
 */
export function loadApiKey(explicit?: string, projectDir?: string): string {
  const candidates: Array<string | undefined> = [
    explicit,
    process.env.OLLAMA_API_KEY,
    fromDotenv(path.resolve(".env")),
  ]
  for (const root of installRoots()) {
    candidates.push(fromDotenv(path.join(root, ".env")))
    candidates.push(fromDotenv(path.join(root, ".swarm", ".env")))
  }
  candidates.push(fromDotenv(path.join(os.homedir(), ".swarm", ".env")))
  if (projectDir) {
    const p = path.resolve(projectDir)
    candidates.push(fromDotenv(path.join(p, ".env")))
    candidates.push(fromDotenv(path.join(p, ".swarm", ".env")))
  }

  for (const key of candidates) {
    if (key) return key
  }
  throw new Error(
    "No Ollama Cloud API key found. Set OLLAMA_API_KEY, pass --api-key, or put OLLAMA_API_KEY=... in:\n" +
      "  - .env (current directory)\n" +
      "  - %SWARM_HOME%\\.env (swarm install)\n" +
      "  - ~/.swarm/.env\n" +
      "  - <project>/.env or <project>/.swarm/.env",
  )
}

/** Strip an optional "ollama/" prefix; the provider id is always "ollama". */
export function bareModel(id: string): string {
  return id.startsWith(`${PROVIDER_ID}/`) ? id.slice(PROVIDER_ID.length + 1) : id
}

export function qualifiedModel(id: string): string {
  return `${PROVIDER_ID}/${bareModel(id)}`
}

/** Build the opencode config injected via OPENCODE_CONFIG_CONTENT. */
export function opencodeConfig(apiKey: string, modelIDs: string[]) {
  const models: Record<string, unknown> = {}
  for (const raw of modelIDs) {
    const id = bareModel(raw)
    models[id] = {
      name: id,
      tool_call: true,
      reasoning: true,
      limit: KNOWN_LIMITS[id] ?? { context: 131_072, output: 16_384 },
    }
  }
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [PROVIDER_ID],
    model: qualifiedModel(modelIDs[0]),
    small_model: qualifiedModel(modelIDs[0]),
    share: "disabled",
    autoupdate: false,
    // OpenCode owns compaction (not a host "compact at 45%" loop).
    // prune frees old tool outputs; auto triggers near usable context limit.
    compaction: {
      auto: true,
      prune: true,
      tail_turns: 1,
    },
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "allow",
    },
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama Cloud",
        options: {
          baseURL: "https://ollama.com/v1",
          apiKey,
        },
        models,
      },
    },
  }
}

export function registryDir(): string {
  return path.join(os.homedir(), ".swarm", "runs")
}
