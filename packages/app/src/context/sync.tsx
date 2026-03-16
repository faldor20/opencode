import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { useSettings } from "./settings"
import type { Message, Part, SessionValidity } from "@opencode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { hasDetails, hasFull } from "@/pages/session/diff-loading"

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight<T>(map: Map<string, Promise<T>>, key: string, task: () => Promise<T>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort((x, y) => cmp(x.id, y.id))
}

type ValidityPlan = {
  message: boolean
  todo: boolean
  diff: boolean
  status: boolean
}

type ValidityKey = keyof SessionValidity

export function sameValidity(input: { cached: boolean; local?: string; remote?: string }) {
  if (!input.cached) return false
  if (!input.local) return false
  if (!input.remote) return false
  return input.local === input.remote
}

export function shouldReuseSession(input: {
  cached: boolean
  hasSession: boolean
  local?: SessionValidity
  remote?: SessionValidity
}) {
  if (!input.cached) return false
  if (!input.hasSession) return false
  if (!input.local) return false
  if (!input.remote) return false
  return (
    input.local.message === input.remote.message &&
    input.local.todo === input.remote.todo &&
    input.local.diff === input.remote.diff &&
    input.local.status === input.remote.status
  )
}

export function nextValidity(input: {
  local?: SessionValidity
  remote: SessionValidity
  ok: Record<string, boolean>
}) {
  return {
    message: input.ok.message ? input.remote.message : input.local?.message ?? "",
    todo: input.ok.todo ? input.remote.todo : input.local?.todo ?? "",
    diff: input.ok.diff ? input.remote.diff : input.local?.diff ?? "",
    status: input.ok.status ? input.remote.status : input.local?.status ?? "",
  }
}

function blankValidity(): SessionValidity {
  return {
    message: "",
    todo: "",
    diff: "",
    status: "",
  }
}

export function planValidity(input: {
  cached: ValidityPlan
  local?: SessionValidity
  remote?: SessionValidity
}) {
  if (!input.remote || !input.local) return input.cached
  return {
    message: input.cached.message && input.local.message !== input.remote.message,
    todo: input.cached.todo && input.local.todo !== input.remote.todo,
    diff: input.cached.diff && input.local.diff !== input.remote.diff,
    status: input.cached.status && input.local.status !== input.remote.status,
  }
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    messages.splice(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()
    const settings = useSettings()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => globalSync.child(sdk.directory))
    const target = (directory?: string) => {
      if (!directory || directory === sdk.directory) return current()
      return globalSync.child(directory)
    }
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const messagePageSize = 200
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<boolean | undefined>>()
    const inflightTodo = new Map<string, Promise<boolean | undefined>>()
    const optimistic = new Map<string, Map<string, OptimisticItem>>()
    const maxDirs = 30
    const seen = new Map<string, Set<string>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      cursor: {} as Record<string, string | undefined>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const validity = (sessionID: string) => {
      return retry(() => sdk.client.session.validity({ sessionID })).then((res) => res.data!)
    }

    const clearValidity = (setStore: Setter, directory: string, sessionID: string, key?: ValidityKey) => {
      if (!tracked(directory, sessionID)) return
      if (!key) {
        setStore("validity", sessionID, blankValidity())
        return
      }
      const value = target(directory)[0].validity[sessionID]
      setStore("validity", sessionID, {
        ...blankValidity(),
        ...value,
        [key]: "",
      })
    }

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
      const key = keyFor(directory, sessionID)
      const list = optimistic.get(key)
      if (list) {
        list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
        return
      }
      optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
    }

    const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
      const key = keyFor(directory, sessionID)
      if (!messageID) {
        optimistic.delete(key)
        return
      }

      const list = optimistic.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.delete(key)
    }

    const getOptimistic = (directory: string, sessionID: string) => [
      ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
    ]

    const seenFor = (directory: string) => {
      const existing = seen.get(directory)
      if (existing) {
        seen.delete(directory)
        seen.set(directory, existing)
        return existing
      }
      const created = new Set<string>()
      seen.set(directory, created)
      while (seen.size > maxDirs) {
        const first = seen.keys().next().value
        if (!first) break
        const stale = [...(seen.get(first) ?? [])]
        seen.delete(first)
        const [, setStore] = globalSync.child(first, { bootstrap: false })
        evict(first, setStore, stale)
      }
      return created
    }

    const clearMeta = (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      for (const sessionID of sessionIDs) {
        clearOptimistic(directory, sessionID)
      }
      setMeta(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.limit[key]
            delete draft.cursor[key]
            delete draft.complete[key]
            delete draft.loading[key]
          }
        }),
      )
      const [, setStore] = globalSync.child(directory, { bootstrap: false })
      setStore(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            delete draft.validity[sessionID]
          }
        }),
      )
    }

    const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      clearSessionPrefetch(directory, sessionIDs)
      for (const sessionID of sessionIDs) {
        globalSync.todo.set(sessionID, undefined)
      }
      setStore(
        produce((draft) => {
          dropSessionCaches(draft, sessionIDs)
        }),
      )
      clearMeta(directory, sessionIDs)
    }

    const touch = (directory: string, setStore: Setter, sessionID: string) => {
      const stale = pickSessionCacheEvictions({
        seen: seenFor(directory),
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
      })
      evict(directory, setStore, stale)
    }

    const fetchMessages = async (input: {
      client: typeof sdk.client
      sessionID: string
      limit: number
      before?: string
    }) => {
      const messages = await retry(() =>
        input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
      )
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = items.map((x) => x.info).sort((a, b) => cmp(a.id, b.id))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
      return {
        session,
        part,
        cursor,
        complete: !cursor,
      }
    }

    const loadStatus = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      rev?: string
    }) => {
      const result = await retry(() => input.client.session.status())
      if (!tracked(input.directory, input.sessionID)) return false
      input.setStore("session_status", input.sessionID, result.data?.[input.sessionID] ?? { type: "idle" })
      return !!input.rev
    }

    const loadDiff = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      rev?: string
      file?: string
      full?: boolean
    }) => {
      const key = [keyFor(input.directory, input.sessionID), input.file ?? "", input.full ? "full" : "meta"].join("\n")
      return runInflight(inflightDiff, key, () =>
        retry(() =>
          input.client.session.diff({
            sessionID: input.sessionID,
            ...(input.file ? { file: input.file } : {}),
            ...(input.full ? { full: true } : {}),
          }),
        ).then((diff) => {
          if (!tracked(input.directory, input.sessionID)) return
          const data = diff.data ?? []
          if (input.file) {
            input.setStore("session_diff", input.sessionID, (items) => {
              const list = items ?? []
              const next = [...list]
              for (const item of data) {
                const idx = next.findIndex((row) => row.file === item.file)
                if (idx >= 0) {
                  next[idx] = {
                    ...next[idx],
                    ...item,
                  }
                  continue
                }
                next.push(item)
              }
              return next.sort((a, b) => cmp(a.file, b.file))
            })
          }
          if (!input.file) {
            input.setStore("session_diff", input.sessionID, reconcile(data, { key: "file" }))
          }
          if (input.rev) input.setStore("validity", input.sessionID, "diff", input.rev)
          return !!input.rev
        }),
      )
    }

    const loadTodo = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      rev?: string
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      return runInflight(inflightTodo, key, () =>
        retry(() => input.client.session.todo({ sessionID: input.sessionID })).then((todo) => {
          if (!tracked(input.directory, input.sessionID)) return
          const list = todo.data ?? []
          input.setStore("todo", input.sessionID, reconcile(list, { key: "id" }))
          globalSync.todo.set(input.sessionID, list)
          if (input.rev) input.setStore("validity", input.sessionID, "todo", input.rev)
          return !!input.rev
        }),
      )
    }

    const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      before?: string
      mode?: "replace" | "prepend"
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return false

      setMeta("loading", key, true)
      const ok = await fetchMessages(input)
        .then((page) => {
          if (!tracked(input.directory, input.sessionID)) return false
          const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
          for (const messageID of next.confirmed) {
            clearOptimistic(input.directory, input.sessionID, messageID)
          }
          const [store] = globalSync.child(input.directory, { bootstrap: false })
          const cached = input.mode === "prepend" ? (store.message[input.sessionID] ?? []) : []
          const message = input.mode === "prepend" ? merge(cached, next.session) : next.session
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
            for (const p of next.part) {
              input.setStore("part", p.id, p.part)
            }
            setMeta("limit", key, message.length)
            setMeta("cursor", key, next.cursor)
            setMeta("complete", key, next.complete)
            setSessionPrefetch({
              directory: input.directory,
              sessionID: input.sessionID,
              limit: message.length,
              cursor: next.cursor,
              complete: next.complete,
            })
          })
          return true
        })
        .finally(() => {
          setMeta(
            produce((draft) => {
              if (!tracked(input.directory, input.sessionID)) {
                delete draft.loading[key]
                return
              }
              draft.loading[key] = false
            }),
          )
        })
      return ok ?? false
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            setOptimistic(directory, input.sessionID, { message: input.message, parts: input.parts })
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            clearOptimistic(directory, input.sessionID, input.messageID)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
          variant?: string
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
            variant: input.variant,
          }
          const [, setStore] = target()
          setOptimistic(sdk.directory, input.sessionID, { message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)

          touch(directory, setStore, sessionID)

          const seeded = getSessionPrefetch(directory, sessionID)
          if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
            batch(() => {
              setMeta("limit", key, seeded.limit)
              setMeta("cursor", key, seeded.cursor)
              setMeta("complete", key, seeded.complete)
              setMeta("loading", key, false)
            })
          }

          return runInflight(inflight, key, async () => {
            const pending = getSessionPrefetchPromise(directory, sessionID)
            if (pending) {
              await pending
              const seeded = getSessionPrefetch(directory, sessionID)
              if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
                batch(() => {
                  setMeta("limit", key, seeded.limit)
                  setMeta("cursor", key, seeded.cursor)
                  setMeta("complete", key, seeded.complete)
                  setMeta("loading", key, false)
                })
              }
            }

            const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
            const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
            const remote = !opts?.force ? await validity(sessionID).catch(() => undefined) : undefined
            if (remote) {
              const todo = globalSync.data.session_todo[sessionID]

              // Once validity succeeds, surface any previously cached sections into the
              // active child store before deciding whether to fetch. This keeps revisits
              // fast while stale sections still refresh in the background.
              if (todo && store.todo[sessionID] === undefined) {
                setStore("todo", sessionID, reconcile(todo, { key: "id" }))
              }

              const opt = settings.general.bandwidthOptimization()
              const plan = planValidity({
                cached: {
                  message: cached,
                  todo: store.todo[sessionID] !== undefined || globalSync.data.session_todo[sessionID] !== undefined,
                  diff: store.session_diff[sessionID] !== undefined,
                  status: store.session_status[sessionID] !== undefined,
                },
                local: store.validity[sessionID],
                remote,
              })
              // Keep optimized-mode review payloads demand-driven so merely opening
              // a session does not refresh diffs before the user asks for them.
              const diff = plan.diff && !opt
              // Revalidated cached sessions can keep their existing metadata while
              // section-level stale payloads refresh independently.
              const refresh = !hasSession || !!opts?.force
              if (cached && hasSession && !refresh && !plan.message && !plan.todo && !diff && !plan.status) return

              // Keep markers stale until each matching reload succeeds so failed
              // refreshes cannot bless old cached sections as current.
                const ok = await Promise.all([
                  refresh
                    ? retry(() => client.session.get({ sessionID })).then((session) => {
                        if (!tracked(directory, sessionID)) return
                        const data = session.data
                        if (!data) return
                        setStore(
                          "session",
                          produce((draft) => {
                            const match = Binary.search(draft, sessionID, (s) => s.id)
                            if (match.found) {
                              draft[match.index] = data
                              return
                            }
                            draft.splice(match.index, 0, data)
                          }),
                        )
                        return true
                      })
                    : Promise.resolve(true),
                  !cached || plan.message
                    ? loadMessages({
                        directory,
                        client,
                        setStore,
                        sessionID,
                        limit: meta.limit[key] ?? messagePageSize,
                      })
                    : Promise.resolve(true),
                  plan.todo ? loadTodo({ directory, client, setStore, sessionID, rev: remote.todo }) : Promise.resolve(true),
                  diff ? loadDiff({ directory, client, setStore, sessionID, rev: remote.diff, full: true }) : Promise.resolve(!plan.diff),
                  plan.status
                    ? loadStatus({ directory, client, setStore, sessionID, rev: remote.status })
                    : Promise.resolve(true),
                ])
              if (!tracked(directory, sessionID)) return
              setStore(
                "validity",
                sessionID,
                nextValidity({
                  local: store.validity[sessionID],
                  remote,
                  ok: {
                    message: !!ok[1],
                    todo: !!ok[2],
                    diff: !!ok[3],
                    status: !!ok[4],
                  },
                }),
              )
              return
            }

            if (shouldReuseSession({ cached, hasSession, local: store.validity[sessionID], remote })) return

            const limit = meta.limit[key] ?? messagePageSize
            const sessionReq =
              hasSession && !opts?.force && !!remote
                ? Promise.resolve()
                : retry(() => client.session.get({ sessionID })).then((session) => {
                    if (!tracked(directory, sessionID)) return
                    const data = session.data
                    if (!data) return
                    setStore(
                      "session",
                      produce((draft) => {
                        const match = Binary.search(draft, sessionID, (s) => s.id)
                        if (match.found) {
                          draft[match.index] = data
                          return
                        }
                        draft.splice(match.index, 0, data)
                      }),
                    )
                    })

            const messagesReq =
              cached && !opts?.force && !!remote
                ? Promise.resolve()
                : loadMessages({
                    directory,
                    client,
                    setStore,
                    sessionID,
                    limit,
                  })

            const todoReq =
              opts?.force || store.todo[sessionID] !== undefined || globalSync.data.session_todo[sessionID] !== undefined
                ? loadTodo({ directory, client, setStore, sessionID })
                : Promise.resolve()

            const diffReq =
              (settings.general.bandwidthOptimization() && !opts?.force) ||
              (!opts?.force && store.session_diff[sessionID] === undefined)
                ? Promise.resolve()
                : loadDiff({ directory, client, setStore, sessionID, full: true })

            const statusReq =
              opts?.force || store.session_status[sessionID] !== undefined
                ? loadStatus({ directory, client, setStore, sessionID })
                : Promise.resolve()

            await Promise.all([sessionReq, messagesReq, todoReq, diffReq, statusReq])
            clearValidity(setStore, directory, sessionID)
          })
        },
        async diff(sessionID: string, opts?: { force?: boolean; full?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const full = opts?.full ?? true
          const remote = !opts?.force ? await validity(sessionID).catch(() => undefined) : undefined
          if (
            !opts?.force &&
            store.session_diff[sessionID] !== undefined &&
            (!full || hasFull(store.session_diff[sessionID] ?? [])) &&
            sameValidity({ cached: true, local: store.validity[sessionID]?.diff, remote: remote?.diff })
          )
            return
          const ok = await loadDiff({ directory, client, setStore, sessionID, rev: remote?.diff, full })
          if (opts?.force) clearValidity(setStore, directory, sessionID, "diff")
          return ok
        },
        async diffFile(sessionID: string, file: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const current = (store.session_diff[sessionID] ?? []).find((item) => item.file === file)
          if (!opts?.force && current && hasDetails(current)) return
          await loadDiff({ directory, client, setStore, sessionID, file, full: true })
        },
        async todo(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const existing = store.todo[sessionID]
          const cached = globalSync.data.session_todo[sessionID]
          const remote = !opts?.force ? await validity(sessionID).catch(() => undefined) : undefined
          const stale = !sameValidity({ cached: existing !== undefined || cached !== undefined, local: store.validity[sessionID]?.todo, remote: remote?.todo })
          if (existing !== undefined) {
            if (cached === undefined) {
              globalSync.todo.set(sessionID, existing)
            }
            if (!opts?.force && !stale) return
          }

          if (cached !== undefined) {
            setStore("todo", sessionID, reconcile(cached, { key: "id" }))
            if (!stale && !opts?.force) return
          }

          const ok = await loadTodo({ directory, client, setStore, sessionID, rev: remote?.todo })
          if (opts?.force) clearValidity(setStore, directory, sessionID, "todo")
          return ok
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return !!meta.cursor[key]
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count?: number) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            touch(directory, setStore, sessionID)
            const key = keyFor(directory, sessionID)
            const step = count ?? messagePageSize
            if (meta.loading[key]) return
            if (meta.complete[key]) return
            const before = meta.cursor[key]
            if (!before) return

            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: step,
              before,
              mode: "prepend",
            })
          },
        },
        evict(sessionID: string, directory = sdk.directory) {
          const [, setStore] = globalSync.child(directory)
          seenFor(directory).delete(sessionID)
          evict(directory, setStore, [sessionID])
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          const directory = sdk.directory
          const client = sdk.client
          const [, setStore] = globalSync.child(directory)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
