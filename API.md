# API

## Functions

### `createOwnsuite(config?)`

Convenience factory mirroring the ecsuite `createECSuite` convention. Equivalent to `new Ownsuite(config)`.

**Parameters:**
- `config` (`OwnsuiteConfig`, optional) — see [`OwnsuiteConfig`](#ownsuiteconfig).

**Returns:** `Ownsuite`

**Example:**
```typescript
import { createOwnsuite } from "@marianmeres/ownsuite";

const suite = createOwnsuite({
	context: { subjectId: "user-123" },
	domains: {
		orders: { adapter: myOrdersAdapter },
		addresses: { adapter: myAddressesAdapter },
	},
});
await suite.initialize();
```

---

### `createMockOwnedCollectionAdapter(options?)`

In-memory mock adapter for tests. Stores rows in a local `Map` keyed by `model_id`. Applies optional latency and can inject failures per operation — useful for exercising the optimistic-update rollback path deterministically.

**Parameters:**
- `options` (`MockAdapterOptions<TRow>`, optional)
  - `options.seed` (`TRow[]`, optional) — initial rows
  - `options.delayMs` (`number`, optional) — artificial latency per call. Default: `0`
  - `options.failOn` (`object`, optional) — per-operation failure injection: `{ list?, getOne?, create?, update?, delete? }`
  - `options.getRowId` (`(row) => string`, optional) — row-id resolver. Default: `row.model_id ?? row.id`
  - `options.newId` (`() => string`, optional) — id factory for new rows. Default: `crypto.randomUUID`

**Returns:** `OwnedCollectionAdapter<TRow> & { _rows(): TRow[] }`

The returned adapter exposes an extra `_rows()` method for test assertions that doesn't exist on production adapters.

**Example:**
```typescript
const adapter = createMockOwnedCollectionAdapter({
	seed: [{ model_id: "1", data: { label: "a" } }],
	failOn: { create: true },
});
```

---

## Classes

### `Ownsuite`

Orchestrator that coordinates owner-scoped domain managers and provides a shared event bus.

#### `new Ownsuite(config?)`

**Parameters:** same as `createOwnsuite`.

#### `suite.registerDomain(name, cfg)`

Register a new domain after construction. Throws if `name` is already registered.

**Parameters:**
- `name` (`string`) — unique domain label
- `cfg` (`OwnsuiteDomainConfig<TRow, TCreate, TUpdate>`)
  - `cfg.adapter` (`OwnedCollectionAdapter`) — required
  - `cfg.getRowId` (`(row) => string`, optional) — custom row-id resolver

**Returns:** `OwnedCollectionManager<TRow, TCreate, TUpdate>`

#### `suite.domain(name)`

Look up a domain manager by name. Throws if unknown.

**Returns:** `OwnedCollectionManager<TRow, TCreate, TUpdate>`

#### `suite.hasDomain(name): boolean`

True if a domain by this name is registered.

#### `suite.domainNames(): string[]`

List registered domain names.

#### `suite.initialize(names?)`

Initialize all registered domains (or a subset). Runs in parallel. Individual domain errors land in that domain's error state and **do not** reject the returned promise.

**Parameters:**
- `names` (`string[]`, optional) — domain names to initialize. Default: all registered domains.

**Returns:** `Promise<void>`

#### `suite.setContext(ctx)`

Merge `ctx` into the shared context and propagate to every registered domain manager.

**Parameters:**
- `ctx` (`OwnsuiteContext`)

#### `suite.getContext(): OwnsuiteContext`

Snapshot of current shared context.

#### `suite.on(type, subscriber)`

Subscribe to a specific event type.

**Parameters:**
- `type` (`OwnsuiteEventType`)
- `subscriber` (`Subscriber`) — from `@marianmeres/pubsub`

**Returns:** `Unsubscriber`

**Example:**
```typescript
const unsub = suite.on("own:row:created", (e) => {
	console.log("created row", e.rowId, "in domain", e.domain);
});
```

#### `suite.onAny(subscriber)`

Subscribe to all events. Wildcard subscribers receive an envelope `{ event: string, data: OwnsuiteEvent }` — see `@marianmeres/pubsub`.

**Returns:** `Unsubscriber`

#### `suite.reset()`

Reset every domain manager to the `initializing` state. Drops cached lists.

---

### `OwnedCollectionManager<TRow, TCreate, TUpdate>`

Generic manager for a single owner-scoped collection domain. One instance per collection path on the server.

#### `new OwnedCollectionManager(domainName, options?)`

Typically created via `Ownsuite.registerDomain()` — manual construction is possible but bypasses the shared pubsub.

**Parameters:**
- `domainName` (`string`) — label (informational, used in event payloads and logs)
- `options` (`OwnedCollectionManagerOptions<TRow, TCreate, TUpdate>`, optional)
  - `options.adapter` (`OwnedCollectionAdapter`, optional)
  - `options.getRowId` (`(row) => string`, optional) — default: `row.model_id ?? row.id`
  - `options.context` (`OwnsuiteContext`, optional)
  - `options.pubsub` (`PubSub`, optional) — shared event bus

#### `manager.subscribe(listener)`

Svelte-compatible subscribe. Listener receives the full [`DomainStateWrapper<OwnedCollectionState<TRow>>`](#domainstatewrappert).

**Returns:** `Unsubscriber`

#### `manager.get(): DomainStateWrapper<OwnedCollectionState<TRow>>`

Synchronous snapshot of the current state.

#### `manager.initialize(): Promise<void>`

Fetch the list from the server. Populates `data.rows` + `data.meta` and transitions to `ready`.

#### `manager.refresh(query?): Promise<void>`

Re-fetch the list. Same as `initialize` but re-entrant; accepts an adapter-specific query object.

**Parameters:**
- `query` (`Record<string, unknown>`, optional) — forwarded to `adapter.list(ctx, query)`

#### `manager.getOne(id): Promise<TRow | null>`

Fetch a single row by id. Does **not** mutate the list. Returns `null` on error and transitions the manager to `error` state.

#### `manager.create(data): Promise<TRow | null>`

Create a new row. On success, prepends the server-returned row to the list. On failure, the list is unchanged and the manager transitions to `error`.

**Parameters:**
- `data` (`TCreate`) — creation payload. The server stamps `owner_id` — do not set it client-side.

**Returns:** the server-returned row, or `null` on failure.

#### `manager.update(id, data): Promise<TRow | null>`

Update a row. Optimistically merges `data` into the existing row; on server failure the list is rolled back to its pre-call state. On success, the server-returned row replaces the optimistic one.

**Parameters:**
- `id` (`string`)
- `data` (`TUpdate`)

#### `manager.delete(id): Promise<boolean>`

Delete a row. Optimistically removes it from the list; on server failure the list is rolled back.

**Returns:** `true` on success, `false` on failure.

#### `manager.getRows(): TRow[]`

Snapshot of current rows (empty array if not loaded).

#### `manager.findRow(id): TRow | undefined`

Find a row by id in the current list without hitting the server.

#### `manager.setAdapter(adapter)` / `manager.getAdapter()`

Swap or inspect the adapter at runtime.

#### `manager.setContext(ctx)` / `manager.getContext()`

Per-manager context. `Ownsuite.setContext()` propagates to every manager.

#### `manager.reset()`

Reset to `initializing` state.

---

### `BaseDomainManager<TData, TAdapter>`

Abstract base class. Not typically used directly — `OwnedCollectionManager` extends it. Provides reactive state, state-machine transitions, optimistic-update pattern, and event emission. Matches the shape of ecsuite's `BaseDomainManager`.

---

## Types

### `OwnsuiteConfig`

```typescript
interface OwnsuiteConfig {
	context?: OwnsuiteContext;
	domains?: Record<string, OwnsuiteDomainConfig>;
	autoInitialize?: boolean;
}
```

- `context` — initial context passed to every adapter call.
- `domains` — domain registry at construction time. Keys are arbitrary labels.
- `autoInitialize` — fire-and-forget `initialize()` in the constructor. Default: `false`.

### `OwnsuiteDomainConfig<TRow, TCreate, TUpdate>`

```typescript
interface OwnsuiteDomainConfig<TRow, TCreate, TUpdate> {
	adapter: OwnedCollectionAdapter<TRow, TCreate, TUpdate>;
	getRowId?: (row: TRow) => string;
}
```

### `OwnsuiteContext`

```typescript
interface OwnsuiteContext {
	subjectId?: string;
	[key: string]: unknown;
}
```

Context passed to adapters. **`subjectId` is a hint only** — the server authoritatively resolves the owner from the authenticated JWT. The context object is the extension point for passing host-app data (correlation ids, feature flags, tenants) through adapter calls.

### `OwnedCollectionAdapter<TRow, TCreate, TUpdate>`

```typescript
interface OwnedCollectionAdapter<TRow, TCreate = unknown, TUpdate = unknown> {
	list(ctx: OwnsuiteContext, query?: Record<string, unknown>): Promise<OwnedListResult<TRow>>;
	getOne(id: string, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>>;
	create(data: TCreate, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>>;
	update(id: string, data: TUpdate, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>>;
	delete(id: string, ctx: OwnsuiteContext): Promise<boolean>;
}
```

Implementations throw on failure (ideally `HTTP_ERROR` from `@marianmeres/http-utils`); the manager handles rollback.

### `OwnedListResult<TRow>` / `OwnedRowResult<TRow>`

```typescript
interface OwnedListResult<TRow> {
	data: TRow[];
	meta: Record<string, unknown>;
}

interface OwnedRowResult<TRow> {
	data: TRow;
	meta?: Record<string, unknown>;
}
```

Matches `@marianmeres/collection`'s REST envelope.

### `OwnedCollectionState<TRow>`

```typescript
interface OwnedCollectionState<TRow> {
	rows: TRow[];
	meta: Record<string, unknown>;
}
```

### `DomainStateWrapper<T>`

```typescript
interface DomainStateWrapper<T> {
	state: DomainState;           // "initializing" | "ready" | "syncing" | "error"
	data: T | null;
	error: DomainError | null;
	lastSyncedAt: number | null;
}
```

### `DomainState`

```typescript
type DomainState = "initializing" | "ready" | "syncing" | "error";
```

State transitions:

```
initializing → ready
ready        ↔ syncing
syncing      → error      (on failure; list is rolled back)
error        → syncing    (retry)
```

### `DomainError`

```typescript
interface DomainError {
	code: string;             // e.g. "SYNC_FAILED", "FETCH_FAILED"
	message: string;
	operation: string;        // e.g. "create", "update", "delete"
	originalError?: unknown;
}
```

### `OwnsuiteEventType`

```typescript
type OwnsuiteEventType =
	| "domain:state:changed"
	| "domain:error"
	| "domain:synced"
	| "own:list:fetched"
	| "own:row:fetched"
	| "own:row:created"
	| "own:row:updated"
	| "own:row:deleted";
```

### `OwnsuiteEvent`

Discriminated union of all event payloads. Every event has `type`, `timestamp`, and `domain` fields.

```typescript
type OwnsuiteEvent =
	| StateChangedEvent
	| ErrorEvent
	| SyncedEvent
	| ListFetchedEvent      // + count
	| RowFetchedEvent       // + rowId
	| RowCreatedEvent       // + rowId
	| RowUpdatedEvent       // + rowId
	| RowDeletedEvent;      // + rowId
```

See [src/types/events.ts](src/types/events.ts) for individual event interfaces.

### `MockAdapterOptions<TRow>`

```typescript
interface MockAdapterOptions<TRow> {
	seed?: TRow[];
	delayMs?: number;
	failOn?: { list?: boolean; getOne?: boolean; create?: boolean; update?: boolean; delete?: boolean };
	getRowId?: (row: TRow) => string;
	newId?: () => string;
}
```

---

## Implementing a real adapter

Point the adapter at your server's owner-scoped mount (typically `/api/<stack>/me/col/<entity>/...`). The server is responsible for `owner_id` enforcement — the client only talks to `/me/*`.

```typescript
import type { OwnedCollectionAdapter } from "@marianmeres/ownsuite";
import { HTTP_ERROR } from "@marianmeres/http-utils";

export function createRestAdapter(stack: string, entity: string): OwnedCollectionAdapter {
	const base = `/api/${stack}/me/col/${entity}`;
	const json = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
		const res = await fetch(url, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!res.ok) throw new HTTP_ERROR.BadRequest(await res.text());
		return await res.json();
	};
	return {
		list: (_ctx) => json("GET", `${base}/mod`),
		getOne: (id, _ctx) => json("GET", `${base}/mod/${id}`),
		create: (data, _ctx) => json("POST", `${base}/mod`, data),
		update: (id, data, _ctx) => json("PUT", `${base}/mod/${id}`, data),
		delete: async (id, _ctx) => {
			await json("DELETE", `${base}/mod/${id}`);
			return true;
		},
	};
}
```

The [`@marianmeres/joy`](https://github.com/marianmeres/full-stack-app-template) admin SPA ships a reusable factory — `createOwnedCollectionAdapter()` in `src/routes/me/owned-collection-adapter.ts` — that implements exactly this shape.
