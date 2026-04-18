# Ownsuite — Future Improvements

A design review of the current client-side data-flow model, with gaps to consider as usage grows. Not a commitment — a backlog for discussion.

## Context

Ownsuite is a thin **owner-scoped CRUD store**, not a query cache. Conceptually closer to Redux-Toolkit `createSlice` + thunks than to TanStack Query / SWR. The current design is honest and sufficient when consumers only need "the current user's Xs." The items below matter once UIs need multiple filtered views, pagination, or finer-grained pending/error signals.

## Where the current design aligns with best practice

- Store-per-domain FSM (`initializing → ready ↔ syncing → error`) exposed as a Svelte store — matches the idle/loading/success/error mental model.
- Optimistic update + per-row rollback on `update`/`delete`; no optimistic `create` (correct — no client-assigned id).
- Server as source of truth; no `localStorage` for owner-scoped data (avoids cross-user cache poisoning).
- 404-not-403 contract on ownership mismatches (avoids existence leaks).
- Transport-agnostic adapter boundary — easy to mock and test.
- Typed pubsub event bus for cross-domain coordination.
- **Mutation serialization + abort-supersede reads** (2.0) — eliminates the "stale-snapshot" class of races.
- **AbortSignal plumbing** through `ctx.signal` (2.0) — adapters opt into cancellation.
- **Explicit `destroy()` lifecycle** (2.0) — aborts in-flight work, clears subscribers.
- **`getOne()` no longer trips domain error** (2.0) — read misses don't invalidate the list view.

## Remaining gaps

### 1. Single list slot per domain — no query-keyed cache

`list(query)` stores one `rows` array per domain. Calling `list({ status: "open" })` then `list({ status: "closed" })` overwrites the same slot — you cannot hold two filtered views concurrently. The domain is effectively a singleton list, not a query cache.

**Biggest conceptual limit.** Everything else below is additive; this one is structural. Addressing it means moving from `state.data` to `state.queries: Map<queryKey, { rows, meta, lastSyncedAt }>`.

### 2. No staleness / revalidation policy

`lastSyncedAt` is tracked but unused. No `staleTime`, no focus/reconnect refetch, no TTL. Consumers orchestrate refresh manually.

**Possible direction:** per-domain `staleTime` config; optional focus/reconnect listeners behind a flag.

### 3. No per-row pending state during optimistic updates

During `syncing`, the list already reflects the optimistic mutation. Subscribers cannot distinguish "confirmed" rows from "pending" ones. TanStack exposes `isPending` per mutation.

**Possible direction:** track pending row ids in state; expose as a `Set<rowId>` alongside `rows`.

### 4. Error state still couples to data availability

One failed `update` puts the whole domain in `error`, even though `data` is still valid. Consumers rendering the list must remember to ignore `state === "error"` when `data` exists. 2.0 narrowed the blast radius (getOne no longer trips this), but the write path still does.

**Possible direction:** decouple — keep `state` at `ready`, surface the last error as a sibling signal (`lastError`). Modern pattern (TanStack `isError` + `data` can coexist).

### 5. No pagination / infinite-scroll primitives

`meta` is opaque `Record<string, unknown>`; cursor/offset merging is left to the consumer. Most real owner-scoped UIs (orders, addresses) eventually need this.

**Possible direction:** first-class `loadMore()` on the manager, with a pluggable merge strategy (append vs. replace vs. cursor).

### 6. `registerDomain` hard-codes `OwnedCollectionManager`

Already called out in `AGENTS.md`. Pluggability requires an API change later — cheaper to design the registration surface for it now than to migrate.

## Resolved in 2.0.0

- ~~Stale-snapshot race in create/update onSuccess~~ — `onSuccess` now reads the live store.
- ~~No request deduplication / in-flight cancellation~~ — mutations serialize; reads abort-supersede.
- ~~Whole-list rollback snapshot~~ — rollback is now per-row.
- ~~No `AbortSignal` plumbing~~ — adapters receive `ctx.signal`.
- ~~`getOne` trips whole-domain error state~~ — returns `null`, no state transition.
- ~~`update(id)` for absent id prepends phantom row~~ — no-op now.
- ~~`reset()` emits no event~~ — emits `domain:state:changed`.
- ~~No `destroy()` lifecycle~~ — `Ownsuite.destroy()` + `BaseDomainManager.destroy()` added.
- ~~Silent boot failures~~ — `suite.hasErrors()` / `suite.errors()` added.
- ~~`setContext` doesn't invalidate caches~~ — `{ replace, refresh }` options added.
- ~~`autoInitialize` dead `.catch()` code~~ — removed.
- ~~`initialize(['typo'])` silently no-ops~~ — logs a warning.
- ~~Mock adapter allows client-supplied `model_id`~~ — rejects by default.
- ~~Empty-string row ids accepted~~ — rejected in default `getRowId`.

## Prioritization sketch

1. **#4 decouple error from state** — small API change, big DX win.
2. **#3 per-row pending** — needed before any serious list UI.
3. **#1 query-keyed cache** — structural; defer until a concrete consumer needs two views of the same domain.
4. **#5 pagination** — defer until a concrete consumer needs it; design alongside #1.
5. Remaining items — opportunistic.
