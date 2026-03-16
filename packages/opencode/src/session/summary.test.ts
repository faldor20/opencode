import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Snapshot } from "@/snapshot"

const read = mock(async () => [] as Snapshot.FileDiff[])
const write = mock(async () => {})

mock.module("@/storage/storage", () => ({
  Storage: {
    read,
    write,
  },
}))

describe("SessionSummary diff endpoints", () => {
  beforeEach(() => {
    read.mockReset()
    write.mockReset()
    read.mockImplementation(async () => [])
    write.mockImplementation(async () => {})
  })

  test("returns metadata without patch payloads", async () => {
    read.mockImplementationOnce(async () => [
      {
        file: '"src/\\303\\245.ts"',
        before: "old",
        after: "new",
        additions: 2,
        deletions: 1,
        status: "modified",
      },
    ])

    const { SessionSummary } = await import("./summary")
    const result = await SessionSummary.diffMeta({ sessionID: "ses_1" as never })

    expect(result).toEqual([
      {
        file: "src/å.ts",
        additions: 2,
        deletions: 1,
        status: "modified",
      },
    ])
    expect(write).toHaveBeenCalledTimes(1)
  })

  test("returns one file patch when requested lazily", async () => {
    read.mockImplementationOnce(async () => [
      {
        file: '"src/\\303\\245.ts"',
        before: "old",
        after: "new",
        additions: 2,
        deletions: 1,
        status: "modified",
      },
      {
        file: "src/other.ts",
        before: "before",
        after: "after",
        additions: 1,
        deletions: 0,
        status: "added",
      },
    ])

    const { SessionSummary } = await import("./summary")
    const result = await SessionSummary.diffFile({
      sessionID: "ses_1" as never,
      file: "src/å.ts",
    })

    expect(result).toEqual({
      file: "src/å.ts",
      before: "old",
      after: "new",
      additions: 2,
      deletions: 1,
      status: "modified",
    })
  })
})
