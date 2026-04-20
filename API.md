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

#### `suite.session`, `suite.auth`, `suite.profile`

Readonly properties pointing at the account-lifecycle managers. Populated only when `config.adapters.auth` was supplied — `null` otherwise. Full surface documented under [Account lifecycle (optional)](#account-lifecycle-optional).

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

#### `suite.setContext(ctx, options?)`

Update the shared context and propagate to every registered domain manager.

**Parameters:**
- `ctx` (`OwnsuiteContext`)
- `options` (`SetContextOptions`, optional)
  - `options.replace` (`boolean`, default `false`) — replace the context wholesale instead of merging. Use this when the subject changes and previous per-subject keys must not leak into adapter calls.
  - `options.refresh` (`boolean`, default `false`) — fire-and-forget `refresh()` on every domain after the context change. Recommended when `subjectId` changes so stale per-subject caches are cleared.

**Example:**
```typescript
// Subject change: drop old context + re-fetch every domain
suite.setContext({ subjectId: newId }, { replace: true, refresh: true });
```

#### `suite.getContext(): OwnsuiteContext`

Snapshot of current shared context.

#### `suite.errors(): Record<string, DomainError>`

Map of currently-errored domains to their `DomainError`. Empty if none are in error state. Use after `initialize()` to detect silent boot failures.

#### `suite.hasErrors(): boolean`

True if any domain is currently in `error` state.

#### `suite.destroy()`

Dispose of the suite: destroys every registered domain (which aborts in-flight adapter requests), clears the domain map, and unsubscribes every listener attached to the internal pubsub. Safe to call multiple times.

Subsequent method calls are best-effort no-ops (e.g., `initialize()` returns immediately, `setContext()` ignores the call). `registerDomain()` throws after destroy.

#### `suite.isDestroyed: boolean`

True after `destroy()` has been called.

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

Fetch a single row by id. Does **not** mutate the list and does **not** transition the domain to `error` on failure — a 404 for an un-owned row or a network blip on a read shouldn't invalidate a healthy list view. Returns `null` on any failure (including missing adapter). Emits `own:row:fetched` on success.

Callers that need error detail should wrap this method and inspect the adapter error themselves.

#### `manager.create(data): Promise<TRow | null>`

Create a new row. On success, prepends the server-returned row to the list. On failure, the list is unchanged and the manager transitions to `error`.

**Parameters:**
- `data` (`TCreate`) — creation payload. The server stamps `owner_id` — do not set it client-side.

**Returns:** the server-returned row, or `null` on failure.

#### `manager.update(id, data): Promise<TRow | null>`

Update a row. Optimistically merges `data` into the existing row; on server failure the single row reverts to its pre-call value (other rows are untouched — including any added by an interleaved `refresh()`). On success, the server-returned row replaces the optimistic one.

If `id` is **not** in the current cached list (filtered out by an active query, or not loaded), the optimistic step is a no-op AND the successful server response is **not** inserted — call `refresh()` if you want the row to appear. The `own:row:updated` event is emitted regardless.

**Parameters:**
- `id` (`string`)
- `data` (`TUpdate`)

Mutations serialize per-manager — a `create/update/delete` that starts while another is in-flight queues behind it.

#### `manager.delete(id): Promise<boolean>`

Delete a row. Optimistically removes it from the list; on server failure the single row is re-inserted at its original position (unless another op has since re-added it).

**Returns:** `true` on success, `false` on failure.

#### `manager.getRows(): TRow[]`

Snapshot of current rows (empty array if not loaded).

#### `manager.findRow(id): TRow | undefined`

Find a row by id in the current list without hitting the server.

#### `manager.setAdapter(adapter)` / `manager.getAdapter()`

Swap or inspect the adapter at runtime.

#### `manager.setContext(ctx)` / `manager.replaceContext(ctx)` / `manager.getContext()`

Per-manager context. `setContext` merges into the existing context; `replaceContext` replaces it wholesale. `Ownsuite.setContext()` propagates to every manager (with the same `{ replace }` option).

#### `manager.reset()`

Reset to `initializing` state. Aborts any in-flight reads or mutations (their completions become no-ops) and emits `domain:state:changed`.

#### `manager.destroy()`

Abort in-flight operations, drop the adapter reference, and mark the manager as destroyed. Subsequent method calls are best-effort no-ops. Usually invoked via `Ownsuite.destroy()`, but safe to call directly.

#### `manager.isDestroyed: boolean`

True after `destroy()` has been called.

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
	adapters?: {
		auth?: AuthAdapter;
		profile?: ProfileAdapter;
	};
	session?: {
		storage?: SessionStorageType;   // "local" | "session" | "memory" | SessionStorage
		storageKey?: string;            // default: "ownsuite:session"
	};
}
```

- `context` — initial context passed to every adapter call.
- `domains` — domain registry at construction time. Keys are arbitrary labels.
- `autoInitialize` — fire-and-forget `initialize()` in the constructor. Default: `false`.
- `adapters.auth` — when provided, the suite builds `SessionManager` / `AuthManager` / `ProfileManager` and exposes them as `suite.session` / `suite.auth` / `suite.profile`. Without it, those properties are `null`.
- `adapters.profile` — optional but recommended companion. Without it, login still succeeds but the subject is not hydrated from `/me`.
- `session.storage` / `session.storageKey` — persistence config for the session. Ignored when no `adapters.auth` is provided.

### `OwnsuiteDomainConfig<TRow, TCreate, TUpdate>`

```typescript
interface OwnsuiteDomainConfig<TRow, TCreate, TUpdate> {
	adapter: OwnedCollectionAdapter<TRow, TCreate, TUpdate>;
	getRowId?: (row: TRow) => string;
}
```

### `SetContextOptions`

```typescript
interface SetContextOptions {
	replace?: boolean;   // default: false — merge into existing context
	refresh?: boolean;   // default: false — fire refresh() on every domain
}
```

### `OwnsuiteContext`

```typescript
interface OwnsuiteContext {
	subjectId?: string;
	signal?: AbortSignal;  // manager-injected, per-call
	[key: string]: unknown;
}
```

Context passed to adapters. **`subjectId` is a hint only** — the server authoritatively resolves the owner from the authenticated JWT. **`signal` is injected by the manager** on every call; adapters should forward it to `fetch()` for cancellation on `reset()`/`destroy()`/read-supersede. The context object is also the extension point for passing host-app data (correlation ids, feature flags, tenants) through adapter calls.

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
	| "own:row:deleted"
	// Account lifecycle — only emitted when adapters.auth is wired
	| "auth:register"
	| "auth:login"
	| "auth:logout"
	| "auth:session:changed"
	| "auth:verification:required"
	| "profile:updated"
	| "oauth:linked"
	| "oauth:unlinked";
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
	/** Reject create payloads containing `model_id` (default: true). */
	rejectClientId?: boolean;
}
```

The mock adapter forwards `ctx.signal` — `delayMs` waits can be aborted mid-sleep so tests that assert on abort-supersede semantics run deterministically.

---

## Implementing a real adapter

Point the adapter at your server's owner-scoped mount (typically `/api/<stack>/me/col/<entity>/...`). The server is responsible for `owner_id` enforcement — the client only talks to `/me/*`.

```typescript
import type { OwnedCollectionAdapter, OwnsuiteContext } from "@marianmeres/ownsuite";
import { HTTP_ERROR } from "@marianmeres/http-utils";

export function createRestAdapter(stack: string, entity: string): OwnedCollectionAdapter {
	const base = `/api/${stack}/me/col/${entity}`;
	const json = async <T>(
		method: string,
		url: string,
		ctx: OwnsuiteContext,
		body?: unknown,
	): Promise<T> => {
		const res = await fetch(url, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: ctx.signal, // forward manager-injected abort signal
		});
		if (!res.ok) throw new HTTP_ERROR.BadRequest(await res.text());
		return await res.json();
	};
	return {
		list: (ctx) => json("GET", `${base}/mod`, ctx),
		getOne: (id, ctx) => json("GET", `${base}/mod/${id}`, ctx),
		create: (data, ctx) => json("POST", `${base}/mod`, ctx, data),
		update: (id, data, ctx) => json("PUT", `${base}/mod/${id}`, ctx, data),
		delete: async (id, ctx) => {
			await json("DELETE", `${base}/mod/${id}`, ctx);
			return true;
		},
	};
}
```

The `@marianmeres/joy` admin SPA ships a reusable factory — `createOwnedCollectionAdapter()` in `src/routes/me/owned-collection-adapter.ts` — that implements exactly this shape.

---

## Account lifecycle (optional)

Attached automatically when `adapters.auth` is passed to `createOwnsuite`. See also the example at the top of [README.md](README.md).

### `createStackAccountAuthAdapter(options?)`

Default `AuthAdapter` pointing at the `@marianmeres/stack-account` REST surface.

**Parameters:**
- `options` (`StackAccountAdapterOptions`, optional)
  - `options.baseUrl` (`string`, optional) — mount path. Default: `"/api/account"`.
  - `options.fetch` (`typeof fetch`, optional) — custom fetch (tests / SSR).

**Returns:** `AuthAdapter`

Endpoints targeted:

```
POST   {baseUrl}/register
POST   {baseUrl}/login
POST   {baseUrl}/logout
POST   {baseUrl}/verify/resend
POST   {baseUrl}/password/reset
POST   {baseUrl}/password/change
DELETE {baseUrl}/me
GET    {baseUrl}/oauth/{provider}/init
```

### `createStackAccountProfileAdapter(options?)`

Default `ProfileAdapter`.

**Parameters:** same `StackAccountAdapterOptions` as above.

**Returns:** `ProfileAdapter`

Endpoints targeted: `GET/PUT {baseUrl}/me`, `GET {baseUrl}/me/oauth`, `DELETE {baseUrl}/me/oauth/{provider}`.

### `createMockAuthStore(init?)` / `createMockAuthAdapter(store)` / `createMockProfileAdapter(store)` / `verifyMockAccount(store, email)`

In-memory mock for tests and demos. `createMockAuthStore` builds a shared state object; the adapter factories close over it.

**`createMockAuthStore(init?)`** returns `MockAuthStore`. `init.requireVerifiedEmail` (default `false`) toggles the email-verification gate; `init.seed` can pre-populate accounts.

**`verifyMockAccount(store, email)`** marks an account as verified — stands in for the user clicking the link in a real verification email.

**Example:**
```typescript
const store = createMockAuthStore({ requireVerifiedEmail: true });
const suite = createOwnsuite({
    adapters: {
        auth: createMockAuthAdapter(store),
        profile: createMockProfileAdapter(store),
    },
});
await suite.auth!.register({
    email: "alice@example.com",
    password: "mysecretpassword",
    password_confirm: "mysecretpassword",
});
// suite.session!.get().status === "unverified"
verifyMockAccount(store, "alice@example.com");
await suite.auth!.login({ email: "alice@example.com", password: "mysecretpassword" });
// suite.session!.get().status === "authenticated"
```

---

### `SessionManager`

Reactive session state + persistence. No HTTP. Attached as `suite.session`.

#### `session.subscribe(listener)` / `session.get()`

Svelte-compatible store over [`SessionState`](#sessionstate).

#### `session.getJwt(): string | null`

Current JWT, or `null` when anonymous.

#### `session.isAuthenticated` / `session.isUnverified` / `session.isAnonymous` (boolean getters)

Shorthand reads.

#### `session.setAuthenticated({ jwt, subject, expiresAt?, storage? })`

Enter the `authenticated` state. Normally called by `AuthManager`, not consumers.

- `storage` (`SessionStorageType`, optional) — per-login storage pin. When `"local"` / `"session"` / `"memory"`, switches the active built-in backend for this session (and for subsequent `patchSubject` / `setUnverified` writes). The previously-active built-in backend's blob is wiped as part of the switch so "Remember me" toggles don't leave stale data. Silently ignored when the manager was constructed with a custom `SessionStorage` object, or when the override is itself an object.

#### `session.setUnverified(email)` / `session.clear()` / `session.patchSubject(patch)`

Mutation helpers — typically driven by `AuthManager` / `ProfileManager`.

#### `session.destroy()`

Clear storage and in-memory state. Called by `suite.destroy()`.

---

### `AuthManager`

Verbs only. Attached as `suite.auth`. No state of its own — results flow into `SessionManager`.

| Method | Purpose |
|---|---|
| `register({ email, password, password_confirm, roles?, extras? }, options?)` | Create account. Returns an `AuthTokenResult`. When the server's verification gate is on, the result carries `requiresVerification: true` and the session flips to `"unverified"` — no JWT yet. `options.remember` pins the resulting session to `localStorage` (`true`) or `sessionStorage` (`false`); omit to use the `SessionManager` default. |
| `login({ email, password }, options?)` | Exchange credentials for a JWT. Session flips to `"authenticated"` on success, `"unverified"` if the server reports the gate. `options.remember` selects per-login storage (see `register`). |
| `logout()` | Best-effort server revoke + local clear. Idempotent. |
| `resendVerification({ email, lang? })` | Trigger a fresh verification email. Anti-enumeration: always resolves. |
| `requestPasswordReset({ email, lang? })` | Trigger a password-reset email. Anti-enumeration. |
| `changePassword({ current_password?, new_password, confirm_password, token? })` | Authenticated self-change (with `current_password`) or token-based reset. |
| `deleteAccount({ password?, confirm? })` | Irreversible server delete + local session clear + identity-changed hook. |
| `initiateOAuth(provider, opts)` | Start an OAuth flow. `mode: "popup"` (default) resolves with the auth result from the popup's `postMessage`; `mode: "redirect"` navigates the top window. `opts.remember` pins the resulting session's storage backend (only meaningful for `action: "login"`). |
| `handleOAuthCallback(options?)` | For `mode: "redirect"` apps, call from your callback route to extract the result from the URL (delegated to `adapter.handleOAuthCallback`). `options.remember` pins the resulting session's storage — pass the same value the user picked before the redirect. |

Successful identity changes (register-with-autologin, login, OAuth login, logout, deleteAccount) fire the orchestrator's `onIdentityChanged` hook, which resets every owner-scoped domain and re-initializes them with the new context.

---

### `ProfileManager`

Singleton `/me` manager. Attached as `suite.profile`.

| Method | Purpose |
|---|---|
| `fetch()` | GET `/me`. Aborts any in-flight fetch (supersede). Patches the session subject in place on success. |
| `update({ email?, current_password? })` | PUT `/me`. Updates the session subject in place; emits `profile:updated`. |
| `listOAuth()` | List the account's linked OAuth providers. |
| `unlinkOAuth(provider)` | DELETE a provider connection; emits `oauth:unlinked`; re-fetches the profile. |
| `get()` / `subscribe(fn)` | Read / subscribe to `ProfileState` (`{ profile, loading, error }`). |
| `reset()` / `destroy()` | Abort in-flight fetch; drop state. |

---

### `openOAuthPopup(url, options?)`

Open an OAuth popup and await the server's `postMessage`.

**Parameters:**
- `url` (`string`) — server OAuth init URL.
- `options` (`OpenOAuthPopupOptions`, optional)
  - `options.host` (`PopupWindowHost`, optional) — shim for tests. Default: `globalThis`.
  - `options.closedPollMs` (`number`, optional) — detect popup-closed-without-message. Default: `500`.
  - `options.timeoutMs` (`number`, optional) — hard timeout. Default: `0` (disabled).
  - `options.expectedOrigin` (`string`, optional) — restrict accepted message origins.
  - `options.features` (`string`, optional) — popup window features string.

**Returns:** `Promise<OAuthPopupMessage>` — resolves with `{ type: "oauth_login_success", jwt, email, roles?, ... }` or `{ type: "oauth_link_success", provider }`. Rejects with `OAUTH_POPUP_BLOCKED` / `OAUTH_POPUP_CLOSED` / `OAUTH_POPUP_TIMEOUT` or the server-supplied error message.

---

## Account-lifecycle types

### `SessionState`

```typescript
interface SessionState {
    status: "anonymous" | "authenticated" | "unverified";
    subject: SessionSubject | null;
    jwt: string | null;
    expiresAt: number | null;  // unix seconds
}
```

### `SessionSubject`

```typescript
interface SessionSubject {
    id: string;
    email: string;
    roles: string[];
    isVerified: boolean;
    hasPassword: boolean;   // OAuth-only accounts: false
}
```

### `SessionStatus` / `SessionStorage` / `SessionStorageType`

```typescript
type SessionStatus = "anonymous" | "authenticated" | "unverified";

interface SessionStorage {
    get(key: string): string | null;
    set(key: string, value: string): void;
    del(key: string): void;
}

type SessionStorageType = "local" | "session" | "memory" | SessionStorage;
```

### `AuthTokenResult`

```typescript
interface AuthTokenResult {
    jwt?: string;                    // absent when requiresVerification is true
    email: string;
    roles: string[];
    isVerified?: boolean;
    validFrom?: number;
    validUntil?: number;
    requiresVerification?: boolean;  // server declined auto-login pending verify
}
```

### `ProfileResult`

```typescript
interface ProfileResult {
    email: string;
    roles: string[];
    isVerified: boolean;
    hasPassword: boolean;
    oauthConnections: OAuthConnection[];
}
```

### `OAuthProvider` / `OAuthAction` / `OAuthInitOptions` / `OAuthConnection`

```typescript
type OAuthProvider = "google" | "facebook" | "apple" | "twitter";
type OAuthAction = "login" | "link";

interface OAuthInitOptions {
    action: OAuthAction;
    redirect?: string;
    lang?: string;
    mode?: "popup" | "redirect";  // default "popup"
    remember?: boolean;           // same semantics as AuthActionOptions.remember
}

interface AuthActionOptions {
    /** true → localStorage; false → sessionStorage; undefined → default.
     *  Ignored when SessionManager was constructed with a custom
     *  SessionStorage object. */
    remember?: boolean;
}

interface OAuthConnection {
    provider: OAuthProvider;
    display_name?: string;
    avatar_url?: string;
    email?: string;
}
```

### `AuthAdapter`

```typescript
interface AuthAdapter {
    register(input, ctx): Promise<AuthTokenResult>;
    login(input, ctx): Promise<AuthTokenResult>;
    logout(ctx): Promise<void>;
    oauthInitUrl(provider, opts, ctx): string;
    handleOAuthCallback?(ctx): Promise<AuthTokenResult>;
    resendVerification(input, ctx): Promise<void>;
    requestPasswordReset(input, ctx): Promise<void>;
    changePassword(input, ctx): Promise<void>;
    deleteAccount(input, ctx): Promise<{ deleted: true }>;
}
```

Parameter shapes match [`src/types/auth.ts`](src/types/auth.ts). Implementations forward `ctx.jwt` as `Authorization: Bearer <jwt>` and `ctx.signal` to `fetch()`.

### `ProfileAdapter`

```typescript
interface ProfileAdapter {
    get(ctx): Promise<ProfileResult>;
    update(input: { email?, current_password? }, ctx): Promise<ProfileResult>;
    listOAuth(ctx): Promise<OAuthConnection[]>;
    unlinkOAuth(provider, ctx): Promise<void>;
}
```

### `StackAccountAdapterOptions`

```typescript
interface StackAccountAdapterOptions {
    baseUrl?: string;    // default "/api/account"
    fetch?: typeof fetch;
}
```

### `OpenOAuthPopupOptions` / `PopupWindowHost` / `OAuthPopupMessage`

See [src/oauth/popup.ts](src/oauth/popup.ts) for full definitions. `OAuthPopupMessage` is a union of `OAuthPopupLoginMessage` (`{ type: "oauth_login_success", jwt, email, roles?, ... }`) and `OAuthPopupLinkMessage` (`{ type: "oauth_link_success", provider }`). Errors posted by the server (`{ type: "oauth_error", error }`) cause the promise to reject.

### `MockAuthStore`

```typescript
interface MockAuthStore {
    accounts: Map<string, MockAccount>;
    requireVerifiedEmail: boolean;
    jwtsByEmail: Map<string, string>;
}
```

---

## Account-lifecycle events

Emitted on the shared pubsub. Each payload has a `timestamp` (ms).

| Event | Payload |
|---|---|
| `auth:register` | `{ email, requiresVerification }` |
| `auth:login` | `{ email }` |
| `auth:logout` | `{ subjectId? }` |
| `auth:session:changed` | `{ session: SessionState }` |
| `auth:verification:required` | `{ email }` (fired when status flips to `"unverified"`) |
| `profile:updated` | `{ email }` |
| `oauth:linked` | `{ connection: OAuthConnection }` |
| `oauth:unlinked` | `{ provider: OAuthProvider }` |
