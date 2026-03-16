import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { SessionRevert } from "../../src/session/revert"
import { SessionStatus } from "../../src/session/status"
import { Todo } from "../../src/session/todo"
import { PartID } from "../../src/session/schema"
import { Storage } from "../../src/storage/storage"
import { Database, eq } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { SessionTable } from "../../src/session/session.sql"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session validity endpoint", () => {
  test("returns section markers without payloads", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/validity`)

        expect(res.status).toBe(200)
        if (res.status !== 200) {
          await Session.remove(session.id)
          return
        }
        expect(await res.json()).toEqual({
          message: expect.any(String),
          todo: expect.any(String),
          diff: expect.any(String),
          status: expect.any(String),
        })

        await Session.remove(session.id)
      },
    })
  })

  test("changes only the markers for updated sections", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const message = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "hello",
        })

        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>
        expect(a).toBeDefined()

        Todo.update({
          sessionID: session.id,
          todos: [{ content: "task", status: "pending", priority: "high" }],
        })
        await Session.setSummary({
          sessionID: session.id,
          summary: {
            additions: 1,
            deletions: 0,
            files: 1,
            diffs: [{ file: "a.ts", before: "sha-a", after: "sha-b", additions: 1, deletions: 0, status: "modified" }],
          },
        })
        SessionStatus.set(session.id, { type: "busy" })

        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(b.message).toBe(a.message)
        expect(b.todo).not.toBe(a.todo)
        expect(b.diff).not.toBe(a.diff)
        expect(b.status).not.toBe(a.status)

        await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() + 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        const c = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(c.message).not.toBe(b.message)
        expect(c.todo).toBe(b.todo)
        expect(c.diff).toBe(b.diff)
        expect(c.status).toBe(b.status)

        await Session.remove(session.id)
      },
    })
  })

  test("changes the message marker for in-place message and part updates", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const now = spyOn(Date, "now").mockImplementation(() => 123)
        const message = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        const partID = PartID.ascending()
        await Session.updatePart({
          id: partID,
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "hello",
        })

        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        await Session.updateMessage({
          ...message,
          variant: "next",
        })

        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(b.message).not.toBe(a.message)

        await Session.updatePart({
          id: partID,
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "updated",
        })

        const c = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(c.message).not.toBe(b.message)

        now.mockRestore()

        await Session.remove(session.id)
      },
    })
  })

  test("keeps the diff marker stable for unrelated session updates", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        await Session.setSummary({
          sessionID: session.id,
          summary: {
            additions: 1,
            deletions: 0,
            files: 1,
            diffs: [{ file: "a.ts", before: "sha-a", after: "sha-b", additions: 1, deletions: 0, status: "modified" }],
          },
        })
        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        await Session.touch(session.id)
        await Session.setPermission({
          sessionID: session.id,
          permission: [{ permission: "write", action: "allow", pattern: "*" }],
        })

        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(b.diff).toBe(a.diff)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps status markers metadata-only", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        SessionStatus.set(session.id, {
          type: "retry",
          attempt: 2,
          next: 123,
          message: "retry status payload",
        })

        const body = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(body.status).not.toContain("retry status payload")
        expect(body.status).not.toBe(
          JSON.stringify({
            type: "retry",
            attempt: 2,
            next: 123,
            message: "retry status payload",
          }),
        )

        await Session.remove(session.id)
      },
    })
  })

  test("changes the status marker when retry message changes", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        SessionStatus.set(session.id, {
          type: "retry",
          attempt: 1,
          next: 10,
          message: "first",
        })

        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        SessionStatus.set(session.id, {
          type: "retry",
          attempt: 1,
          next: 10,
          message: "second",
        })

        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(b.status).not.toBe(a.status)

        await Session.remove(session.id)
      },
    })
  })

  test("changes the diff marker from session diff metadata", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const now = spyOn(Date, "now").mockImplementation(() => 123)

        await Session.setSummary({
          sessionID: session.id,
          summary: {
            additions: 1,
            deletions: 0,
            files: 1,
            diffs: [{ file: "a.ts", before: "sha-a", after: "sha-b", additions: 1, deletions: 0, status: "modified" }],
          },
        })
        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        await Session.setSummary({
          sessionID: session.id,
          summary: {
            additions: 1,
            deletions: 0,
            files: 1,
            diffs: [{ file: "a.ts", before: "sha-a", after: "sha-c", additions: 1, deletions: 0, status: "modified" }],
          },
        })
        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(b.diff).not.toBe(a.diff)

        now.mockRestore()

        await Session.remove(session.id)
      },
    })
  })

  test("rebuilds diff metadata after unrevert clears revert state", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const stale = [
          { file: "a.ts", before: "sha-a", after: "sha-b", additions: 1, deletions: 0, status: "modified" },
        ] as const

        await Storage.write(["session_diff", session.id], [...stale])
        await Session.setRevert({
          sessionID: session.id,
          revert: {
            messageID: MessageID.ascending(),
          },
          summary: {
            additions: 1,
            deletions: 0,
            files: 1,
            diffs: [...stale],
          },
        })
        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        await SessionRevert.unrevert({ sessionID: session.id })

        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(b.diff).not.toBe(a.diff)
        expect(await Session.diff(session.id)).toEqual([])

        await Session.remove(session.id)
      },
    })
  })

  test("keeps rebuilt diff metadata when revert state is cleared", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const diffs = [
          { file: "b.ts", before: "sha-a", after: "sha-b", additions: 3, deletions: 1, status: "modified" },
        ] as const

        await Session.setRevert({
          sessionID: session.id,
          revert: {
            messageID: MessageID.ascending(),
          },
          summary: {
            additions: 0,
            deletions: 0,
            files: 0,
            diffs: [],
          },
        })
        await Session.setSummary({
          sessionID: session.id,
          summary: {
            additions: 3,
            deletions: 1,
            files: 1,
            diffs: [...diffs],
          },
        })
        const a = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        await Session.clearRevert(session.id)

        const b = (await (await app.request(`/session/${session.id}/validity`)).json()) as Record<string, string>

        expect(Number(b.diff)).toBe(Number(a.diff) + 1)
        expect((await Session.get(session.id)).summary).toEqual({
          additions: 3,
          deletions: 1,
          files: 1,
          diffs: [...diffs],
        })

        await Session.remove(session.id)
      },
    })
  })

  test("does not depend on Session.get for validity markers", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        Database.use((db) =>
          db
            .update(SessionTable)
            .set({
              diff_revision: 2,
            })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )
        const get = Session.get
        const spy = spyOn(Session, "get").mockImplementation(
          Object.assign(
            async (_id: Parameters<typeof Session.get>[0]) => {
              throw new Error("validity should not call Session.get")
            },
            { force: get.force, schema: get.schema },
          ),
        )

        const res = await app.request(`/session/${session.id}/validity`)

        expect(res.status).toBe(200)
        expect(((await res.json()) as Record<string, string>).diff).toBe("2")
        expect(spy).not.toHaveBeenCalled()
        spy.mockRestore()

        await Session.remove(session.id)
      },
    })
  })
})
