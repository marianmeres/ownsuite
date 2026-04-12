# @marianmeres/ownsuite

[![NPM Version](https://img.shields.io/npm/v/@marianmeres/ownsuite)](https://www.npmjs.com/package/@marianmeres/ownsuite)
[![JSR Version](https://img.shields.io/jsr/v/@marianmeres/ownsuite)](https://jsr.io/@marianmeres/ownsuite)
[![License](https://img.shields.io/github/license/marianmeres/ownsuite)](LICENSE)

Client-side helper library for owner-scoped UIs. Generic domain managers with optimistic updates, Svelte-compatible stores, and adapter-based server sync — the owner-scoped counterpart to [`@marianmeres/ecsuite`](https://jsr.io/@marianmeres/ecsuite).

## What it does

Ownsuite gives front-end applications a uniform way to read, create, update and delete records from owner-scoped REST endpoints (typically `/me/*`). Each row is implicitly scoped to the authenticated subject by the server — the client never sets `owner_id`. The library pairs with:

- **[`@marianmeres/collection`](https://jsr.io/@marianmeres/collection)** — the `ownerIdScope` route hook enforces owner-based filtering on the server.
- **[`@marianmeres/stack-common`](https://jsr.io/@marianmeres/stack-common)** — the `ownsuiteOptions()` helper wires the server mount.

## Features

- **Generic domain managers** — register any owner-scoped collection by name; no hard-coded domain list
- **Optimistic updates** — UI mutates immediately; the manager rolls back on server failure
- **Svelte-compatible stores** — every domain exposes a `subscribe()` method
- **Adapter pattern** — plug in any HTTP/WebSocket/mock transport
- **Event system** — subscribe to list fetches, row CRUD, and lifecycle transitions
- **Mock adapter** — in-memory fixture for tests, with configurable failure injection

## Installation

```bash
# Deno
deno add @marianmeres/ownsuite

# npm
npm install @marianmeres/ownsuite
```

## Quick Start

```typescript
import { createOwnsuite } from "@marianmeres/ownsuite";
import { createOwnedCollectionAdapter } from "./my-adapters";

// 1. Build adapters that point at owner-scoped endpoints
const ordersAdapter = createOwnedCollectionAdapter({
	apiRoot: "/api",
	stack: "shop",
	entity: "order",
});

// 2. Register domains under any name
const suite = createOwnsuite({
	context: { subjectId: "user-123" },
	domains: {
		orders: { adapter: ordersAdapter },
	},
});

// 3. Load the list from the server
await suite.initialize();

// 4. Subscribe (Svelte-compatible)
suite.domain("orders").subscribe((s) => {
	console.log(s.state, s.data?.rows);
});

// 5. CRUD — the server stamps owner_id from the JWT; the client never sets it
await suite.domain("orders").create({ data: { total: 99 } });
await suite.domain("orders").update(id, { data: { total: 120 } });
await suite.domain("orders").delete(id);
```

## Architecture at a glance

```
Ownsuite (orchestrator)
├── domain("orders") ──┐
├── domain("notes")  ──┼──► OwnedCollectionManager<TRow>
├── domain("...")    ──┘         ├── store   (Svelte-compatible)
                                  ├── pubsub  (events)
                                  └── adapter (HTTP/mock)
```

Each domain holds a single list of rows owned by the authenticated subject. List operations replace the list; single-row operations mutate it in place so subscribers see stable references without a re-fetch.

## Testing with the mock adapter

```typescript
import {
	createMockOwnedCollectionAdapter,
	createOwnsuite,
} from "@marianmeres/ownsuite";

const adapter = createMockOwnedCollectionAdapter({
	seed: [{ model_id: "1", data: { label: "hello" } }],
	failOn: { update: true },   // force update failures for rollback tests
});

const suite = createOwnsuite({ domains: { notes: { adapter } } });
await suite.initialize();
await suite.domain("notes").update("1", { data: { label: "new" } });
// list is rolled back; suite.domain("notes").get().state === "error"
```

## API

See [API.md](API.md) for complete API documentation.

## License

[MIT](LICENSE)
