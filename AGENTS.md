# AGENTS.md - @marianmeres/ownsuite

Machine-readable documentation for AI coding assistants.

## Package Overview

```yaml
name: "@marianmeres/ownsuite"
version: "1.0.0"
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
├── #pubsub           (shared event bus)
├── #context          (propagated to all domains on setContext)
└── domains: Map<string, OwnedCollectionManager>
      ├── store       (Svelte-compatible DomainStateWrapper<OwnedCollectionState<TRow>>)
      ├── adapter     (OwnedCollectionAdapter)
      ├── state machine: initializing → ready ↔ syncing → error
      └── optimistic update + rollback on create/update/delete
```

Each domain holds one list of rows. List operations replace the list wholesale; single-row ops mutate it in place so subscribers see stable references.

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
export type { OwnsuiteConfig, OwnsuiteDomainConfig } from "./ownsuite.ts";

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

2. **Ownership mismatches return 404, not 403.** When the server's `ownerIdScope` rejects access to a foreign row, it responds 404 to avoid leaking row existence. Adapter implementations must not treat 404 as a soft miss — they must throw so the manager transitions to `error` state for unexpected 404s on previously-visible rows.

3. **Row ids default to `model_id`, fallback `id`.** Override via `getRowId` in `OwnsuiteDomainConfig` or `OwnedCollectionManagerOptions` when rows have a different key shape.

4. **`initialize()` never rejects.** Per-domain errors land in that domain's `error` state; the top-level promise resolves. Callers that need failure detection should subscribe to `domain:error` events or inspect `manager.get().state`.

5. **Optimistic updates roll back on failure.** `update` and `delete` mutate the list before the server call; on error the list is restored to its pre-call snapshot and the manager transitions to `error`. `create` does NOT optimistically insert (no client-assigned id) — it only inserts after the server returns.

6. **`OwnsuiteContext.subjectId` is a hint, not authorization.** The server is authoritative. Setting it client-side has no security effect.

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

### Implementing a real adapter

```typescript
import type { OwnedCollectionAdapter } from "@marianmeres/ownsuite";
import { HTTP_ERROR } from "@marianmeres/http-utils";

const adapter: OwnedCollectionAdapter = {
	async list(_ctx, query) {
		const url = new URL(`/api/shop/me/col/order/mod`, location.origin);
		if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
		const res = await fetch(url);
		if (!res.ok) throw new HTTP_ERROR.BadRequest(await res.text());
		return await res.json(); // { data, meta }
	},
	// getOne, create, update, delete similarly
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
deno task test       # run all tests (10 tests)
deno task test:watch # watch mode
```

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
