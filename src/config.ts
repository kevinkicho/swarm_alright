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

export function loadApiKey(explicit?: string): string {
  const key =
    explicit ??
    process.env.OLLAMA_API_KEY ??
    fromDotenv(path.resolve(".env")) ??
    fromDotenv(path.join(os.homedir(), ".swarm", ".env"))
  if (!key) {
    throw new Error(
      "No Ollama Cloud API key found. Set OLLAMA_API_KEY, pass --api-key, or put it in .env / ~/.swarm/.env",
    )
  }
  return key
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
