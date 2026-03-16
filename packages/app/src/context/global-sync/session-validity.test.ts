import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { FileDiff, Message, Part, Session, SessionStatus, SessionValidity, Todo } from "@opencode-ai/sdk/v2/client"
import { clearSessionPrefetch, setSessionPrefetch } from "./session-prefetch"
import type { State } from "./types"

let SyncProvider: typeof import("../sync").SyncProvider
let useSync: typeof import("../sync").useSync

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

const rev = (value: string): SessionValidity => ({
  message: `${value}:message`,
  todo: `${value}:todo`,
  diff: `${value}:diff`,
  status: `${value}:status`,
})

const msg = (id = "msg_1"): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const part = (messageID = "msg_1"): Part => ({
  id: `part:${messageID}`,
  sessionID,
  messageID,
  type: "text",
  text: messageID,
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

mock.module("../global-sync", () => ({
  useGlobalSync: () => globalSync,
}))

mock.module("../sdk", () => ({
  useSDK: () => sdk,
}))

mock.module("../settings", () => ({
  useSettings: () => settings,
}))

// Keep the real sync implementation under test while swapping only the outer
// context boundary it reads from.
beforeAll(async () => {
  const mod = await import("../sync")
  SyncProvider = mod.SyncProvider
  useSync = mod.useSync
})

beforeEach(() => {
  clearSessionPrefetch(dir, [sessionID])
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
}) {
  const child = createStore(input.store)
  globalSync = {
    data: { project: [], session_todo: {} },
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
          const sync = useSync()
          const result = await fn(sync)
          resolve(result)
        })
        .catch(reject)
        .finally(dispose)
    })
  })
}

describe("session validity sync flows", () => {
  test("reloads only stale sections and then reuses fresh cache", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const remote = { ...rev("a"), todo: "b:todo", diff: "b:diff" }
    const list = [msg()]
    const todos = [todo("todo:new")]
    const diffs = [diff("b.ts")]

    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [part(list[0]!.id)] },
        todo: { [sessionID]: [todo("todo:old")] },
        session_diff: { [sessionID]: [diff("a.ts")] },
        session_status: { [sessionID]: { type: "idle" } },
        validity: { [sessionID]: rev("a") },
      }),
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
            return { data: [{ info: msg(), parts: [part()] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: todos }
          },
          diff: async () => {
            calls.diff++
            return { data: diffs }
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

    expect(calls).toEqual({ validity: 1, get: 0, messages: 0, todo: 1, diff: 1, status: 0 })
    expect(store.todo[sessionID]).toEqual(todos)
    expect(store.session_diff[sessionID]).toEqual(diffs)
    expect(store.message[sessionID]).toEqual(list)
    expect(store.validity[sessionID]).toEqual(remote)

    await run((sync) => sync.session.sync(sessionID))

    expect(calls).toEqual({ validity: 2, get: 0, messages: 0, todo: 1, diff: 1, status: 0 })
  })

  test("reloads stale diffs during session sync when optimization is off", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const remote = { ...rev("a"), diff: "b:diff" }
    const list = [msg()]
    const diffs = [diff("b.ts")]

    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [part(list[0]!.id)] },
        session_diff: { [sessionID]: [diff("a.ts")] },
        validity: { [sessionID]: rev("a") },
      }),
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
            return { data: [{ info: msg(), parts: [part()] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: [] }
          },
          diff: async () => {
            calls.diff++
            return { data: diffs }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "idle" } } }
          },
        },
      },
    })
    settings.general.bandwidthOptimization = () => false
    setSessionPrefetch({ directory: dir, sessionID, limit: list.length, complete: true })

    await run((sync) => sync.session.sync(sessionID))

    expect(calls).toEqual({ validity: 1, get: 0, messages: 0, todo: 0, diff: 1, status: 0 })
    expect(store.session_diff[sessionID]).toEqual(diffs)
    expect(store.validity[sessionID]).toEqual(remote)
  })

  test("stores fresh markers after standalone todo and diff reloads", async () => {
    const calls = {
      validity: 0,
      todo: 0,
      diff: 0,
    }
    const local = rev("a")
    const remote = { ...local, todo: "b:todo", diff: "b:diff" }
    const todos = [todo("todo:new")]
    const diffs = [diff("b.ts")]

    const [store] = setup({
      store: state({
        todo: { [sessionID]: [todo("todo:old")] },
        session_diff: { [sessionID]: [diff("a.ts")] },
        validity: { [sessionID]: local },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: remote }
          },
          get: async () => ({ data: ses() }),
          messages: async () => ({ data: [{ info: msg(), parts: [part()] }], response: new Response(null) }),
          todo: async () => {
            calls.todo++
            return { data: todos }
          },
          diff: async () => {
            calls.diff++
            return { data: diffs }
          },
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        },
      },
    })

    await run((sync) => sync.session.todo(sessionID))
    await run((sync) => sync.session.diff(sessionID))

    expect(store.todo[sessionID]).toEqual(todos)
    expect(store.session_diff[sessionID]).toEqual(diffs)
    expect(store.validity[sessionID]).toEqual(remote)

    await run((sync) => sync.session.todo(sessionID))
    await run((sync) => sync.session.diff(sessionID))

    expect(calls).toEqual({ validity: 4, todo: 1, diff: 1 })
  })

  test("does not reload stale diffs during session sync before review requests them", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const local = rev("a")
    const remote = { ...local, diff: "b:diff" }
    const list = [msg()]
    const diffs = [diff("a.ts")]

    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [part(list[0]!.id)] },
        session_diff: { [sessionID]: diffs },
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
            return { data: ses() }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: msg(), parts: [part()] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: [] }
          },
          diff: async () => {
            calls.diff++
            return { data: [diff("b.ts")] }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: { type: "idle" } } }
          },
        },
      },
    })
    settings.general.bandwidthOptimization = () => true
    setSessionPrefetch({ directory: dir, sessionID, limit: list.length, complete: true })

    await run((sync) => sync.session.sync(sessionID))

    expect(calls).toEqual({ validity: 1, get: 0, messages: 0, todo: 0, diff: 0, status: 0 })
    expect(store.session_diff[sessionID]).toEqual(diffs)
    expect(store.validity[sessionID]).toEqual(local)
  })

  test("skips cached session metadata refresh when markers still match", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
    }
    const local = rev("a")
    const list = [msg()]

    setup({
      store: state({
        session: [{ ...ses(), title: "Stale" }],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [part(list[0]!.id)] },
        validity: { [sessionID]: local },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: local }
          },
          get: async () => {
            calls.get++
            return { data: { ...ses(), title: "Fresh" } }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: msg(), parts: [part()] }], response: new Response(null) }
          },
          todo: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: list.length, complete: true })

    await run((sync) => sync.session.sync(sessionID))

    expect(calls).toEqual({ validity: 1, get: 0, messages: 0 })
  })

  test("does not bless message markers while history loading is inflight", async () => {
    const calls = {
      validity: 0,
      get: 0,
      latest: 0,
      older: 0,
    }
    const local = rev("a")
    const list = [msg()]
    let remote = local
    let done = () => {}
    const older = new Promise<{ data: Array<{ info: Message; parts: Part[] }>; response: Response }>((resolve) => {
      done = () =>
        resolve({
          data: [{ info: msg("msg:older"), parts: [part("msg:older")] }],
          response: new Response(null),
        })
    })

    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: list },
        part: { [list[0]!.id]: [part(list[0]!.id)] },
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
            return { data: ses() }
          },
          messages: async (input) => {
            if (input.before) {
              calls.older++
              return older
            }
            calls.latest++
            return { data: [{ info: msg("msg:new"), parts: [part("msg:new")] }], response: new Response(null) }
          },
          todo: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: list.length, cursor: "older", complete: false })

    await run(async (sync) => {
      await sync.session.sync(sessionID)
      const more = sync.session.history.loadMore(sessionID)
      remote = rev("b")
      await sync.session.sync(sessionID)
      done()
      await more
    })

    expect(calls).toEqual({ validity: 2, get: 0, latest: 0, older: 1 })
    expect(store.validity[sessionID]).toEqual(local)
  })

  test("forced standalone reloads clear stale markers before the next validation", async () => {
    const calls = {
      validity: 0,
      todo: 0,
      diff: 0,
    }
    const local = rev("a")
    const seen = { ...local, todo: "b:todo", diff: "b:diff" }
    const todos = [todo("todo:new")]
    const diffs = [diff("b.ts")]

    const [store] = setup({
      store: state({
        todo: { [sessionID]: [todo("todo:old")] },
        session_diff: { [sessionID]: [diff("a.ts")] },
        validity: { [sessionID]: local },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            return { data: seen }
          },
          get: async () => ({ data: ses() }),
          messages: async () => ({ data: [{ info: msg(), parts: [part()] }], response: new Response(null) }),
          todo: async () => {
            calls.todo++
            return { data: todos }
          },
          diff: async () => {
            calls.diff++
            return { data: diffs }
          },
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        },
      },
    })

    await run((sync) => sync.session.todo(sessionID, { force: true }))
    await run((sync) => sync.session.diff(sessionID, { force: true }))

    expect(store.todo[sessionID]).toEqual(todos)
    expect(store.session_diff[sessionID]).toEqual(diffs)
    expect(store.validity[sessionID]).toEqual({ ...local, todo: "", diff: "" })

    await run((sync) => sync.session.todo(sessionID))
    await run((sync) => sync.session.diff(sessionID))

    expect(calls).toEqual({ validity: 2, todo: 2, diff: 2 })
    expect(store.validity[sessionID]).toEqual(seen)
  })

  test("loads each expanded diff file independently", async () => {
    const calls: Array<{ file?: string; full?: boolean }> = []

    const [store] = setup({
      store: state({
        session_diff: {
          [sessionID]: [
            {
              file: "a.ts",
              additions: 1,
              deletions: 0,
              status: "modified",
            },
            {
              file: "b.ts",
              additions: 2,
              deletions: 0,
              status: "modified",
            },
          ],
        },
      }),
      client: {
        session: {
          validity: async () => ({ data: rev("a") }),
          get: async () => ({ data: ses() }),
          messages: async () => ({ data: [{ info: msg(), parts: [part()] }], response: new Response(null) }),
          diff: async (input) => {
            calls.push({ file: input.file, full: input.full })
            return {
              data: input.file ? [diff(input.file)] : [],
            }
          },
          todo: async () => ({ data: [] }),
          status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        },
      },
    })

    await run((sync) => Promise.all([sync.session.diffFile(sessionID, "a.ts"), sync.session.diffFile(sessionID, "b.ts")]))

    expect(calls).toEqual([
      { file: "a.ts", full: true },
      { file: "b.ts", full: true },
    ])
    expect(store.session_diff[sessionID]).toEqual([diff("a.ts"), diff("b.ts")])
  })

  test("falls back to full fetches when validity lookup fails", async () => {
    const calls = {
      validity: 0,
      get: 0,
      messages: 0,
      todo: 0,
      diff: 0,
      status: 0,
    }
    const list = [msg("msg:server")]
    const todos = [todo("todo:server")]
    const diffs = [diff("server.ts")]
    const status = { type: "busy" } as SessionStatus

    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: [msg("msg:cached")] },
        part: { "msg:cached": [part("msg:cached")] },
        todo: { [sessionID]: [todo("todo:cached")] },
        session_diff: { [sessionID]: [diff("cached.ts")] },
        session_status: { [sessionID]: { type: "idle" } },
        validity: { [sessionID]: rev("a") },
      }),
      client: {
        session: {
          validity: async () => {
            calls.validity++
            throw new Error("offline")
          },
          get: async () => {
            calls.get++
            return { data: { ...ses(), title: "Fresh" } }
          },
          messages: async () => {
            calls.messages++
            return { data: [{ info: list[0]!, parts: [part(list[0]!.id)] }], response: new Response(null) }
          },
          todo: async () => {
            calls.todo++
            return { data: todos }
          },
          diff: async () => {
            calls.diff++
            return { data: diffs }
          },
          status: async () => {
            calls.status++
            return { data: { [sessionID]: status } }
          },
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: 1, complete: true })

    await run((sync) => sync.session.sync(sessionID))

    expect(calls).toEqual({ validity: 1, get: 1, messages: 1, todo: 1, diff: 1, status: 1 })
    expect(store.session.find((item) => item.id === sessionID)?.title).toBe("Fresh")
    expect(store.message[sessionID]?.map((item) => item.id)).toEqual(["msg:server"])
    expect(store.todo[sessionID]).toEqual(todos)
    expect(store.session_diff[sessionID]).toEqual(diffs)
    expect(store.session_status[sessionID]).toEqual(status)
    expect(store.validity[sessionID]).toEqual({ message: "", todo: "", diff: "", status: "" })
  })

  test("keeps stale markers when a selective reload fails", async () => {
    const local = rev("a")
    const remote = { ...local, diff: "b:diff" }

    const [store] = setup({
      store: state({
        session: [ses()],
        message: { [sessionID]: [msg()] },
        part: { msg_1: [part()] },
        session_diff: { [sessionID]: [diff("a.ts")] },
        validity: { [sessionID]: local },
      }),
      client: {
        session: {
          validity: async () => ({ data: remote }),
          get: async () => ({ data: ses() }),
          messages: async () => ({ data: [{ info: msg(), parts: [part()] }], response: new Response(null) }),
          todo: async () => ({ data: [] }),
          diff: async () => {
            throw new Error("diff failed")
          },
          status: async () => ({ data: {} }),
        },
      },
    })
    setSessionPrefetch({ directory: dir, sessionID, limit: 1, complete: true })

    await expect(run((sync) => sync.session.sync(sessionID))).rejects.toThrow("diff failed")

    expect(store.session_diff[sessionID]).toEqual([diff("a.ts")])
    expect(store.validity[sessionID]).toEqual(local)
  })
})
