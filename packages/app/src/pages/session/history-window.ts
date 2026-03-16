import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createRenderEffect, createSignal } from "solid-js"
import { createStore } from "solid-js/store"

export type SessionHistoryWindowInput = {
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
}

/**
 * Keeps older history behind explicit user-driven actions when bandwidth
 * optimization is enabled, while preserving the existing eager timeline flow.
 */
export function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnInit = 10
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
    restore: false,
    sessionID: undefined as string | undefined,
    ready: false,
  })
  const [turnID, setTurnID] = createSignal<string | undefined>()
  const [turnStart, setStart] = createSignal(0)

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const setTurnStart = (value: number) => {
    const id = input.sessionID()
    const next = value > 0 ? value : 0
    if (!id) {
      setTurnID()
      setStart(next)
      return
    }
    setTurnID(id)
    setStart(next)
  }

  createRenderEffect(() => {
    const id = input.sessionID()
    const ready = input.messagesReady()
    const len = input.visibleUserMessages().length
    if (id !== state.sessionID) {
      setState({
        sessionID: id,
        prefetchUntil: 0,
        prefetchNoGrowth: 0,
      })
    }
    if (ready !== state.ready) setState("ready", ready)
    if (!id || !ready || len <= 0) {
      if (turnID() || turnStart()) {
        setTurnID()
        setStart(0)
      }
      return
    }
    if (turnID() !== id || turnStart() >= len) {
      setTurnStart(initialTurnStart(len))
      return
    }
    if (turnStart() < 0) setTurnStart(0)
  })

  const renderedUserMessages = () => {
    const msgs = input.visibleUserMessages()
    const start = turnStart()
    if (start <= 0) return msgs
    return msgs.slice(start)
  }

  // Preserve the reader's place across prepends so older pages can grow upward
  // without making the timeline jump away from the same message.
  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const top = el.scrollTop
    const height = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - height
      if (!delta) return
      if (input.bandwidthOptimization()) setState("restore", true)
      el.scrollTop = top + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    preserveScroll(() => setTurnStart(next > 0 ? next : 0))
  }

  /** Keeps explicit reveal working even when passive growth is disabled. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) preserveScroll(() => setTurnStart(0))

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    preserveScroll(() => setTurnStart(Math.max(0, afterVisible - target)))
  }

  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    }

    if (!opts?.prefetch && added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return
    if (turnStart() !== start) return

    const reveal = !opts?.prefetch
    const rendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, rendered)
    const target = reveal ? Math.min(afterVisible, base + turnBatch) : base
    preserveScroll(() => setTurnStart(Math.max(0, afterVisible - target)))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    if (input.bandwidthOptimization() && !input.hasScrollGesture()) return
    const el = input.scroller()
    if (!el) return
    if (input.bandwidthOptimization() && state.restore) {
      // Ignore the helper's own scroll restoration so one gesture cannot chain
      // into another prepend after we re-anchor the viewport.
      setState("restore", false)
      return
    }
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      // Passive prefetch only makes sense when the optimization toggle is off.
      if (!input.bandwidthOptimization() && start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  return {
    turnStart,
    setTurnStart,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}

/**
 * Prevents viewport auto-fill from silently loading older pages when the user
 * asked to conserve bandwidth.
 */
export function shouldAutoFillHistory(input: {
  bandwidthOptimization: boolean
  sessionID?: string
  messagesReady: boolean
  userScrolled: boolean
  historyLoading: boolean
  historyMore: boolean
  turnStart: number
  scrollHeight?: number
  clientHeight?: number
}) {
  if (!input.sessionID) return false
  if (!input.messagesReady) return false
  if (input.userScrolled || input.historyLoading) return false
  if (input.bandwidthOptimization) return false
  if ((input.scrollHeight ?? 0) > (input.clientHeight ?? 0) + 1) return false
  if (input.turnStart <= 0 && !input.historyMore) return false
  return true
}
