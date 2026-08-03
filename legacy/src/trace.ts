/**
 * Lightweight error tracing — replaces empty catch {} blocks.
 * Writes to stderr with [swarm:trace] prefix. Never throws.
 */
let enabled = true

export function setTraceEnabled(on: boolean): void {
  enabled = on
}

export function trace(label: string, err: unknown): void {
  if (!enabled) return
  try {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[swarm:trace] ${label}: ${msg}\n`)
  } catch {
    // trace must never throw
  }
}
