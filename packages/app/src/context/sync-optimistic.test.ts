import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { FileDiff, Message, Part, Session, SessionStatus, SessionValidity, Todo } from "@opencode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT } from "./global-sync/session-cache"
import { clearSessionPrefetch, setSessionPrefetch } from "./global-sync/session-prefetch"
import type { State } from "./global-sync/types"

let applyOptimisticAdd: typeof import("./sync").applyOptimisticAdd
let applyOptimisticRemove: typeof import("./sync").applyOptimisticRemove
let mergeOptimisticPage: typeof import("./sync").mergeOptimisticPage
let SyncProvider: typeof import("./sync").SyncProvider
let useSync: typeof import("./sync").useSync

const dir = "/repo"
const sessionID = "ses_1"

let globalSync: {
  data: { project: never[]; session_todo: Record<string, Todo[]> }
  child: (directory: string, opts?: { bootstrap?: boolean }) => ReturnType<typeof createStore<State>>
  todo: { set: (sessionID: string, todos: Todo[] | undefined) => void }
}

let sdk: {
  directory: string
  client: {
    session: {
      validity: (input: { sessionID: string }) => Promise<{ data: SessionValidity }>
      get: (input: { sessionID: string }) => Promise<{ data: Session }>
      messages: (input: { sessionID: string; limit: number; before?: string }) => Promise<{
        data: Array<{ info: Message; parts: Part[] }>
        response: Response
      }>
      diff: (input: { sessionID: string; file?: string; full?: boolean }) => Promise<{ data: FileDiff[] }>
      todo: (input: { sessionID: string }) => Promise<{ data: Todo[] }>
      status: () => Promise<{ data: Record<string, SessionStatus> }>
    }
  }
}

let settings: {
  general: {
    bandwidthOptimization: () => boolean
  }
}

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: { init: (props: Record<string, unknown>) => unknown }) => {
    let value: unknown
    return {
      provider: (props: Record<string, unknown>) => {
        value = input.init(props)
        return props.children
      },
      use: () => value,
    }
  },
}))

mock.module("./global-sync", () => ({
  useGlobalSync: () => globalSync,
}))

mock.module("./sdk", () => ({
  useSDK: () => sdk,
}))

mock.module("./settings", () => ({
  useSettings: () => settings,
}))

// Keep the real sync logic under test while swapping only its context inputs.
beforeAll(async () => {
  const mod = await import("./sync")
  applyOptimisticAdd = mod.applyOptimisticAdd
  applyOptimisticRemove = mod.applyOptimisticRemove
  mergeOptimisticPage = mod.mergeOptimisticPage
  SyncProvider = mod.SyncProvider
  useSync = mod.useSync
})

beforeEach(() => {
  clearSessionPrefetch(dir, [sessionID])
})

type Text = Extract<Part, { type: "text" }>

const rev = (value: string): SessionValidity => ({
  message: `${value}:message`,
  todo: `${value}:todo`,
  diff: `${value}:diff`,
  status: `${value}:status`,
})

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

const ses = (): Session => ({
  id: sessionID,
  slug: sessionID,
  projectID: "proj_1",
  directory: dir,
  title: "Session",
  version: "1",
  time: { created: 1, updated: 1 },
})

const todo = (content: string): Todo => ({
  content,
  status: "pending",
  priority: "high",
})

const diff = (file: string): FileDiff => ({
  file,
  before: `${file}:before`,
  after: `${file}:after`,
  additions: 1,
  deletions: 0,
  status: "modified",
})

function state(input?: Partial<State>): State {
  return {
    status: "complete",
    agent: [],
    command: [],
    project: "proj_1",
    projectMeta: undefined,
    icon: undefined,
    provider: { all: [], connected: [], default: {} },
    config: {},
    path: { state: "", config: "", worktree: "", directory: dir, home: "" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 50,
    message: {},
    part: {},
    validity: {},
    ...input,
  }
}

function setup(input: {
  store: State
  client: typeof sdk.client
  todos?: Record<string, Todo[]>
}) {
  const child = createStore(input.store)
  globalSync = {
    data: { project: [], session_todo: { ...(input.todos ?? {}) } },
    child() {
      return child
    },
    todo: {
      set(id, todos) {
        if (!todos) {
          delete globalSync.data.session_todo[id]
          return
        }
        globalSync.data.session_todo[id] = todos
      },
    },
  }
  sdk = {
    directory: dir,
    client: input.client,
  }
  settings = {
    general: {
      bandwidthOptimization: () => false,
    },
  }
  return child
}

async function run<T>(fn: (sync: ReturnType<typeof useSync>) => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      Promise.resolve()
        .then(async () => {
          SyncProvider({ children: undefined })
          resolve(await fn(useSync()))
        })
        .catch(reject)
        .finally(dispose)
    })
  })
}

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts message in sorted order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  test("session.sync hydrates validated cached todos before reusing cache", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const list = [userMessage("msg_1", sessionID)]
    const todos = [todo("todo:cached")]
    const remote = rev("a")
    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [textPart("prt_1", sessionID, list[0]!.id)] },
        validity: { [sessionID]: remote },
      }),
      todos: { [sessionID]: todos },
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: remote }
          },
          get: async () => {
            calls.get++
            return { data: ses() }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: list[0]!, parts: [textPart("prt_1", sessionID, list[0]!.id)] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: [todo("todo:fresh")] }
          },
          diff: async () => {
            calls.diff++
            return { data: [diff("a.ts")] }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "idle" } } }
          },
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: list.length, complete: true })

    await run((sync) => sync.session.sync(sessionID))

    expect(store.todo[sessionID]).toEqual(todos)
    expect(calls).toEqual({ validity: 1, get: 0, messages: 0, todo: 0, diff: 0, status: 0 })
  })

  test("session.sync keeps cached todos visible while only stale sections refresh", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const list = [userMessage("msg_1", sessionID)]
    const cached = [todo("todo:cached")]
    const fresh = [todo("todo:fresh")]
    const local = rev("a")
    const remote = { ...local, todo: "b:todo" }
    let allow = () => {}
    let done = () => {}
    let start = () => {}
    const valid = new Promise<{ data: SessionValidity }>((resolve) => {
      allow = () => resolve({ data: remote })
    })
    const wait = new Promise<{ data: Todo[] }>((resolve) => {
      done = () => resolve({ data: fresh })
    })
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [textPart("prt_1", sessionID, list[0]!.id)] },
        validity: { [sessionID]: local },
      }),
      todos: { [sessionID]: cached },
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return valid
          },
          get: async () => {
            calls.get++
            return { data: ses() }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: list[0]!, parts: [textPart("prt_1", sessionID, list[0]!.id)] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            start()
            return wait
          },
          diff: async () => {
            calls.diff++
            return { data: [diff("a.ts")] }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "idle" } } }
          },
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: list.length, complete: true })

    const task = run((sync) => sync.session.sync(sessionID))
    await Promise.resolve()

    expect(store.todo[sessionID]).toBeUndefined()
    expect(calls).toEqual({ validity: 1, get: 0, messages: 0, todo: 0, diff: 0, status: 0 })

    allow()
    await started

    expect(store.todo[sessionID]).toEqual(cached)
    expect(calls).toEqual({ validity: 1, get: 0, messages: 0, todo: 1, diff: 0, status: 0 })

    done()
    await task

    expect(store.todo[sessionID]).toEqual(fresh)
  })

  test("session.sync refreshes stale messages and status without reloading metadata", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const cached = userMessage("msg_1", sessionID)
    const fresh = userMessage("msg_2", sessionID)
    const local = rev("a")
    const remote = { ...local, message: "b:message", status: "b:status" }
    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: [cached] },
        part: { [cached.id]: [textPart("prt_1", sessionID, cached.id)] },
        session_status: { [sessionID]: { type: "idle" } },
        validity: { [sessionID]: local },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: remote }
          },
          get: async () => {
            calls.get++
            return { data: { ...ses(), title: "Fresh" } }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: fresh, parts: [textPart("prt_2", sessionID, fresh.id)] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: [todo("todo:fresh")] }
          },
          diff: async () => {
            calls.diff++
            return { data: [diff("fresh.ts")] }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "busy" } } }
          },
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: 1, complete: true })

    await run((sync) => sync.session.sync(sessionID))

    expect(calls).toEqual({ validity: 1, get: 0, messages: 1, todo: 0, diff: 0, status: 1 })
    expect(store.session.find((item) => item.id === sessionID)?.title).toBe("Session")
    expect(store.message[sessionID]?.map((item) => item.id)).toEqual([fresh.id])
    expect(store.session_status[sessionID]).toEqual({ type: "busy" })
  })

  test("validated cache refresh does not recreate dropped message validity after eviction", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const local = rev("a")
    const remote = { ...local, message: "b:message" }
    let release = () => {}
    let begin = () => {}
    const blocked = new Promise<{
      data: Array<{ info: Message; parts: Part[] }>
      response: Response
    }>((resolve) => {
      release = () => {
        const msg = userMessage("msg:late", sessionID)
        resolve({
          data: [{ info: msg, parts: [textPart("prt:late", sessionID, msg.id)] }],
          response: new Response(null),
        })
      }
    })
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: [userMessage("msg_1", sessionID)] },
        part: { msg_1: [textPart("prt_1", sessionID, "msg_1")] },
        validity: { [sessionID]: local },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: remote }
          },
          get: async (input) => {
            calls.get++
            return {
              data: {
                ...ses(),
                id: input.sessionID,
                slug: input.sessionID,
                title: input.sessionID,
              },
            }
          },
          messages: async (input) => {
            calls.messages++
            if (input.sessionID === sessionID) {
              begin()
              return blocked
            }
            const msg = userMessage(`msg:${input.sessionID}`, input.sessionID)
            return {
              data: [{ info: msg, parts: [textPart(`prt:${input.sessionID}`, input.sessionID, msg.id)] }],
              response: new Response(null),
            }
          },
          todo: async (input) => {
            calls.todo++
            return { data: [todo(`todo:${input.sessionID}`)] }
          },
          diff: async (input) => {
            calls.diff++
            return { data: [diff(`${input.sessionID}.ts`)] }
          },
          status: async () => {
            calls.status++
            return { data: {} }
          },
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: 1, complete: true })

    await run(async (sync) => {
      const task = sync.session.sync(sessionID)
      await started

      for (let i = 0; i < SESSION_CACHE_LIMIT; i++) {
        await sync.session.sync(`ses_${i + 2}`, { force: true })
      }

      expect(store.message[sessionID]).toBeUndefined()
      expect(store.validity[sessionID]).toBeUndefined()

      release()
      await task
    })

    expect(store.message[sessionID]).toBeUndefined()
    expect(store.validity[sessionID]).toBeUndefined()
  })

  test("session.sync still forces a full reload when requested", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const list = [userMessage("msg_1", sessionID)]
    const fresh = userMessage("msg_2", sessionID)
    const [store] = setup({
      store: state({
        session: [{ ...ses(), title: "Cached" }],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [textPart("prt_1", sessionID, list[0]!.id)] },
        todo: { [sessionID]: [todo("todo:cached")] },
        session_diff: { [sessionID]: [diff("cached.ts")] },
        session_status: { [sessionID]: { type: "idle" } },
        validity: { [sessionID]: rev("a") },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: rev("b") }
          },
          get: async () => {
            calls.get++
            return { data: { ...ses(), title: "Fresh" } }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: fresh, parts: [textPart("prt_2", sessionID, fresh.id)] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: [todo("todo:fresh")] }
          },
          diff: async () => {
            calls.diff++
            return { data: [diff("fresh.ts")] }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "busy" } } }
          },
        },
      },
    })

    await run((sync) => sync.session.sync(sessionID, { force: true }))

    expect(calls).toEqual({ validity: 0, get: 1, messages: 1, todo: 1, diff: 1, status: 1 })
    expect(store.session.find((item) => item.id === sessionID)?.title).toBe("Fresh")
    expect(store.message[sessionID]?.map((item) => item.id)).toEqual([fresh.id])
  })

  test("session.sync force reload fetches missing sections too", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const fresh = userMessage("msg_2", sessionID)
    const [store] = setup({
      store: state({
        session: [{ ...ses(), title: "Cached" }],
        message: { [sessionID]: [userMessage("msg_1", sessionID)] },
        part: { msg_1: [textPart("prt_1", sessionID, "msg_1")] },
        validity: { [sessionID]: rev("a") },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: rev("b") }
          },
          get: async () => {
            calls.get++
            return { data: { ...ses(), title: "Fresh" } }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: fresh, parts: [textPart("prt_2", sessionID, fresh.id)] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: [todo("todo:fresh")] }
          },
          diff: async () => {
            calls.diff++
            return { data: [diff("fresh.ts")] }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "busy" } } }
          },
        },
      },
    })

    await run((sync) => sync.session.sync(sessionID, { force: true }))

    expect(calls).toEqual({ validity: 0, get: 1, messages: 1, todo: 1, diff: 1, status: 1 })
    expect(store.todo[sessionID]).toEqual([todo("todo:fresh")])
    expect(store.session_diff[sessionID]).toEqual([diff("fresh.ts")])
    expect(store.session_status[sessionID]).toEqual({ type: "busy" })
  })

  test("late status responses do not recreate dropped session caches after eviction", async () => {
    const calls = {
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    let release = () => {}
    let begin = () => {}
    const blocked = new Promise<{ data: Record<string, SessionStatus> }>((resolve) => {
      release = () => resolve({ data: { [sessionID]: { type: "busy" } } })
    })
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const [store] = setup({
      store: state({
        session: [{ ...ses(), title: "Cached" }],
        message: { [sessionID]: [userMessage("msg_1", sessionID)] },
        part: { msg_1: [textPart("prt_1", sessionID, "msg_1")] },
        session_status: { [sessionID]: { type: "idle" } },
        validity: { [sessionID]: rev("a") },
      }),
      client: {
        session: {
          validity: async () => ({ data: rev("b") }),
          get: async (input) => {
            calls.get++
            return {
              data: {
                ...ses(),
                id: input.sessionID,
                slug: input.sessionID,
                title: input.sessionID,
              },
            }
          },
          messages: async (input) => {
            calls.messages++
            const msg = userMessage(`msg:${input.sessionID}`, input.sessionID)
            return {
              data: [{ info: msg, parts: [textPart(`prt:${input.sessionID}`, input.sessionID, msg.id)] }],
              response: new Response(null),
            }
          },
          todo: async (input) => {
            calls.todo++
            return { data: [todo(`todo:${input.sessionID}`)] }
          },
          diff: async (input) => {
            calls.diff++
            return { data: [diff(`${input.sessionID}.ts`)] }
          },
          status: async () => {
            calls.status++
            if (calls.status === 1) {
              begin()
              return blocked
            }
            return { data: {} }
          },
        },
      },
    })

    await run(async (sync) => {
      const task = sync.session.sync(sessionID, { force: true })
      await started

      for (let i = 0; i < SESSION_CACHE_LIMIT; i++) {
        await sync.session.sync(`ses_${i + 2}`, { force: true })
      }

      expect(store.session_status[sessionID]).toBeUndefined()
      expect(store.validity[sessionID]).toBeUndefined()

      release()
      await task
    })

    expect(store.session_status[sessionID]).toBeUndefined()
    expect(store.validity[sessionID]).toBeUndefined()
  })
})
