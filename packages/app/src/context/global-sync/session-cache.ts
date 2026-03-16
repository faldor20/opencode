import type {
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"

export const SESSION_CACHE_LIMIT = 40

// Track sessions that were reused recently so one normal eviction pass does not
// immediately drop them the next time a new session enters the cache.
const warm = new WeakMap<Set<string>, Set<string>>()

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_diff: Record<string, FileDiff[] | undefined>
  todo: Record<string, Todo[] | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const key of Object.keys(store.part)) {
    const parts = store.part[key]
    if (!parts?.some((part) => stale.has(part?.sessionID ?? ""))) continue
    delete store.part[key]
  }

  for (const sessionID of stale) {
    delete store.message[sessionID]
    delete store.todo[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
    delete store.question[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const skip = new Set<string>()
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  const mark = warm.get(input.seen) ?? new Set<string>()
  warm.set(input.seen, mark)

  if (input.seen.has(input.keep)) {
    input.seen.delete(input.keep)
    mark.add(input.keep)
  }
  input.seen.add(input.keep)

  // First prefer evicting older cold sessions. Warm entries only get one extra
  // chance, and only when enough colder entries exist to stay within the limit.
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    if (mark.has(id)) {
      skip.add(id)
      continue
    }
    stale.push(id)
  }

  // If warm entries are the only remaining candidates, evict them now so the
  // cache still stays bounded under sustained churn.
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id) || stale.includes(id)) continue
    stale.push(id)
  }

  for (const id of stale) {
    input.seen.delete(id)
    mark.delete(id)
  }
  for (const id of skip) {
    mark.delete(id)
  }
  return stale
}
