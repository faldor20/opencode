# Web Bandwidth Reduction Options

Reduce the amount of data the web UI moves between client and server when they are not on the same machine.

---

## Context

The current web app assumes that HTTP traffic is usually local, so it eagerly bootstraps a lot of state and often requests full payloads instead of lighter projections.

The biggest hotspot is the session message API:

- `GET /session/:sessionID/message?limit=200` currently returns `MessageV2.WithParts[]`
- the server route in `packages/opencode/src/server/routes/session.ts` always serializes full `info + parts`
- the client path in `packages/app/src/context/sync.tsx` stores every returned message and part in memory
- `packages/app/src/pages/layout.tsx` also prefetches the same message page for recent sessions

That architecture is cheap on localhost, but it gets expensive across a network because the same large payload is transferred, parsed, and merged multiple times.

The recorded trace shows the same pattern:

- `session/.../message?limit=16` returned about `290 KB`
- `session/.../message?limit=200` returned about `21.2 MB`
- `session/.../diff` returned about `19 KB`
- `file?path=` returned about `4-7 KB`
- `global/health` is tiny, but happens repeatedly

The trace suggests the main problem is not request count alone. The main problem is that a few requests send far more data than the UI needs for first paint.

## What Is Triggering The Requests Today

These are the main request sources in the current codebase.

| Request | Current trigger | Code |
| --- | --- | --- |
| `GET /global/health` | Initial global bootstrap and server health checks | `packages/app/src/context/global-sync/bootstrap.ts`, `packages/app/src/utils/server-health.ts` |
| `GET /path`, `GET /global/config`, provider/project bootstrap calls | App startup and directory bootstrap | `packages/app/src/context/global-sync/bootstrap.ts` |
| `GET /session/:id` | Session page hydration | `packages/app/src/context/sync.tsx` |
| `GET /session/:id/message?limit=...` | Session timeline load and background prefetch | `packages/app/src/context/sync.tsx`, `packages/app/src/pages/layout.tsx` |
| `GET /session/:id/todo` | Session page hydration and refresh | `packages/app/src/context/sync.tsx` |
| `GET /find/file`, `GET /file/file`, `GET /file/content` | File picker and file tree interactions | `packages/app/src/context/file.tsx` |

This matters because the largest response is also the most central one: the session timeline.

## Design Goals

- Keep the first session render fast over a network
- Preserve the current session model and timeline UI where possible
- Avoid broad server/client rewrites unless the expected bandwidth win is large
- Prefer additive API changes over breaking payload changes

## Option 1: Message Summaries First, Parts On Demand

### Design

Add a lighter message list shape for the timeline:

- extend `GET /session/:id/message` with a projection like `projection=summary`
- return only `info` plus small derived fields needed for the timeline, such as:
  - `id`
  - `role`
  - `time`
  - short text preview
  - part kinds
  - file count / diff count
  - flags like `has_parts`, `has_tool_calls`, `has_synthetic`
- keep full `parts` behind either:
  - `GET /session/:id/message/:messageID`, or
  - a new batch hydrate endpoint for a list of message IDs

Use the summary view for:

- initial timeline load
- session prefetch in `packages/app/src/pages/layout.tsx`
- inactive offscreen turns

Fetch full parts only when a turn becomes visible, expands, or needs rich rendering.

### Why it helps

The current `limit=200` response is large because every message carries all of its parts. Splitting summary data from part data attacks the biggest payload directly.

### Difficulty

**Medium**

It changes both server and client, but the change can be additive and rolled out behind a new query parameter.

### Bug risk

**Medium**

The main risk is missing a timeline feature that currently reads full parts immediately, especially synthetic text, code comments, or file-change rendering. That risk is manageable if summary payloads advertise what rich data still exists and the client hydrates before rendering those cases.

## Option 2: Keep One Initial Page, Then Stream Deltas

### Design

Keep the current first page request, then stop re-fetching large message pages once the client is caught up.

Possible shape:

- first load uses the existing cursor page
- after that, session updates arrive as small SSE events for:
  - `message_added`
  - `message_updated`
  - `message_removed`
  - `todo_changed`
- the client merges those deltas into the existing store instead of reloading `limit=200`

This is a natural fit with the existing SSE architecture in `packages/opencode/src/server/routes/global.ts`.

### Why it helps

This reduces repeated large transfers for active sessions and revisits. It does not shrink the first load as much as Option 1, but it avoids paying the same cost again and again.

### Difficulty

**High**

It requires new event contracts, careful client merge logic, and versioning so reconnects and missed events can recover safely.

### Bug risk

**High**

Realtime delta systems are easy to get subtly wrong: duplicates, out-of-order updates, reconnect gaps, and cache divergence are the likely failure modes.

## Option 3: Add Bootstrap Tiers And Skip Non-Critical Fetches

### Design

Keep the current endpoints, but make the app fetch less on startup and less in the background.

Examples:

- do not prefetch large message pages for sessions that are not opened yet
- load `todo` only when the side panel is visible
- keep `session.get` and `session.list`, but avoid pairing them immediately with `session.messages` unless the page actually needs the timeline
- add lightweight bootstrap variants for frequently fetched endpoints
- use `ETag` or revision headers for small mutable resources like `todo`, `config`, and `path`

This is the least invasive architectural change because it mostly changes request timing and payload selection rather than the data model.

### Why it helps

The trace shows extra background traffic around session load. Even if the message payload shape stays the same, not asking for it until needed reduces bandwidth immediately.

### Difficulty

**Low to medium**

Most of the work is in the app fetch policy, plus optional additive cache headers on the server.

### Bug risk

**Low to medium**

The main risk is stale or missing side-panel state because something that used to be eagerly loaded becomes lazy. That is usually easier to test than a new sync protocol.

## Option 4: Compression And Chunked File Reads

### Design

Make the transport layer and file APIs cheaper without changing the core session model:

- enable gzip or brotli for large JSON responses
- add chunked or preview reads for `GET /file/content`
- add preview modes for diff-heavy or file-heavy payloads where full text is not needed

### Why it helps

The large session payloads are mostly text and should compress well. This is a good baseline improvement even if a larger architectural change happens later.

### Difficulty

**Low**

Compression is usually a server middleware change. File chunking is a slightly larger but still localized API addition.

### Bug risk

**Low**

Compression is a mature mechanism. File chunking has some UX edge cases, but the blast radius is much smaller than changing session synchronization.

### Limitation

Compression helps bandwidth, but it does not fix server serialization cost, client parse cost, or repeated large fetches. It should be treated as a baseline improvement, not the full solution.

## Recommended Rollout

### Phase 1

Land the lowest-risk wins first:

1. enable compression for large JSON responses
2. stop background prefetch of full message pages where the UI only needs session metadata
3. lazily load `todo` and similar side data

### Phase 2

Attack the largest payload directly:

1. add `projection=summary` to `GET /session/:id/message`
2. switch timeline bootstrap and layout prefetch to the summary view
3. hydrate full message parts on demand for visible or expanded turns

### Phase 3

Only if network usage is still too high:

1. introduce SSE message deltas or another incremental sync model
2. use revisions so reconnecting clients can safely recover if they miss events

## Recommendation Summary

If the goal is the best bandwidth win per unit of risk, the strongest path is:

1. **Option 4 first** for cheap baseline savings
2. **Option 3 next** to reduce unnecessary fetches
3. **Option 1 as the main architectural fix** because it directly addresses the `21 MB` message response
4. **Option 2 only if needed** after the lighter payload path exists

In short:

- **biggest win:** message summaries plus lazy part hydration
- **easiest win:** compression and less eager fetching
- **highest risk:** full incremental delta sync
