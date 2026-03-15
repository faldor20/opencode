# Web Bandwidth Reduction Options

Reduce the amount of data the web UI moves between client and server when they are not on the same machine.

---

## Context

This app is an AI code editor, and the message timeline is not a secondary panel. It is the main product surface, and real use looks like:

- staring at the timeline most of the time
- scrolling back through older turns
- switching between sessions often
- revisiting recently opened sessions
- keeping diffs and todos in sync while the session is active

That changes the design constraints.

The previous idea of treating most timeline rows as summaries is not a good default for this product. We should assume the client usually needs the real message data for the current session, and optimize around:

- loading older history only when the user scrolls back
- reusing session state already fetched on the client when the user switches sessions
- syncing by asking for only what changed instead of re-fetching full payloads
- always compressing large responses

## What The Current Architecture Already Does

The current codebase already has some of the building blocks for a better network story.

### Message history is paginated

`packages/opencode/src/server/routes/session.ts` supports:

- `GET /session/:sessionID/message?limit=...`
- `GET /session/:sessionID/message?limit=...&before=<cursor>`

The client already uses that in `packages/app/src/context/sync.tsx`:

- `sync.session.sync(sessionID)` loads the first page
- `sync.session.history.loadMore(sessionID)` loads older history with `before`

So lazy loading older messages is already close to the current architecture.

### The client already caches per-session state

The client store already caches:

- `message`
- `part`
- `todo`
- `session_diff`
- `session_status`

See `packages/app/src/context/global-sync/types.ts` and `packages/app/src/context/global-sync/session-cache.ts`.

There is already eviction logic with `SESSION_CACHE_LIMIT = 40` in `packages/app/src/context/global-sync/session-cache.ts`, and session switching already tries to reuse cached message state when it still exists.

### The server already emits update events

The system already publishes events for:

- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `todo.updated`
- `session.diff`

So the repo is not starting from zero on incremental sync. The missing piece is that reconnect, revisit, and catch-up flows still fall back to fetching full endpoint results.

## Requests That Matter Most

From the trace and the current code, the expensive flows are:

| Request | Current behavior | Why it hurts |
| --- | --- | --- |
| `GET /session/:id/message?limit=200` | returns full `MessageV2.WithParts[]` | dominant payload, observed at ~21.2 MB |
| `GET /session/:id/message?limit=16` | also returns full parts | still large for an initial page at ~290 KB |
| `GET /session/:id/diff` | returns the full diff list for the session/message | fine once, expensive if repeated |
| `GET /session/:id/todo` | returns the whole todo list | wasteful when only a few items changed |
| background message prefetch in `packages/app/src/pages/layout.tsx` | fetches full message pages for recent sessions | duplicates a lot of payload that may already be cached locally |

`global/health` is noisy, but it is not the main bandwidth problem. Compression can help there a little, but the main win has to come from session state and history sync.

## Design Goals

- Keep the current session timeline fully usable
- Make switching between recent sessions feel local after the first open
- Avoid re-downloading message history the client already has
- Fetch old history only when the user scrolls back
- Fetch diff content only when the review panel or a diff item is actually expanded
- Use additive API changes when possible
- Turn on transport compression regardless of which higher-level design we choose

## Option 1: Lean Into History Pagination And Stop Eager History Fetching

### Design

Use the existing cursor model as the main history transport:

- load only the newest page on first open
- keep older pages unloaded until the user scrolls back
- stop background prefetch from fetching full message pages for sessions that are not active
- if prefetch remains, prefetch only session metadata or a tiny newest window

This is not a new architecture. It is mostly a policy change on top of the existing `before` cursor flow.

### Why it helps

This matches the product better than summary rows:

- the current session still gets real messages immediately
- older history moves behind an intentional user action
- inactive sessions stop pulling large message pages in the background

### Difficulty

**Low**

The pagination path already exists.

### Bug risk

**Low**

The biggest risk is scroll behavior around history loading, but the data model stays the same.

## Option 2: Make Session Switching Reuse Local State Aggressively

### Design

Treat recent session state as a client-side cache that survives switching:

- preserve message, part, todo, diff, and status state for recently viewed sessions
- on session switch, show cached state immediately if present
- only fetch the gap since the last known revision instead of reloading the whole session
- make eviction target time since last access and memory pressure rather than simple recency alone

This builds directly on the existing caches in `global-sync`.

### Why it helps

The product involves constant session switching. If the client throws away a recently viewed session or re-fetches it wholesale, bandwidth and latency both stay high.

The biggest UX win after first load is likely: "switch back to a session and it is already there."

### Difficulty

**Medium**

The store and eviction machinery already exist, but they need stronger cache semantics and a way to validate freshness cheaply.

### Bug risk

**Medium**

The risk is stale state after switching if freshness rules are weak or if events are missed.

## Option 3: Add Diff-Style Sync Endpoints For Messages, Todos, And Diffs

### Design

Add revision-aware sync endpoints so the client can say what it already has and receive only what it needs.

For the first iteration, keep it simple:

- the client sends the IDs or revision markers it already has
- the server returns:
  - new messages
  - updated messages
  - removed message IDs
  - updated parts or part deltas

Possible shapes:

```http
POST /session/:id/message/sync
POST /session/:id/todo/sync
POST /session/:id/diff/sync
```

Examples of request models:

- `messageIDs: string[]`
- `partIDs: string[]`
- `revision: string`
- `todo_revision: string`
- `diff_revision: string`

Examples of response models:

- `added`
- `updated`
- `removed`
- `complete`
- `next_revision`

A good first step here is: send a list of messages the client already has and get back only the messages it still needs. That is simpler than a fully general CRDT-style sync model and still gives most of the benefit.

For diffs specifically, the sync shape should avoid returning full patch bodies by default:

- return file-level diff metadata first
- fetch the actual patch or hunk data only when the user opens the review panel or expands a specific diff
- keep the same diff-style sync pattern for knowing which files changed, were removed, or need refresh

### Why it helps

This directly attacks repeated large payloads:

- revisiting a session no longer requires a full `limit=200`
- todos no longer need a full list fetch when one item changes
- diffs no longer need a full refresh when only one file changed

It also aligns with the fact that the server already emits update events; the sync endpoint becomes the reconnect and catch-up path.

### Difficulty

**Medium to high**

It requires new API design and server-side comparison logic, but it can be introduced endpoint by endpoint.

### Bug risk

**Medium to high**

The main risks are incorrect diffing, missing removals, and revision mismatches. Those are more tractable than a fully event-only model because the client can still recover with a bounded resync.

## Option 4: Use Events For Live Updates, Sync Endpoints For Recovery

### Design

Make the architecture explicitly two-layer:

- SSE events push live updates while the session is active
- sync endpoints repair gaps on reconnect, tab restore, or session switch

That means:

- do not rely on events alone as the source of truth
- do not rely on large full reloads as the only recovery path
- combine the existing event model with revision-aware catch-up APIs

### Why it helps

The repo already emits `message.updated`, `message.part.updated`, `todo.updated`, and `session.diff`. The missing piece is robust catch-up when the client was away or its cache was evicted.

### Difficulty

**Medium**

Much of the event side already exists.

### Bug risk

**Medium**

Lower risk than event-only sync, because the repair path is explicit.

## Option 5: Always Enable Compression

### Design

Enable gzip or brotli for all heavy request and response bodies by default.

This should apply to:

- message pages
- session sync responses
- todo responses
- diff metadata responses
- expanded diff patch responses
- file reads where text content is returned
- prompt transport such as `POST /session/:sessionID/prompt_async`
- other prompt/session endpoints that can carry large request bodies or streamed JSON payloads

This should not be optional or deferred. It is the baseline.

### Why it helps

The heavy payloads in this app are mostly text and JSON. They should compress well, especially message parts, diff patches, and prompt request bodies.

Compression does not solve over-fetching, but it lowers the cost of every remaining request immediately.

### Difficulty

**Low**

This is mostly transport/server middleware work.

### Bug risk

**Low**

Very mature mechanism, small product-surface risk.

## Recommended Direction

The best fit for this app is not "summary rows first." The best fit is:

1. **Always enable compression**
2. **Only load older history when the user scrolls back**
3. **Cache recent session state on the client and reuse it when switching**
4. **Add diff-style sync endpoints so the client can send what it has and get back only what changed**
5. **Use existing live events for active updates, with sync endpoints as the recovery path**

## Suggested Rollout

### Phase 1: Cheap Wins

1. enable gzip or brotli for large API request and response bodies, including `prompt_async`
2. reduce or remove full-message prefetch for inactive sessions
3. make sure history loading stays strictly scroll-driven
4. make sure diff patches only load on review-panel open or diff expansion

### Phase 2: Better Session Reuse

1. strengthen recent-session cache reuse on the client
2. make session switching prefer cached state immediately
3. add freshness markers so the client can check whether cached state is still current without a full reload

### Phase 3: Incremental Sync

1. add `message/sync` with a simple "here is what I have" request
2. add the same pattern for `todo` and `diff`, with diff metadata first and patch hydration on expansion
3. use those sync endpoints on session switch, reconnect, and resume

### Phase 4: Tighten The Event Story

1. keep SSE for live updates
2. use the new sync endpoints to fill gaps after disconnects or evictions
3. reserve full reloads for explicit recovery or version mismatch

## Recommendation Summary

If we want the biggest bandwidth improvement with the right product assumptions:

- **most important:** cache session state locally and sync by diff
- **lowest-risk immediate win:** always-on compression, including prompt transports like `prompt_async`
- **best near-term behavior fix:** lazy back-scroll loading and less eager prefetch
- **best diff behavior fix:** lazy diff patch loading on expansion instead of full diff payloads up front
- **best long-term design:** events for live updates plus revision-aware sync endpoints for recovery
