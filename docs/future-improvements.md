# Ownsuite — Future Improvements

A design review of the current client-side data-flow model, with gaps to consider as usage grows. Not a commitment — a backlog for discussion.

## Context

Ownsuite is a thin **owner-scoped CRUD store**, not a query cache. Conceptually closer to Redux-Toolkit `createSlice` + thunks than to TanStack Query / SWR. The current design is honest and sufficient when consumers only need "the current user's Xs." The items below matter once UIs need multiple filtered views, pagination, or finer-grained pending/error signals.

## Where the current design aligns with best practice

- Store-per-domain FSM (`initializing → ready ↔ syncing → error`) exposed as a Svelte store — matches the idle/loading/success/error mental model.
- Optimistic update + rollback snapshot on `update`/`delete`; no optimistic `create` (correct — no client-assigned id).
- Server as source of truth; no `localStorage` for owner-scoped data (avoids cross-user cache poisoning).
- 404-not-403 contract on ownership mismatches (avoids existence leaks).
- Transport-agnostic adapter boundary — easy to mock and test.
- Typed pubsub event bus for cross-domain coordination.

## Gaps / potential improvements

### 1. No request deduplication or in-flight cancellation

Two quick `refresh()` calls (route remount, focus event) produce parallel `list()` calls and a last-write-wins race. SWR/TanStack dedupe by key; ownsuite does not.

**Possible direction:** track an in-flight promise per operation key; coalesce concurrent callers.

### 2. Single list slot per domain — no query-keyed cache

`list(query)` stores one `rows` array per domain. Calling `list({ status: "open" })` then `list({ status: "closed" })` overwrites the same slot — you cannot hold two filtered views concurrently. The domain is effectively a singleton list, not a query cache.

**Biggest conceptual limit.** Everything else below is additive; this one is structural. Addressing it means moving from `state.data` to `state.queries: Map<queryKey, { rows, meta, lastSyncedAt }>`.

### 3. No staleness / revalidation policy

`lastSyncedAt` is tracked but unused. No `staleTime`, no focus/reconnect refetch, no TTL. Consumers orchestrate refresh manually.

**Possible direction:** per-domain `staleTime` config; optional focus/reconnect listeners behind a flag.

### 4. No per-row pending state during optimistic updates

During `syncing`, the list already reflects the optimistic mutation. Subscribers cannot distinguish "confirmed" rows from "pending" ones. TanStack exposes `isPending` per mutation.

**Possible direction:** track pending row ids in state; expose as a `Set<rowId>` alongside `rows`.

### 5. Error state couples to data availability

One failed `update` puts the whole domain in `error`, even though `data` is still valid. Consumers rendering the list must remember to ignore `state === "error"` when `data` exists.

**Possible direction:** decouple — keep `state` at `ready`, surface the last error as a sibling signal (`lastError`). Modern pattern (TanStack `isError` + `data` can coexist).

### 6. `initialize()` swallows errors

Documented behavior, but easy to miss: a silent boot failure is invisible unless you subscribe to `domain:error`.

**Possible direction:** add `suite.hasErrors()` / `suite.getErrors()` helpers to reduce footguns.

### 7. Whole-list rollback snapshot

Fine for small lists, expensive for large ones. Per-row reverse-patch would scale better. Probably YAGNI at current usage — flag for later.

### 8. No pagination / infinite-scroll primitives

`meta` is opaque `Record<string, unknown>`; cursor/offset merging is left to the consumer. Most real owner-scoped UIs (orders, addresses) eventually need this.

**Possible direction:** first-class `loadMore()` on the manager, with a pluggable merge strategy (append vs. replace vs. cursor).

### 9. `registerDomain` hard-codes `OwnedCollectionManager`

Already called out in `AGENTS.md`. Pluggability requires an API change later — cheaper to design the registration surface for it now than to migrate.

### 10. No `AbortSignal` plumbing through the adapter

Component unmount cannot cancel in-flight fetches; results land in a detached store and may overwrite fresher data.

**Possible direction:** thread an `AbortSignal` through adapter method signatures; abort on `refresh()` supersession and on manager disposal.

## Prioritization sketch

Rough order if tackled:

1. **#10 AbortSignal** — cheap, unblocks correctness for SPA navigation.
2. **#1 dedup** — cheap, removes a whole class of races.
3. **#5 decouple error from state** — small API change, big DX win.
4. **#4 per-row pending** — needed before any serious list UI.
5. **#2 query-keyed cache** — structural; defer until a concrete consumer needs two views of the same domain.
6. **#8 pagination** — defer until a concrete consumer needs it; design alongside #2.
7. Remaining items — opportunistic.
