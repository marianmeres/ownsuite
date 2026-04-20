# @marianmeres/ownsuite

[![NPM Version](https://img.shields.io/npm/v/@marianmeres/ownsuite)](https://www.npmjs.com/package/@marianmeres/ownsuite)
[![JSR Version](https://img.shields.io/jsr/v/@marianmeres/ownsuite)](https://jsr.io/@marianmeres/ownsuite)
[![License](https://img.shields.io/github/license/marianmeres/ownsuite)](LICENSE)

Client-side helper library for owner-scoped UIs. Generic domain managers with optimistic updates, Svelte-compatible stores, and adapter-based server sync — the owner-scoped counterpart to [`@marianmeres/ecsuite`](https://jsr.io/@marianmeres/ecsuite).

## What it does

Ownsuite gives front-end applications a uniform way to read, create, update and delete records from owner-scoped REST endpoints (typically `/me/*`). Each row is implicitly scoped to the authenticated subject by the server — the client never sets `owner_id`. The library pairs with:

- **@marianmeres/collection** — the `ownerIdScope` route hook enforces owner-based filtering on the server.
- **@marianmeres/stack-common** — the `ownsuiteOptions()` helper wires the server mount.

## Features

- **Generic domain managers** — register any owner-scoped collection by name; no hard-coded domain list
- **Optimistic updates** with per-row rollback — UI mutates immediately; failed ops revert just the affected row
- **Race-safe concurrency** — mutations serialize; reads abort-supersede (a newer `refresh()` aborts an older one)
- **AbortSignal plumbing** — every adapter call receives a per-operation signal, wired to `destroy()` and route-change cancellation
- **Svelte-compatible stores** — every domain exposes a `subscribe()` method
- **Adapter pattern** — plug in any HTTP/WebSocket/mock transport
- **Event system** — subscribe to list fetches, row CRUD, and lifecycle transitions
- **Mock adapter** — in-memory fixture for tests, with configurable failure injection and latency
- **Explicit lifecycle** — `suite.destroy()` aborts in-flight work and releases listeners cleanly
- **Account lifecycle (opt-in)** — `suite.auth` / `suite.session` / `suite.profile` for register / login / OAuth / verify / logout / profile edit / delete account, wired to pair with `@marianmeres/stack-account` via the bundled default adapters

## Authentication (optional)

Pass an `AuthAdapter` to `createOwnsuite` to attach the account-lifecycle managers. The default adapters target the `@marianmeres/stack-account` REST surface; apps with custom routes can write their own against the `AuthAdapter` / `ProfileAdapter` interfaces exported from this package.

```typescript
import {
  createOwnsuite,
  createStackAccountAuthAdapter,
  createStackAccountProfileAdapter,
} from "@marianmeres/ownsuite";

const suite = createOwnsuite({
  adapters: {
    auth: createStackAccountAuthAdapter({ baseUrl: "/api/account" }),
    profile: createStackAccountProfileAdapter({ baseUrl: "/api/account" }),
  },
  session: { storage: "local", storageKey: "myapp:session" },
  // Existing owner-scoped domains continue to work — their ctx.jwt is
  // populated automatically from the session and they re-initialize on
  // every login / logout.
  domains: {
    orders: { adapter: ordersAdapter },
  },
});

// Observable session — UI subscribes to this for logged-in state.
suite.session!.subscribe(({ status, subject }) => {
  if (status === "authenticated") console.log("hi", subject!.email);
  if (status === "unverified")   console.log("check your inbox");
  if (status === "anonymous")    console.log("signed out");
});

// Register → server requires email verification (default gate in stack-account)
await suite.auth!.register({
  email: "alice@example.com",
  password: "mysecretpassword",
  password_confirm: "mysecretpassword",
});
// suite.session!.get().status === "unverified"

// After the user clicks the email link and the server flips isVerified:
await suite.auth!.login(
  { email: "alice@example.com", password: "mysecretpassword" },
  { remember: true }, // true → localStorage; false → sessionStorage (per-login override)
);
// suite.session!.get().status === "authenticated"
// Every registered owner-scoped domain is re-initialized with the new JWT.

// OAuth popup flow — resolves when the callback page postMessages back
await suite.auth!.initiateOAuth("google", { action: "login" });

// Profile edit — changing email resets isVerified server-side and dispatches
// a new verification email. Session subject is patched in place.
await suite.profile!.update({
  email: "renamed@example.com",
  current_password: "mysecretpassword",
});

// Logout — revokes JWT server-side (via stack-account's jti deletion) and
// clears local session storage. Owner-scoped domains reset to initializing.
await suite.auth!.logout();
```

Session state is persisted through a pluggable `SessionStorage` backend (`"local"` / `"session"` / `"memory"` / custom object with `get`/`set`/`del`). Expired stored sessions are discarded on construction so a reload after the JWT lapses starts anonymous. With a built-in string backend, hydration probes `local → session → memory` and adopts whichever holds a non-expired payload — the per-login `remember` flag on `auth.login` / `auth.register` / `auth.initiateOAuth` (`true` → `localStorage`, `false` → `sessionStorage`) switches the active backend for that session, and `session.clear()` wipes all built-in backends so toggles can't leak stale data.

Tests can use the in-memory mock adapters (`createMockAuthAdapter`, `createMockProfileAdapter`, `createMockAuthStore`, `verifyMockAccount`) and the injectable popup host for deterministic OAuth dances.

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

// 6. Detect silent boot failures
if (suite.hasErrors()) console.warn("boot errors:", suite.errors());

// 7. Clean up on teardown (SPA unmount, tenant switch, test harness)
suite.destroy();
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

## Breaking changes in 2.0.0

- `getOne()` no longer transitions the domain to `error` on failure — it returns `null` quietly.
- `update(id, ...)` for an id absent from the cached list no longer prepends a phantom row — the server update is still applied server-side (event emitted), but the list stays unchanged. Call `refresh()` to surface it.
- `createMockOwnedCollectionAdapter` rejects `create` payloads containing a client-supplied `model_id` by default (opt out with `rejectClientId: false`).
- Rollback on failed `update`/`delete` is now per-row, not whole-list. Interleaved refresh results are preserved.
- `reset()` now emits `domain:state:changed`.

See [AGENTS.md](AGENTS.md) "Breaking changes in 2.0.0" for the full list and migration notes.

## License

[MIT](LICENSE)
