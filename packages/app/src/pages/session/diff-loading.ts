import type { FileDiff } from "@opencode-ai/sdk/v2"
import { createRenderEffect } from "solid-js"

export function hasDetails(diff: Pick<FileDiff, "before" | "after">) {
  return typeof diff.before === "string" && typeof diff.after === "string"
}

export function hasFull(list: Pick<FileDiff, "before" | "after">[]) {
  return list.every(hasDetails)
}

export function nextDiffLoad(input: {
  wants: boolean
  cached: boolean
  full: boolean
  loading: boolean
  bandwidthOptimization: boolean
}) {
  if (!input.wants) return
  if (input.loading) return
  if (!input.cached) return input.bandwidthOptimization ? "meta" : "full"
  if (!input.bandwidthOptimization && !input.full) return "full"
}

export function nextDiffDetails(input: {
  bandwidthOptimization: boolean
  review: boolean
  changes: "session" | "turn"
  sessionID?: string
  open: string[]
  diffs: Pick<FileDiff, "file" | "before" | "after">[]
}) {
  if (!input.bandwidthOptimization) return []
  if (!input.review) return []
  if (input.changes !== "session") return []
  if (!input.sessionID) return []

  return input.open.filter((file) => {
    const diff = input.diffs.find((item) => item.file === file)
    if (!diff) return false
    return !hasDetails(diff)
  })
}

/**
 * Keeps patch-detail loading reactive to the currently open review entries so a
 * metadata refresh can recover any dropped detail without another manual toggle.
 */
export function createDiffDetailsLoader(input: {
  bandwidthOptimization: () => boolean
  review: () => boolean
  changes: () => "session" | "turn"
  sessionID: () => string | undefined
  open: () => string[]
  diffs: () => Pick<FileDiff, "file" | "before" | "after">[]
  load: (sessionID: string, file: string) => void
}) {
  let id: string | undefined
  const seen = new Set<string>()

  const run = () => {
    const next = input.sessionID()
    if (next !== id) {
      id = next
      seen.clear()
    }

    const list = nextDiffDetails({
      bandwidthOptimization: input.bandwidthOptimization(),
      review: input.review(),
      changes: input.changes(),
      sessionID: next,
      open: input.open(),
      diffs: input.diffs(),
    })
    const open = new Set(list)

    for (const file of [...seen]) {
      if (!open.has(file)) seen.delete(file)
    }

    for (const diff of input.diffs()) {
      if (hasDetails(diff)) seen.delete(diff.file)
    }

    if (!next) return

    for (const file of list) {
      if (seen.has(file)) continue
      seen.add(file)
      input.load(next, file)
    }
  }

  createRenderEffect(run)
  return run
}
