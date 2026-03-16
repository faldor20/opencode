# Web Bandwidth Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce web bandwidth for remote browser/server usage by adding always-on compression plus an opt-in client behavior toggle for lazy history, reduced inactive-session prefetch, stronger recent-session reuse, and lazy diff hydration.

**Architecture:** Keep the current active-session timeline full fidelity and preserve existing endpoints where possible. Server transport compression is always on and independent from the client toggle, while client behavior changes are additive and reversible through a single persisted setting. Cached session reuse is guarded by a lightweight revision-marker lookup so stale cache is not treated as current.

**Tech Stack:** Bun, Hono, SolidJS, persisted app settings, existing global-sync/session cache infrastructure, Bun test, bun typecheck.

---

## File Structure

### App files

- Modify: `packages/app/src/context/settings.tsx`
  - add `general.bandwidthOptimization` default, accessor, and setter
- Modify: `packages/app/src/components/settings-general.tsx`
  - add the settings row and switch for the new global toggle
- Modify: `packages/app/src/i18n/en.ts`
  - add copy for the new settings row
- Modify: `packages/app/src/i18n/parity.test.ts`
  - keep locale key parity green
- Modify: `packages/app/src/pages/layout.tsx`
  - gate inactive-session full-message prefetch when the toggle is on
- Modify: `packages/app/src/pages/session.tsx`
  - gate history growth and diff-demand behavior when the toggle is on
- Modify: `packages/app/src/context/global-sync/types.ts`
  - store lightweight revision markers alongside cached session sections
- Modify: `packages/app/src/context/sync.tsx`
  - prefer cached state more aggressively on session switch, but only after revision-marker validation
- Modify: `packages/app/src/context/global-sync/session-cache.ts`
  - refine eviction/preservation semantics for recent-session reuse if needed
- Modify: `packages/app/src/context/global-sync/session-prefetch.ts`
  - align prefetch bookkeeping with the reduced-prefetch behavior if needed
- Modify/Test: `packages/app/src/context/global-sync/session-prefetch.test.ts`
- Modify/Test: `packages/app/src/context/global-sync/session-cache.test.ts`
- Modify/Test: `packages/app/src/context/global-sync/event-reducer.test.ts`
- Add/Test: `packages/app/src/context/global-sync/session-validity.test.ts`
- Modify/Test: `packages/app/src/context/sync-optimistic.test.ts`
- Add/Test: `packages/app/src/pages/session/history-window.test.ts`
- Add/Test: `packages/app/src/pages/session/diff-loading.test.ts`

### Server files

- Modify: `packages/opencode/src/server/server.ts`
  - enable compression on the main server app
- Modify: `packages/opencode/src/control-plane/workspace-server/server.ts`
  - enable compression on the workspace server app
- Add/Test: `packages/opencode/test/server/server-compression.test.ts`
- Modify only if required: `packages/opencode/src/server/routes/session.ts`
  - support lightweight revision-marker validity lookup and narrow diff-detail hydration if current diff API shape cannot support lazy patch loading cleanly
- Add/Test: `packages/opencode/test/server/session-validity.test.ts`
- Modify/Test: `packages/opencode/test/server/session-messages.test.ts`
- Modify/Test: `packages/opencode/test/session/messages-pagination.test.ts`
- Add/Test only if diff route changes: `packages/opencode/test/server/session-diff.test.ts`

## Chunk 1: Settings And Transport Baseline

### Task 1: Add the global bandwidth optimization setting

**Files:**

- Modify: `packages/app/src/context/settings.tsx`
- Modify: `packages/app/src/components/settings-general.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Test: `packages/app/src/i18n/parity.test.ts`

- [ ] **Step 1: Write the failing parity/update test expectation**

Add the new translation keys to `packages/app/src/i18n/en.ts` first and verify `packages/app/src/i18n/parity.test.ts` still enforces full locale coverage.

- [ ] **Step 2: Run the parity test to establish the starting point**

Run: `bun test src/i18n/parity.test.ts`
Expected: either PASS immediately after adding all needed keys, or FAIL until missing locale coverage is addressed according to repo conventions.

- [ ] **Step 3: Add persisted settings support**

In `packages/app/src/context/settings.tsx`:

- add `bandwidthOptimization: false` under `general`
- expose `bandwidthOptimization()` accessor
- expose `setBandwidthOptimization(value: boolean)` setter
- ensure missing persisted values fall back to `false` without a migration script
- keep naming aligned with the existing settings shape

- [ ] **Step 4: Add the settings UI row**

In `packages/app/src/components/settings-general.tsx`:

- add a `SettingsRow` with a `Switch`
- place it near other timeline/behavior settings in the General section
- wire it to `settings.general.bandwidthOptimization()` and `setBandwidthOptimization`
- add `data-action` for testability and consistency

- [ ] **Step 5: Add translation copy**

In `packages/app/src/i18n/en.ts` add keys for:

- `settings.general.row.bandwidthOptimization.title`
- `settings.general.row.bandwidthOptimization.description`

The description should explain that it reduces background/history bandwidth and may delay loading until needed.

- [ ] **Step 6: Run app verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/i18n/parity.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/context/settings.tsx packages/app/src/components/settings-general.tsx packages/app/src/i18n/en.ts packages/app/src/i18n/parity.test.ts
git commit -m "feat(app): add bandwidth optimization setting"
```

### Task 2: Enable always-on compression on both web server entry points

**Files:**

- Modify: `packages/opencode/src/server/server.ts`
- Modify: `packages/opencode/src/control-plane/workspace-server/server.ts`
- Add/Test: `packages/opencode/test/server/server-compression.test.ts`
- Modify/Test: `packages/opencode/test/server/session-messages.test.ts`

- [ ] **Step 1: Write or extend server tests around compressed heavy responses**

Add a focused test in `packages/opencode/test/server/server-compression.test.ts` that exercises a compressible JSON route and verifies the response takes the compression path under a compress-capable request. Extend `packages/opencode/test/server/session-messages.test.ts` only if a session-specific assertion is needed.

- [ ] **Step 2: Run the server test to verify the gap exists**

Run: `cd /home/eli/Code/js/opencode/packages/opencode && bun test test/server/server-compression.test.ts test/server/session-messages.test.ts`
Expected: FAIL or missing assertion coverage before implementation.

- [ ] **Step 3: Add compression middleware to the main server**

In `packages/opencode/src/server/server.ts`:

- use the Hono compression middleware in the main app pipeline
- place it so route responses benefit without interfering with auth/cors/error handling
- keep SSE behavior safe; do not compress paths that should remain streaming-incompatible if the middleware requires exclusions

- [ ] **Step 4: Add compression middleware to the workspace server**

In `packages/opencode/src/control-plane/workspace-server/server.ts`:

- apply the same compression strategy to the workspace server Hono app
- keep behavior aligned with the main server so proxied and direct session traffic behave consistently

- [ ] **Step 5: Run server verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/opencode && bun test test/server/server-compression.test.ts test/server/session-messages.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/server/server.ts packages/opencode/src/control-plane/workspace-server/server.ts packages/opencode/test/server/server-compression.test.ts packages/opencode/test/server/session-messages.test.ts
git commit -m "feat(server): enable web response compression"
```

## Chunk 2: Client Bandwidth Behavior Changes

### Task 3: Add lightweight session validity lookup for cached sections

**Files:**

- Modify: `packages/opencode/src/server/routes/session.ts`
- Modify: `packages/app/src/context/global-sync/types.ts`
- Modify: `packages/app/src/context/sync.tsx`
- Add/Test: `packages/app/src/context/global-sync/session-validity.test.ts`
- Add/Test: `packages/opencode/test/server/session-validity.test.ts`

- [ ] **Step 1: Write the failing server validity test**

Add `packages/opencode/test/server/session-validity.test.ts` covering a small validity response that returns revision markers for at least messages, todos, diffs, and status without returning full payloads.

- [ ] **Step 2: Run the server validity test to verify the gap exists**

Run: `cd /home/eli/Code/js/opencode/packages/opencode && bun test test/server/session-validity.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Add the lightweight validity route**

In `packages/opencode/src/server/routes/session.ts`:

- add the smallest possible metadata endpoint or parameter that returns only per-session revision markers
- ensure markers change whenever cached `message`, `todo`, `diff`, or `session_status` data would become stale
- do not return full session payloads from this lookup
- do not add general sync semantics

- [ ] **Step 4: Write the failing client validity test**

Add `packages/app/src/context/global-sync/session-validity.test.ts` covering:

- matching markers -> cache is treated as current
- mismatched message marker -> only message state is refetched
- failed lookup -> existing safe fetch path runs instead of blindly trusting cache

- [ ] **Step 5: Run the focused client validity test**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/global-sync/session-validity.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 6: Store revision markers in the cache shape**

In `packages/app/src/context/global-sync/types.ts`:

- add fields for `messages_revision`, `todo_revision`, `diff_revision`, and `status_revision` or the repo-consistent equivalent naming
- keep the shape small and colocated with existing cached session data

- [ ] **Step 7: Use validity lookup before trusting cache on switch**

In `packages/app/src/context/sync.tsx`:

- call the lightweight validity lookup on session switch/revisit before treating cached sections as current
- skip heavy reloads when all markers match
- if markers differ, refresh only the stale sections
- if the validity lookup fails, fall back to the existing safe fetch path

- [ ] **Step 8: Run verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/opencode && bun test test/server/session-validity.test.ts && bun typecheck`
Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/global-sync/session-validity.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/opencode/src/server/routes/session.ts packages/opencode/test/server/session-validity.test.ts packages/app/src/context/global-sync/types.ts packages/app/src/context/sync.tsx packages/app/src/context/global-sync/session-validity.test.ts
git commit -m "feat(sync): validate cached session state with revisions"
```

### Task 4: Reduce inactive-session full-message prefetch behind the toggle

**Files:**

- Modify: `packages/app/src/pages/layout.tsx`
- Modify/Test: `packages/app/src/context/global-sync/session-prefetch.ts`
- Test: `packages/app/src/context/global-sync/session-prefetch.test.ts`

- [ ] **Step 1: Write the failing prefetch tests**

Add tests that cover:

- optimization off -> existing prefetch eligibility still works
- optimization on -> inactive-session full-message prefetch is skipped or reduced
- high-priority navigation paths do not accidentally schedule the old full first-page fetch path

- [ ] **Step 2: Run the focused prefetch test**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/global-sync/session-prefetch.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Gate prefetch policy in layout**

In `packages/app/src/pages/layout.tsx`:

- read `settings.general.bandwidthOptimization()`
- stop scheduling full-message prefetch for inactive sessions when enabled
- preserve existing queue/dedupe structure when disabled
- keep the active session and keyboard navigation paths coherent

- [ ] **Step 4: Adjust prefetch bookkeeping if needed**

In `packages/app/src/context/global-sync/session-prefetch.ts`:

- update TTL/skip bookkeeping only if the new no-prefetch or tiny-window policy needs different metadata handling
- avoid broad refactors if the existing helper already fits

- [ ] **Step 5: Run app verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/global-sync/session-prefetch.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/layout.tsx packages/app/src/context/global-sync/session-prefetch.ts packages/app/src/context/global-sync/session-prefetch.test.ts
git commit -m "feat(app): reduce inactive session prefetch"
```

### Task 5: Keep older history loading strictly user driven behind the toggle

**Files:**

- Modify: `packages/app/src/pages/session.tsx`
- Modify/Test: `packages/app/src/context/sync.tsx`
- Add/Test: `packages/app/src/pages/session/history-window.test.ts`

- [ ] **Step 1: Add a focused failing test for history growth behavior**

Cover:

- optimization off -> current eager/prefetch behavior remains
- optimization on -> older history is fetched only through explicit upward scroll/reveal paths
- scroll position remains stable after prepend

- [ ] **Step 2: Run the focused history test**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/pages/session/history-window.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Gate history behavior in the session page**

In `packages/app/src/pages/session.tsx`:

- read the setting
- keep active-session initial load intact
- disable non-user-driven history growth when optimization is enabled
- preserve the explicit `loadAndReveal` and back-scroll paths
- success means initial open still fetches the newest page, while older pages appear only after back-scroll or explicit reveal

- [ ] **Step 4: Ensure sync-layer fetch behavior still matches the UI contract**

In `packages/app/src/context/sync.tsx`:

- confirm initial page loading still happens
- keep `history.loadMore(sessionID)` behavior unchanged for explicit requests
- avoid hidden forced reloads that defeat the toggle intent

- [ ] **Step 5: Run app verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/pages/session/history-window.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session.tsx packages/app/src/context/sync.tsx packages/app/src/pages/session/history-window.test.ts
git commit -m "feat(app): make older history scroll driven"
```

### Task 6: Make diff loading demand driven and keep patch detail lazy

**Files:**

- Modify: `packages/app/src/pages/session.tsx`
- Modify: `packages/app/src/context/sync.tsx`
- Modify: `packages/opencode/src/server/routes/session.ts` (only if diff detail needs a narrow endpoint change)
- Add/Test: `packages/app/src/pages/session/diff-loading.test.ts`
- Add/Test only if API changes: `packages/opencode/test/server/session-diff.test.ts`

- [ ] **Step 1: Write the failing diff-demand tests**

Cover:

- diff metadata is not loaded until the review surface/file tree needs it
- detailed patch content is not requested until a diff item expands
- toggle off preserves the current eager behavior if the current UI intentionally fetches sooner

- [ ] **Step 2: Run the focused diff test**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/pages/session/diff-loading.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Tighten client-side diff demand logic**

In `packages/app/src/pages/session.tsx` and `packages/app/src/context/sync.tsx`:

- keep metadata fetch tied to actual review-surface demand
- prevent unnecessary forced refetches when optimization is enabled
- leave the current path untouched when the toggle is off
- success means unopened review UI triggers no diff request, opening review fetches metadata only, and expanding an item is the first point where patch detail may load

- [ ] **Step 4: Add narrow server support only if required**

If the existing diff route cannot support lazy patch hydration cleanly:

- add the smallest possible diff-detail endpoint or parameter in `packages/opencode/src/server/routes/session.ts`
- keep it limited to per-diff detail loading
- do not introduce general sync semantics

- [ ] **Step 5: Run verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/pages/session/diff-loading.test.ts && bun typecheck`
If server changed, also run: `cd /home/eli/Code/js/opencode/packages/opencode && bun test test/server/session-diff.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/pages/session.tsx packages/app/src/context/sync.tsx packages/app/src/pages/session/diff-loading.test.ts packages/opencode/src/server/routes/session.ts packages/opencode/test/server/session-diff.test.ts
git commit -m "feat(session): lazy load diff details"
```

## Chunk 3: Stronger Recent-Session Reuse

### Task 7: Prefer cached session state immediately on switch after validity passes

**Files:**

- Modify: `packages/app/src/context/sync.tsx`
- Modify: `packages/app/src/context/global-sync/event-reducer.ts`
- Test: `packages/app/src/context/sync-optimistic.test.ts`
- Test: `packages/app/src/context/global-sync/event-reducer.test.ts`

- [ ] **Step 1: Write the failing cache-reuse tests**

Cover:

- switching back to a session with cached messages uses cached state immediately only after marker validation passes
- mismatched section markers cause only those stale sections to refresh
- existing events still update cached session state correctly
- a forced reload path still exists when explicitly requested or when cache is missing

- [ ] **Step 2: Run the focused cache-reuse tests**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/sync-optimistic.test.ts src/context/global-sync/event-reducer.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Strengthen cached render and fetch policy**

In `packages/app/src/context/sync.tsx`:

- prefer cached message/todo/diff state immediately on switch after the validity lookup succeeds
- avoid redundant full session reloads when existing cache is already validated as usable
- keep explicit force paths intact
- success means the first paint after switching can come from cache when markers match, while mismatched markers trigger only section-level refreshes

- [ ] **Step 4: Preserve event-driven freshness semantics**

In `packages/app/src/context/global-sync/event-reducer.ts`:

- ensure updates still merge correctly into cached state
- avoid regressions where stronger reuse leaves stale arrays unpatched during active sessions

- [ ] **Step 5: Run app verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/sync-optimistic.test.ts src/context/global-sync/event-reducer.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/context/sync.tsx packages/app/src/context/global-sync/event-reducer.ts packages/app/src/context/sync-optimistic.test.ts packages/app/src/context/global-sync/event-reducer.test.ts
git commit -m "feat(app): reuse recent session state on switch"
```

### Task 8: Refine session cache eviction for recently reused sessions

**Files:**

- Modify: `packages/app/src/context/global-sync/session-cache.ts`
- Modify/Test: `packages/app/src/context/global-sync/session-cache.test.ts`
- Modify if needed: `packages/app/src/pages/layout.tsx`

- [ ] **Step 1: Write the failing eviction-policy test**

Cover:

- active session is preserved
- very recently reused sessions survive normal eviction pressure longer
- stale sessions are still evicted so memory growth stays bounded

- [ ] **Step 2: Run the focused cache test**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/global-sync/session-cache.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Implement the smallest useful eviction refinement**

In `packages/app/src/context/global-sync/session-cache.ts`:

- improve preservation semantics for recently accessed sessions
- keep the code small and compatible with current callers
- do not introduce a large cache framework unless clearly necessary

- [ ] **Step 4: Update callers only if required**

If the new eviction plan needs extra data from callers, update `packages/app/src/pages/layout.tsx` or other call sites with the minimum plumbing required.

- [ ] **Step 5: Run app verification for this task**

Run: `cd /home/eli/Code/js/opencode/packages/app && bun test src/context/global-sync/session-cache.test.ts && bun typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/context/global-sync/session-cache.ts packages/app/src/context/global-sync/session-cache.test.ts packages/app/src/pages/layout.tsx
git commit -m "feat(app): improve recent session cache retention"
```

## Final Verification

- [ ] **Step 1: Run targeted app tests**

Run:

```bash
cd /home/eli/Code/js/opencode/packages/app && bun test src/i18n/parity.test.ts src/context/global-sync/session-prefetch.test.ts src/context/global-sync/session-cache.test.ts src/context/global-sync/event-reducer.test.ts src/context/global-sync/session-validity.test.ts src/context/sync-optimistic.test.ts src/pages/session/history-window.test.ts src/pages/session/diff-loading.test.ts
```

Expected: PASS

- [ ] **Step 2: Run targeted server tests**

Run:

```bash
cd /home/eli/Code/js/opencode/packages/opencode && bun test test/server/server-compression.test.ts test/server/session-validity.test.ts test/server/session-messages.test.ts test/session/messages-pagination.test.ts
```

Expected: PASS

- [ ] **Step 3: Run typecheck in both packages**

Run:

```bash
cd /home/eli/Code/js/opencode/packages/app && bun typecheck
cd /home/eli/Code/js/opencode/packages/opencode && bun typecheck
```

Expected: PASS

- [ ] **Step 4: Run manual bandwidth verification**

Verify in the browser/network panel:

- toggle off preserves current eager behavior
- toggle on reduces inactive-session message prefetch
- toggle on keeps older history fetches tied to user back-scroll
- switching back to a recent session first performs the lightweight validity lookup, then paints from cache only when markers match
- marker mismatches trigger only section-level refreshes instead of whole-session reloads
- diff requests are delayed until the review surface and diff expansion require them
- compressed responses carry the expected encoding behavior for large payloads

## Notes For The Implementor

- Do not add Phase 3 or Phase 4 work from the earlier proposal.
- Do not introduce general sync endpoints; the revision-marker validity lookup is the only additive metadata API allowed for cache correctness.
- Keep comments focused on why the toggle gates behavior and why compression stays independent.
- Prefer the smallest additive server API change possible if diff patch hydration needs extra support.
- Run tests from `packages/app` and `packages/opencode`, never from repo root.
- If you follow the per-task commit flow above, do not add an extra wrap-up commit unless explicitly requested.
