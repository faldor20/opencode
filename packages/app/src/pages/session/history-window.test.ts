import type { UserMessage } from "@opencode-ai/sdk/v2"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

const msg = (id: string) => ({ id }) as UserMessage

const list = (count: number, start = 1) => Array.from({ length: count }, (_, i) => msg(String(start + i)))

const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const pending = new Set<{ flush: () => void }>()

let raf = globalThis.requestAnimationFrame
let now = 0

beforeEach(() => {
  now = 0
  pending.clear()
  raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    now += 1
    for (const item of pending) item.flush()
    cb(now)
    return now
  }) as typeof requestAnimationFrame
})

afterEach(() => {
  globalThis.requestAnimationFrame = raf
})

async function api() {
  const mod = (await import("./history-window")) as Record<string, unknown>
  expect(typeof mod.createSessionHistoryWindow, "session history helper should be exported for focused tests").toBe(
    "function",
  )
  expect(typeof mod.shouldAutoFillHistory, "session auto-fill guard should be exported for focused tests").toBe(
    "function",
  )
  return {
    createSessionHistoryWindow: mod.createSessionHistoryWindow as (input: {
      bandwidthOptimization: () => boolean
      hasScrollGesture: () => boolean
      sessionID: () => string | undefined
      messagesReady: () => boolean
      loaded: () => number
      visibleUserMessages: () => UserMessage[]
      historyMore: () => boolean
      historyLoading: () => boolean
      loadMore: (sessionID: string) => Promise<void>
      userScrolled: () => boolean
      scroller: () => HTMLDivElement | undefined
    }) => {
      turnStart: () => number
      setTurnStart: (start: number) => void
      renderedUserMessages: () => UserMessage[]
      loadAndReveal: () => Promise<void>
      onScrollerScroll: () => void
    },
    shouldAutoFillHistory: mod.shouldAutoFillHistory as (input: {
      bandwidthOptimization: boolean
      sessionID?: string
      messagesReady: boolean
      userScrolled: boolean
      historyLoading: boolean
      historyMore: boolean
      turnStart: number
      scrollHeight: number
      clientHeight: number
    }) => boolean,
  }
}

function harness(input: {
  bandwidthOptimization: boolean
  visible?: UserMessage[]
  loaded?: number
  historyMore?: boolean
  historyLoading?: boolean
  userScrolled?: boolean
  hasScrollGesture?: boolean
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  loadMore?: (
    state: {
      msgs: UserMessage[]
      loaded: number
      historyMore: boolean
      historyLoading: boolean
      userScrolled: boolean
    },
    setState: (
      next: Partial<{
        msgs: UserMessage[]
        loaded: number
        historyMore: boolean
        historyLoading: boolean
        userScrolled: boolean
      }>,
    ) => void,
    el: HTMLDivElement & { setHeight: (next: number) => void },
  ) => void | Promise<void>
}) {
  return api().then(async (mod) => {
    const ctx = createRoot((dispose) => {
      const [state, setStore] = createStore({
        msgs: input.visible ?? list(20),
        loaded: input.loaded ?? (input.visible ?? list(20)).length,
        historyMore: input.historyMore ?? true,
        historyLoading: input.historyLoading ?? false,
        userScrolled: input.userScrolled ?? true,
        hasScrollGesture: input.hasScrollGesture ?? true,
      })
      const box = {
        value: input.scrollHeight ?? 1000,
        next: undefined as number | undefined,
        flush() {
          if (box.next === undefined) return
          box.value = box.next
          box.next = undefined
        },
      }
      pending.add(box)
      const el = {
        scrollTop: input.scrollTop ?? 0,
        clientHeight: input.clientHeight ?? 320,
        get scrollHeight() {
          return box.value
        },
        setHeight(next: number) {
          box.next = next
        },
      } as HTMLDivElement & { setHeight: (next: number) => void }
      const calls: string[] = []
      const win = mod.createSessionHistoryWindow({
        bandwidthOptimization: () => input.bandwidthOptimization,
        hasScrollGesture: () => state.hasScrollGesture,
        sessionID: () => "session",
        messagesReady: () => true,
        loaded: () => state.loaded,
        visibleUserMessages: () => state.msgs,
        historyMore: () => state.historyMore,
        historyLoading: () => state.historyLoading,
        loadMore: async (sessionID) => {
          calls.push(sessionID)
          await input.loadMore?.(state, (next) => setStore(next as never), el)
        },
        userScrolled: () => state.userScrolled,
        scroller: () => el,
      })
      return {
        dispose: () => {
          pending.delete(box)
          dispose()
        },
        calls,
        state,
        setStore,
        el,
        win,
        shouldAutoFillHistory: mod.shouldAutoFillHistory,
      }
    })
    await tick()
    return ctx
  })
}

describe("createSessionHistoryWindow", () => {
  test("component-style reactive props see updated rendered messages after backfill", async () => {
    const ctx = await harness({ bandwidthOptimization: true })
    const props = {
      get turnStart() {
        return ctx.win.turnStart()
      },
      get renderedUserMessages() {
        return ctx.win.renderedUserMessages()
      },
    }

    await tick()
    expect(props.renderedUserMessages.length).toBe(10)
    ctx.win.onScrollerScroll()
    await tick()

    // Match the actual page contract: reactive JSX reads the helper directly
    // through prop access, not through an extra outer memo wrapper.
    expect(props.turnStart).toBe(2)
    expect(props.renderedUserMessages.length).toBe(18)
    ctx.dispose()
  })

  test("toggle off keeps prefetch while backfilling cached turns", async () => {
    const ctx = await harness({ bandwidthOptimization: false })

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual(["session"])
    expect(ctx.win.turnStart()).toBe(2)
    ctx.dispose()
  })

  test("toggle on stops prefetch until the user reaches loaded history", async () => {
    const ctx = await harness({ bandwidthOptimization: true })

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual([])
    expect(ctx.win.turnStart()).toBe(2)
    ctx.dispose()
  })

  test("toggle on ignores programmatic near-top scrolls without a gesture", async () => {
    const ctx = await harness({
      bandwidthOptimization: true,
      hasScrollGesture: false,
    })

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual([])
    expect(ctx.win.turnStart()).toBe(10)
    ctx.dispose()
  })

  test("toggle on still loads older history from explicit back-scroll and preserves scroll", async () => {
    const ctx = await harness({
      bandwidthOptimization: true,
      visible: list(10),
      scrollTop: 24,
      scrollHeight: 1000,
      loadMore: (_state, setState, el) => {
        setState({ msgs: list(18), loaded: 18 })
        el.setHeight(1240)
      },
    })

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual(["session"])
    expect(ctx.win.turnStart()).toBe(0)
    expect(ctx.el.scrollTop).toBe(264)
    ctx.dispose()
  })

  test("explicit reveal still preserves scroll when optimization is on", async () => {
    const ctx = await harness({
      bandwidthOptimization: true,
      scrollTop: 36,
      scrollHeight: 1000,
      loadMore: (_state, setState, el) => {
        setState({ msgs: list(28), loaded: 28 })
        el.setHeight(1160)
      },
    })

    await ctx.win.loadAndReveal()
    await tick()

    expect(ctx.calls).toEqual(["session"])
    expect(ctx.win.turnStart()).toBe(0)
    expect(ctx.win.renderedUserMessages()).toHaveLength(28)
    expect(ctx.el.scrollTop).toBe(196)
    ctx.dispose()
  })

  test("toggle on ignores the helper's restored near-top scroll event", async () => {
    const ctx = await harness({
      bandwidthOptimization: true,
      visible: list(10),
      scrollTop: 12,
      scrollHeight: 1000,
      loadMore: (state, setState, el) => {
        if (state.loaded === 10) {
          setState({ msgs: list(18), loaded: 18 })
          el.setHeight(1080)
          return
        }
        setState({ msgs: list(26), loaded: 26 })
        el.setHeight(1160)
      },
    })

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual(["session"])
    expect(ctx.el.scrollTop).toBe(92)

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual(["session"])
    ctx.dispose()
  })

  test("toggle on still loads after a large restoration jump", async () => {
    const ctx = await harness({
      bandwidthOptimization: true,
      visible: list(10),
      scrollTop: 12,
      scrollHeight: 1000,
      loadMore: (state, setState, el) => {
        if (state.loaded === 10) {
          setState({ msgs: list(34), loaded: 34 })
          el.setHeight(1240)
          return
        }
        setState({ msgs: list(42), loaded: 42 })
        el.setHeight(1320)
      },
    })

    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual(["session"])
    expect(ctx.el.scrollTop).toBe(252)

    ctx.win.onScrollerScroll()
    await tick()

    ctx.el.scrollTop = 24
    ctx.win.onScrollerScroll()
    await tick()

    expect(ctx.calls).toEqual(["session", "session"])
    ctx.dispose()
  })
})

describe("shouldAutoFillHistory", () => {
  test("disables eager fill when optimization is on", async () => {
    const mod = await api()

    expect(
      mod.shouldAutoFillHistory({
        bandwidthOptimization: true,
        sessionID: "session",
        messagesReady: true,
        userScrolled: false,
        historyLoading: false,
        historyMore: true,
        turnStart: 10,
        scrollHeight: 200,
        clientHeight: 320,
      }),
    ).toBe(false)
  })

  test("keeps eager fill when optimization is off", async () => {
    const mod = await api()

    expect(
      mod.shouldAutoFillHistory({
        bandwidthOptimization: false,
        sessionID: "session",
        messagesReady: true,
        userScrolled: false,
        historyLoading: false,
        historyMore: true,
        turnStart: 10,
        scrollHeight: 200,
        clientHeight: 320,
      }),
    ).toBe(true)
  })
})
