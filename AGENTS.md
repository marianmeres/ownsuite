# AGENTS.md - @marianmeres/ownsuite

Machine-readable documentation for AI coding assistants.

## Package Overview

```yaml
name: "@marianmeres/ownsuite"
version: "2.0.0"
type: "library"
language: "typescript"
runtime: "deno"
npm_compatible: true
license: "MIT"
entry: "./src/mod.ts"
```

## Purpose

Client-side helper library for **owner-scoped** UIs. Generic domain managers for CRUD over collections where every row is implicitly filtered to the authenticated subject by the server. Mirrors the shape of `@marianmeres/ecsuite` but applies to arbitrary owner-scoped collections instead of hard-coded e-commerce domains.

Pairs with:
- **`@marianmeres/collection`** — `ownerIdScope` route hook (read-side owner enforcement).
- **`@marianmeres/stack-common`** — `ownsuiteOptions()` server helper for mounting `/me/*` routes.

## Architecture

```
Ownsuite (orchestrator)
├── #pubsub           (shared event bus, cleared on destroy)
├── #context          (propagated to all domains on setContext)
└── domains: Map<string, OwnedCollectionManager>
      ├── store           (Svelte-compatible DomainStateWrapper<OwnedCollectionState<TRow>>)
      ├── adapter         (OwnedCollectionAdapter)
      ├── state machine:  initializing → ready ↔ syncing → error
      ├── optimistic update + per-row rollback on update/delete
      ├── mutation chain  (serial create/update/delete)
      ├── abort-supersede (initialize/refresh — newer call aborts older)
      └── destroy()       (aborts in-flight ops, drops adapter)
```

Each domain holds one list of rows. List operations replace the list wholesale; single-row ops mutate it in place so subscribers see stable references.

### Concurrency model

- **Mutations serialize** per manager via an internal promise chain. A
  `create/update/delete` that starts while another is in-flight queues
  behind it; callers still receive their own result through the returned
  promise. Rejections on the chain are swallowed so they do not block
  later mutations.
- **Reads abort-supersede**: a new `initialize()` or `refresh()` aborts
  any in-flight read on the same manager. The aborted call resolves
  without writing to the store.
- **onSuccess uses live data, not a captured snapshot**, so interleaving
  reads and mutations never resurrect deleted rows or clobber writes.
- **Rollback is per-row**: a failed `update` reverts just the updated
  row; a failed `delete` re-inserts the deleted row at its original
  position. An interleaved refresh that brought new rows is preserved.
- **AbortSignal plumbing**: every adapter call receives
  `ctx.signal: AbortSignal`. `reset()` and `destroy()` abort all active
  signals. Adapters should forward the signal to `fetch()` — ignoring
  it is safe but leaves abandoned requests running.

## Directory Structure

```
src/
├── mod.ts                      # entry, re-exports all
├── ownsuite.ts                 # Ownsuite class, createOwnsuite, OwnsuiteConfig
├── types/
│   ├── mod.ts
│   ├── state.ts                # DomainState/Wrapper/Error, OwnsuiteContext, OwnedCollectionState
│   ├── events.ts               # OwnsuiteEventType, OwnsuiteEvent union, per-event interfaces
│   └── adapter.ts              # OwnedCollectionAdapter, OwnedListResult, OwnedRowResult
├── domains/
│   ├── mod.ts
│   ├── base.ts                 # BaseDomainManager abstract class (mirrors ecsuite)
│   └── owned-collection.ts     # OwnedCollectionManager<TRow, TCreate, TUpdate>
└── adapters/
    ├── mod.ts
    └── mock.ts                 # createMockOwnedCollectionAdapter for tests
tests/
└── ownsuite.test.ts
```

## Key Exports

```typescript
// Main
export { Ownsuite, createOwnsuite } from "./ownsuite.ts";
export type {
	OwnsuiteConfig, OwnsuiteDomainConfig, SetContextOptions,
} from "./ownsuite.ts";

// Domain managers
export { BaseDomainManager, OwnedCollectionManager } from "./domains/mod.ts";
export type { BaseDomainOptions, OwnedCollectionManagerOptions } from "./domains/mod.ts";

// Types
export type {
	DomainError, DomainState, DomainStateWrapper,
	OwnsuiteContext, OwnedCollectionState,
	OwnsuiteEvent, OwnsuiteEventType, DomainName,
	StateChangedEvent, ErrorEvent, SyncedEvent,
	ListFetchedEvent, RowFetchedEvent,
	RowCreatedEvent, RowUpdatedEvent, RowDeletedEvent,
	OwnedCollectionAdapter, OwnedListResult, OwnedRowResult,
} from "./types/mod.ts";

// Mock adapter (for tests)
export { createMockOwnedCollectionAdapter } from "./adapters/mod.ts";
export type { MockAdapterOptions } from "./adapters/mod.ts";
```

## State Machine

```
initializing → ready
ready        ↔ syncing
syncing      → error       (on failure; rolled-back data restored)
error        → syncing     (retry)
```

Triggered by `initialize()`, `refresh()`, `create()`, `update()`, `delete()` on each domain manager.

## Critical Invariants

1. **Client NEVER sets `owner_id`.** The server stamps it from the authenticated JWT via `@marianmeres/collection`'s `ownerIdExtractor`. Including `owner_id` in a create/update payload will be rejected (belt-and-braces) or silently ignored (immutability guarantee on update).

2. **Ownership mismatches return 404, not 403.** When the server's `ownerIdScope` rejects access to a foreign row, it responds 404 to avoid leaking row existence. For `list`/`refresh`, adapters must throw — the manager transitions to `error`. For `getOne`, a throw lands only in a returned `null` (see invariant 7).

3. **Row ids default to `model_id`, fallback `id`.** Override via `getRowId` in `OwnsuiteDomainConfig` or `OwnedCollectionManagerOptions` when rows have a different key shape. Empty string is rejected.

4. **`initialize()` never rejects.** Per-domain errors land in that domain's `error` state; the top-level promise resolves. Use `suite.hasErrors()` / `suite.errors()` to detect failed boots, or subscribe to `domain:error`.

5. **Optimistic updates roll back per-row on failure.** `update` mutates the single target row; on error that row reverts to its pre-call value. `delete` removes the target row; on error it is re-inserted at its original position (unless another op has since re-added it). `create` does NOT optimistically insert. Rollback reads the *live* store so an interleaved `refresh()` that brought new rows is preserved.

6. **`OwnsuiteContext.subjectId` is a hint, not authorization.** The server is authoritative. Setting it client-side has no security effect. When subject changes, call `suite.setContext(ctx, { replace: true, refresh: true })` to clear stale per-subject caches.

7. **`getOne()` does NOT transition the domain to `error`.** A failing single-row read (commonly a 404 for an un-owned row) returns `null` and emits nothing. The list state is preserved.

8. **`update(id)` for a row absent from the cached list does NOT insert.** A missing index means the row was filtered out or never loaded — the successful server response is acknowledged (`own:row:updated` is emitted) but the list remains untouched. Call `refresh()` to surface the row.

9. **Mutations serialize; reads abort-supersede.** Within a single manager, `create/update/delete` run one-at-a-time in call order. A newer `initialize/refresh` aborts an older one (the older call becomes a no-op).

10. **`ctx.signal` is present on every adapter call.** Adapters should forward it to `fetch()`. Signals abort on `reset()`, `destroy()`, and read-supersede.

## Common Patterns

### Register domains at construction

```typescript
const suite = createOwnsuite({
	context: { subjectId: "user-123" },
	domains: {
		orders: { adapter: ordersAdapter },
		addresses: { adapter: addressesAdapter, getRowId: (r) => r.address_id },
	},
});
await suite.initialize();
```

### Register domains after construction

```typescript
const suite = createOwnsuite();
suite.registerDomain("orders", { adapter: ordersAdapter });
await suite.initialize(["orders"]);
```

### Subscribe (Svelte-compatible)

```typescript
suite.domain("orders").subscribe((s) => {
	// s: { state, data, error, lastSyncedAt }
	// s.data: { rows: TRow[]; meta: Record<string, unknown> } | null
});
```

### Events

```typescript
suite.on("own:row:created", (e) => {/* e.rowId, e.domain, e.timestamp */});
suite.on("domain:error",     (e) => {/* e.error */});
suite.onAny(({ event, data }) => {/* wildcard envelope */});
```

### Detecting boot failures

```typescript
await suite.initialize();
if (suite.hasErrors()) {
	const errs = suite.errors(); // { [domainName]: DomainError }
	// route to error UI, log, retry, ...
}
```

### Switching subject mid-session

```typescript
// Clears the previous subject's context keys and re-fetches every domain.
suite.setContext({ subjectId: newId }, { replace: true, refresh: true });
```

### Cleanup

```typescript
suite.destroy(); // aborts in-flight requests, unsubscribes pubsub, drops adapters
```

### Implementing a real adapter

```typescript
import type { OwnedCollectionAdapter } from "@marianmeres/ownsuite";
import { HTTP_ERROR } from "@marianmeres/http-utils";

const adapter: OwnedCollectionAdapter = {
	async list(ctx, query) {
		const url = new URL(`/api/shop/me/col/order/mod`, location.origin);
		if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
		const res = await fetch(url, { signal: ctx.signal }); // forward abort
		if (!res.ok) throw new HTTP_ERROR.BadRequest(await res.text());
		return await res.json(); // { data, meta }
	},
	// getOne, create, update, delete similarly — always forward ctx.signal
};
```

Joy ships a reusable factory at `src/admin/packages/joy/src/routes/me/owned-collection-adapter.ts` — use it as reference.

### Testing with the mock adapter

```typescript
import {
	createMockOwnedCollectionAdapter,
	createOwnsuite,
} from "@marianmeres/ownsuite";

const adapter = createMockOwnedCollectionAdapter({
	seed: [{ model_id: "1", data: { label: "a" } }],
	failOn: { update: true },
});
const suite = createOwnsuite({ domains: { notes: { adapter } } });
await suite.initialize();
await suite.domain("notes").update("1", { data: { label: "b" } });
// state === "error"; list rolled back to original
```

## Common Tasks

### Add a new event type

1. Add string literal to `OwnsuiteEventType` in `src/types/events.ts`
2. Add event interface extending `OwnsuiteEventBase`
3. Add to `OwnsuiteEvent` discriminated union
4. Emit via `this.emit({ type, domain, timestamp, ... })` from the manager

### Add a new domain shape (beyond OwnedCollectionManager)

1. Create manager class in `src/domains/` extending `BaseDomainManager<TData, TAdapter>`
2. Implement `initialize()` (required abstract method)
3. Emit domain-specific events via `this.emit(...)`
4. Register in `Ownsuite` if first-class, or let consumers register manually via `setAdapter`

Note: `Ownsuite.registerDomain()` currently hard-codes `OwnedCollectionManager`. If adding a different manager shape, extend `Ownsuite` with a second registration method or make the manager type pluggable.

### Switch an existing domain to a different adapter at runtime

```typescript
suite.domain("orders").setAdapter(newAdapter);
await suite.domain("orders").refresh();
```

## Dependencies

```yaml
runtime:
    "@marianmeres/clog": "^3.15.3"
    "@marianmeres/collection-types": "^1.36.0"
    "@marianmeres/http-utils": "^2.5.1"
    "@marianmeres/pubsub": "^2.4.6"
    "@marianmeres/store": "^2.4.4"
dev:
    "@marianmeres/npmbuild": "^1.11.0"
    "@std/assert": "^1.0.19"
    "@std/fs": "^1.0.23"
    "@std/path": "^1.1.4"
```

## Testing

```bash
deno task test       # run all tests (26 tests across ownsuite.test.ts + concurrency.test.ts)
deno task test:watch # watch mode
```

`tests/concurrency.test.ts` covers the critical invariants: concurrent
mutations, abort-supersede, getOne-not-setting-error, phantom-row
prevention, destroy semantics, and the errors()/hasErrors() helpers.

## Build & Publish

```bash
deno task npm:build      # build npm-compatible dist via @marianmeres/npmbuild
deno task npm:publish    # build + npm publish --access=public
deno task publish        # JSR publish + npm publish
deno task release        # bump + changelog
deno task rp             # release patch + publish
deno task rpm            # release minor + publish
```

## Integration Notes

### Server-side pairing

The client-side scope assumes the server enforces owner-based filtering. This requires:

1. **Collection package**: a collection with `owner_id_mode: "auto"` or `"required"`.
2. **Server mount**: `createCollectionRoutes(app, mw, { adapter, ...ownsuiteOptions() })` from `@marianmeres/stack-common`. This wires both `ownerIdExtractor` (write-side, stamps `owner_id` from subject on create) and `ownerIdScope` (read-side, 404 on foreign rows + auto-filtered lists).
3. **Auth middleware**: must populate `ctx.locals.subject` (typically via `@marianmeres/stack-common`'s `createJwtMiddleware`) before the collection routes handle the request.

URL shape the default adapter helper expects:
```
List   GET    {apiRoot}/{stack}/me/col/{entity}/mod
Get    GET    {apiRoot}/{stack}/me/col/{entity}/mod/{id}
Create POST   {apiRoot}/{stack}/me/col/{entity}/mod
Update PUT    {apiRoot}/{stack}/me/col/{entity}/mod/{id}
Delete DELETE {apiRoot}/{stack}/me/col/{entity}/mod/{id}
```

### Joy admin SPA pairing

Joy ships:
- `src/admin/packages/joy/src/components/layout/LayoutCustomer.svelte` — simplified chrome for `/me/*`.
- `src/admin/packages/joy/src/routes/me/MeRouter.svelte` — route entry point.
- `src/admin/packages/joy/src/routes/me/owned-collection-adapter.ts` — reusable adapter factory.

See the full-stack-app-template repo for the end-to-end example.

## Breaking changes in 2.0.0

The 1.x line has one open set of correctness bugs and a permissive API
that leaked state into domain errors on non-list operations. 2.0.0 fixes
those; the behaviors changed are:

1. **`getOne()` no longer transitions the domain to `error`.** Previously
   any adapter throw from `getOne` set `state: "error"` on the whole
   domain, invalidating a healthy list view. Now it returns `null` and
   logs at debug level. Callers relying on the error-state transition
   must subscribe differently (wrap `getOne` or inspect adapter errors
   directly).

2. **`update(id, ...)` for an id absent from the cached list no longer
   prepends a phantom row** on successful server response. The server
   update is still applied (and `own:row:updated` emitted), but the list
   stays as-is. Call `refresh()` to surface the row. Previously the row
   was inserted at the top of the list.

3. **`OwnsuiteContext.signal` is now populated by the manager on every
   adapter call.** Adapters that declared `ctx: OwnsuiteContext` see no
   compile break (the field was already allowed via the index
   signature); adapters that want cancellation should now forward
   `ctx.signal` to `fetch()`. Adapters that ignore it continue to work.

4. **`createMockOwnedCollectionAdapter` rejects `create` payloads
   containing `model_id`** by default. Tests that were relying on
   passing a `model_id` at create time must either drop the field or
   opt out via `rejectClientId: false` in the options. Rows with an
   empty-string `model_id` in `seed` are also rejected.

5. **Rollback is now per-row, not whole-list.** Behavioral semantics
   are stricter: a failed `update` reverts only the updated row; a
   failed `delete` re-inserts only the deleted row. If your app relied
   on the whole-list-restore side effect (e.g., to drop rows added by
   a concurrent refresh that raced with a failing mutation), note this
   subtle shift.

6. **`reset()` now emits `domain:state:changed`** for each domain that
   transitions out of a non-initializing state. Subscribers that count
   events may see more of them.

Non-breaking additions: `suite.destroy()`, `suite.errors()`,
`suite.hasErrors()`, `suite.setContext(ctx, { replace, refresh })`,
`manager.isDestroyed`, `manager.replaceContext(ctx)`.

## Differences from `@marianmeres/ecsuite`

| Aspect | ecsuite | ownsuite |
|--------|---------|----------|
| Domains | Fixed 6 (cart, wishlist, order, customer, payment, product) | Arbitrary, registered by name |
| State shape | Domain-specific (cart items, orders list, etc.) | Generic `{ rows, meta }` per domain |
| Persistence | localStorage for cart/wishlist | None (server is source of truth) |
| Scoping | Customer-id hint in context | Server-enforced via `owner_id` |
| Optimistic create | Yes (cart items) | No (no client-assigned id) |
| Optimistic update/delete | Yes | Yes |
| Event namespaces | `cart:*`, `order:*`, etc. | `own:list:*`, `own:row:*` |

Consumers that already use ecsuite can compose both suites in the same app.
