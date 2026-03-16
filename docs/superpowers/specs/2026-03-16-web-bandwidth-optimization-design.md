# Web Bandwidth Optimization Design

## Goal

Reduce the amount of data the web UI moves between client and server when the browser and server are not on the same machine, without degrading the active-session timeline experience.

## Product Constraints

The timeline is the main product surface, not a secondary detail panel. Real usage means users spend most of their time in the timeline, scroll backward through older turns, switch sessions frequently, revisit recently opened sessions, and expect diffs and todos to stay coherent while a session is active.

That rules out a summary-first timeline design. The active session should continue to use real message data. Bandwidth work should focus on avoiding repeated transfers of history and session state the client either does not need yet or already has.

## Scope

### In Scope

- Always-on transport compression for heavy request and response bodies.
- One global web-app toggle for bandwidth optimization behavior.
- Scroll-driven loading for older session history.
- Reduced or removed eager full-message prefetch for inactive sessions.
- Stronger reuse of recent per-session client caches when switching sessions.
- Lightweight cache-validity lookups so recent session caches are only trusted when their revision markers still match the server.
- Lazy diff hydration so the client loads only the diff data the UI currently needs.

### Out of Scope

- New message, todo, or diff sync endpoints.
- Revision-aware catch-up or reconnect protocols.
- Event model changes.
- Summary-row timeline redesign.
- Server/admin-only feature-flag infrastructure for this iteration.

## Final Direction

The implementation should use a two-part strategy:

1. Enable compression at the server transport layer for all large text and JSON payloads.
2. Add a client setting named `bandwidthOptimization` that gates the bandwidth-saving behavior changes only, including cache reuse that is guarded by cheap revision lookups.

This keeps the rollout reversible where the risk is highest. If the client-side behavior changes cause UX regressions, users can disable them and fall back to current eager behavior. Compression remains enabled regardless of toggle state because it is a low-risk baseline improvement.

## Toggle Design

### Setting

- Name: `settings.general.bandwidthOptimization`
- Type: boolean
- Initial default: `false`
- Persistence: existing app settings persistence in `packages/app/src/context/settings.tsx`
- Surface: general settings screen in `packages/app/src/components/settings-general.tsx`
- Migration behavior: existing saved settings with no value for this key should fall back to `false` without a one-off migration script

### Behavior When Enabled

- Older message history stays behind user scroll/back-scroll behavior instead of eager background loading.
- Inactive-session prefetch stops fetching full message pages.
- Session switching prefers cached session state immediately when available.
- Diff data loads on demand instead of eagerly materializing the full diff payload path up front.

### Behavior When Disabled

- Existing eager client behavior remains the fallback path.
- Full-message prefetch behavior remains available.
- Existing history/prefetch behavior remains intact.
- Compression still remains enabled.

### Rollout Intent

The first shipped version should default the toggle to `false` for safety. Once the behavior is validated, the default can be revisited in a later change without redesigning the system.

## Architecture

### 1. Transport Compression Is Always On

Compression should be applied at the Hono/Bun server layer in both:

- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/control-plane/workspace-server/server.ts`

The implementation should cover heavy text and JSON payloads, including:

- session message pages
- session diff payloads
- session todo payloads
- text-heavy file responses
- prompt transport such as `prompt_async`

This work is independent from the client toggle. If compression support causes operational issues, rollback is a deploy/config decision at the server layer rather than a user setting.

### 2. History Loading Remains Real But Older Pages Stay Lazy

The existing paginated message flow already supports `before` cursor loading. The design should keep that transport and tighten policy around it.

Relevant files:

- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/pages/session.tsx`

Design rules:

- Initial session open still loads the newest page of real messages.
- Older history pages load only when the user scrolls back or explicitly triggers reveal/loading.
- When `bandwidthOptimization` is off, current eager behavior remains available.
- When `bandwidthOptimization` is on, background history growth should stay disabled or sharply reduced unless driven by user navigation within the timeline.

### 3. Session Switching Reuses Local State Aggressively

The client already caches per-session message, part, todo, diff, and status data. The design should make that cache act more like a real recent-session reuse layer.

Relevant files:

- `packages/app/src/context/global-sync/types.ts`
- `packages/app/src/context/global-sync/session-cache.ts`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/pages/layout.tsx`

Design rules:

- When switching back to a recently viewed session, validate cache freshness with a cheap metadata lookup before trusting cached session sections.
- Avoid re-fetching message pages on switch when a valid recent cache already exists.
- Keep existing SSE-driven live updates as the way active caches stay fresh.
- Improve eviction policy to better preserve recently accessed sessions instead of relying on a simple recency-only message-prefetch path.

### 4. Cache Validity Uses Lightweight Revision Markers

This iteration needs an efficient way to prevent stale cached session data from being shown as if it were current. The client should not blindly trust cached `message`, `todo`, `diff`, or `session_status` data on session switch.

Relevant files:

- `packages/opencode/src/server/routes/session.ts`
- `packages/app/src/context/global-sync/types.ts`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/context/global-sync/session-cache.ts`

Design rules:

- Add a lightweight session-validity lookup that returns small revision markers instead of full payloads.
- Revision markers should exist at least for messages, todos, diffs, and status.
- The client should compare cached markers to server markers before treating cached sections as current.
- If all markers match, reuse cache and skip heavy reloads.
- If only some markers differ, revalidate only the stale sections instead of reloading the whole session.
- If the validity lookup fails, fall back to the existing safe fetch path rather than trusting possibly stale cache.

This is metadata-only validation, not a new sync protocol.

### 5. Diff Loading Becomes Demand Driven

The current session page already delays diff loading until the review surface is wanted, but the refresh path still assumes the full session diff payload is the unit of loading. This iteration should make the lazy behavior explicit and keep heavy patch bodies behind a second level of demand.

Relevant files:

- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/use-session-commands.tsx`
- `packages/app/src/context/sync.tsx`
- `packages/opencode/src/server/routes/session.ts`

Design rules:

- Do not fetch diff data until the file tree/review surface is opened.
- Prefer returning diff metadata first.
- Fetch patch or hunk bodies only when the user expands a diff item or otherwise requests the detailed patch.
- If a small additive API change is needed for patch hydration, it must be limited to diff detail loading only and must not become a general sync-endpoint project.

This is the only place where a narrowly scoped additive API change is allowed in this design.

## Detailed Behavior by Area

### Session Prefetch

Relevant file: `packages/app/src/pages/layout.tsx`

Current behavior prefetches full message pages for nearby inactive sessions. That duplicates large payloads and competes with the active session for bandwidth.

Design:

- With optimization off, preserve current prefetch behavior.
- With optimization on, stop prefetching full message pages for inactive sessions.
- If some prefetch remains, it should be metadata-only or a much smaller newest window, not the current full first-page strategy.
- Preserve the existing queue and dedupe structure where possible instead of rewriting it from scratch.

### Session History Window

Relevant file: `packages/app/src/pages/session.tsx`

The current history window already bounds rendered turns and can fetch older history during upward navigation.

Design:

- With optimization on, keep history strictly back-scroll driven.
- Keep the active view fully usable with real messages.
- Avoid auto-growing history behind the user unless the interaction clearly asked for it.
- Preserve scroll position during backfill and prepend.

### Cache Correctness

Relevant files:

- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/context/global-sync/session-cache.ts`
- `packages/app/src/context/sync.tsx`

We are not adding new catch-up APIs in this iteration, so cache correctness depends on lightweight validity lookups before reuse plus existing fetches and live events while the session is active.

Design:

- Cached state is only considered current after its revision markers pass the lightweight validity lookup.
- Existing fetch paths may still refresh after paint when needed, but should not block first render if the cache is both present and validated.
- If only part of the cache is stale, refresh only that section.
- Missed-event recovery remains the existing fallback behavior for now.
- Eviction must not remove the active session or the most recently reused sessions too aggressively.

## File Map

### App Files

- `packages/app/src/context/settings.tsx`
  - add persisted toggle state and accessors
- `packages/app/src/components/settings-general.tsx`
  - expose the toggle in settings UI
- `packages/app/src/pages/layout.tsx`
  - gate inactive-session prefetch behavior
- `packages/app/src/pages/session.tsx`
  - gate scroll-driven history behavior and diff-on-demand behavior
- `packages/app/src/context/sync.tsx`
  - tighten reuse of cached message, todo, and diff state and run revision-marker validation on switch
- `packages/app/src/context/global-sync/types.ts`
  - store lightweight revision markers alongside cached session sections
- `packages/app/src/context/global-sync/session-cache.ts`
  - refine cache eviction semantics
- `packages/app/src/context/global-sync/session-prefetch.ts`
  - adjust prefetch bookkeeping to match the new reduced-prefetch policy
- `packages/app/src/context/global-sync/event-reducer.ts`
  - ensure event-driven cache updates continue to work with stronger reuse
- `packages/app/src/i18n/*.ts`
  - add settings copy for the new toggle

### Server Files

- `packages/opencode/src/server/server.ts`
  - enable response compression on the main server
- `packages/opencode/src/control-plane/workspace-server/server.ts`
  - enable the same compression behavior on the workspace server path
- `packages/opencode/src/server/routes/session.ts`
  - keep pagination behavior as-is, add lightweight revision-marker validity support, and add narrow diff-detail support only if lazy patch hydration requires it

### Likely Tests

- `packages/app/src/context/global-sync/session-prefetch.test.ts`
- `packages/app/src/context/global-sync/session-cache.test.ts`
- `packages/app/src/context/global-sync/event-reducer.test.ts`
- `packages/app/src/context/sync-optimistic.test.ts`
- `packages/app/src/context/global-sync/session-validity.test.ts`
- `packages/opencode/test/server/session-validity.test.ts`
- `packages/opencode/test/server/session-messages.test.ts`
- `packages/opencode/test/session/messages-pagination.test.ts`
- one new or existing server test near diff/session routes if diff detail hydration changes server behavior

## Phases

### Phase 1: Cheap Wins

- enable transport compression on both server entry points
- add the global app toggle with default `false`
- reduce or remove full-message prefetch for inactive sessions when toggle is on
- keep older history loading strictly user driven when toggle is on
- make diff metadata and patch hydration demand driven

### Phase 2: Better Session Reuse

- add lightweight revision-marker validity lookup for cached session sections
- strengthen recent-session cache reuse on switch
- show cached state immediately when it exists and has passed the validity check
- revalidate only stale sections when markers differ
- improve cache preservation and eviction behavior for recently accessed sessions

### Removed From This Plan

The following earlier ideas are intentionally not part of this implementation:

- message sync endpoints
- todo sync endpoints
- diff sync endpoints
- explicit reconnect/catch-up protocol work
- event-repair architecture changes

The one additive API exception that is still allowed is a lightweight session-validity lookup that returns revision markers only.

## Rollout And Fallback

### Client-Side Fallback

- The new setting is the rollback path for client behavior.
- If users hit regressions, turning the toggle off restores existing eager behavior.

### Server-Side Fallback

- Compression is deployed independently from the toggle.
- If compression causes operational issues, rollback happens at deploy/config level by reverting the server change.
- The spec does not require a user-facing compression toggle.

## Success Criteria

- Switching back to a recently viewed session usually reuses local state instead of re-downloading the same message page.
- Cached session state is not treated as current unless its revision markers still match the server.
- Inactive-session background traffic drops materially when optimization is enabled.
- The active-session timeline still shows real message data and remains fully usable.
- Older history is fetched only when the user scrolls back or explicitly asks for more.
- Diff payload transfer is reduced because detailed patch bodies are deferred until needed.
- Compression lowers the cost of the remaining heavy payloads.

## Verification

Run verification from package directories, not repo root.

App package:

```bash
cd packages/app && bun test src/context/global-sync/session-prefetch.test.ts src/context/global-sync/session-cache.test.ts src/context/global-sync/event-reducer.test.ts src/context/global-sync/session-validity.test.ts src/context/sync-optimistic.test.ts
cd packages/app && bun typecheck
```

Server package:

```bash
cd packages/opencode && bun test test/server/session-validity.test.ts test/server/session-messages.test.ts test/session/messages-pagination.test.ts
cd packages/opencode && bun typecheck
```

Manual verification should also compare network behavior with the toggle on vs off:

- open a session and confirm only the newest history page loads initially
- scroll upward and confirm older pages load on demand
- switch between recent sessions and confirm cache reuse happens only after the lightweight validity lookup agrees the cached sections are still current
- force a stale marker mismatch and confirm only the stale session sections refetch
- open the review surface and confirm diff requests are delayed until needed
- inspect response headers and confirm compression is applied to heavy payloads where supported

## Open Follow-Up Items

These are intentionally deferred rather than left ambiguous:

- whether the toggle should default to `true` in a future release
- whether diff detail hydration can be implemented entirely from the current API shape
- whether future reconnect/catch-up work should extend the event model or add dedicated sync endpoints
