import type { FileDiff } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createDiffDetailsLoader, nextDiffDetails, nextDiffLoad } from "./diff-loading"

describe("session diff loading", () => {
  test("does not load diffs until review surfaces need them", () => {
    expect(
      nextDiffLoad({
        wants: false,
        cached: false,
        full: false,
        loading: false,
        bandwidthOptimization: true,
      }),
    ).toBeUndefined()

    expect(
      nextDiffLoad({
        wants: true,
        cached: false,
        full: false,
        loading: false,
        bandwidthOptimization: true,
      }),
    ).toBe("meta")
  })

  test("loads patch detail only after a diff item expands", () => {
    expect(
      nextDiffDetails({
        bandwidthOptimization: true,
        review: true,
        changes: "session",
        sessionID: "ses_1",
        open: [],
        diffs: [
          {
            file: "src/a.ts",
          },
        ],
      }),
    ).toEqual([])

    expect(
      nextDiffDetails({
        bandwidthOptimization: true,
        review: true,
        changes: "session",
        sessionID: "ses_1",
        open: ["src/a.ts"],
        diffs: [
          {
            file: "src/a.ts",
          },
        ],
      }),
    ).toEqual(["src/a.ts"])
  })

  test("toggle off keeps the eager full diff load", () => {
    expect(
      nextDiffLoad({
        wants: true,
        cached: false,
        full: false,
        loading: false,
        bandwidthOptimization: false,
      }),
    ).toBe("full")

    expect(
      nextDiffDetails({
        bandwidthOptimization: false,
        review: true,
        changes: "session",
        sessionID: "ses_1",
        open: ["src/a.ts"],
        diffs: [
          {
            file: "src/a.ts",
          },
        ],
      }),
    ).toEqual([])
  })

  test("reloads missing details for files that stay open after metadata refresh", () => {
    const calls: Array<{ sessionID: string; file: string }> = []

    const ctx = createRoot((dispose) => {
      const [open] = createSignal(["src/a.ts"])
      const [review] = createSignal(true)
      const [changes] = createSignal<"session" | "turn">("session")
      const [sessionID] = createSignal("ses_1")
      const [diffs, setDiffs] = createSignal<Pick<FileDiff, "file" | "before" | "after">[]>([
        {
          file: "src/a.ts",
          before: "before",
          after: "after",
        },
      ])

      const run = createDiffDetailsLoader({
        bandwidthOptimization: () => true,
        review,
        changes,
        sessionID,
        open,
        diffs,
        load: (id, file) => {
          calls.push({ sessionID: id, file })
        },
      })

      return {
        dispose,
        run,
        setDiffs,
      }
    })

    expect(calls).toEqual([])

    ctx.setDiffs([
      {
        file: "src/a.ts",
      },
    ])
    ctx.run()

    expect(calls).toEqual([{ sessionID: "ses_1", file: "src/a.ts" }])
    ctx.dispose()
  })
})
