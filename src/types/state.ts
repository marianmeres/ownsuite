/**
 * @module types/state
 *
 * Core state and context types for ownsuite domain managers.
 * Mirrors the shape of `@marianmeres/ecsuite` but specialized for
 * owner-scoped collection CRUD (a single list of rows per domain).
 */

/** Domain state progression — identical to ecsuite for ecosystem consistency. */
export type DomainState = "initializing" | "ready" | "syncing" | "error";

/** Error information structure. */
export interface DomainError {
	/** Error code for programmatic handling */
	code: string;
	/** Human-readable message */
	message: string;
	/** Operation that failed */
	operation: string;
	/** Original error for debugging */
	originalError?: unknown;
}

/** Base state wrapper for all domains. */
export interface DomainStateWrapper<T> {
	/** Current domain state */
	state: DomainState;
	/** Domain data (null during initialization or after a critical error) */
	data: T | null;
	/** Error information when state is "error" */
	error: DomainError | null;
	/** Timestamp of last successful sync */
	lastSyncedAt: number | null;
}

/**
 * Context passed to adapters. Ownsuite does not require the caller to know
 * its own `ownerId` — the server resolves it from the authenticated subject
 * via the `/me/*` mount. The context is still provided so adapters can pass
 * arbitrary host-app data (correlation ids, feature flags, etc.) through.
 *
 * The manager also injects a per-operation `signal` into `ctx` for every
 * adapter call. Adapters that care about cancellation should forward it
 * to `fetch()`; adapters that don't can ignore it.
 */
export interface OwnsuiteContext {
	/** Hint — not used for authorization. The server is authoritative. */
	subjectId?: string;
	/**
	 * Per-operation abort signal injected by the manager. Adapters should
	 * forward this to `fetch(url, { signal: ctx.signal })`. Aborts fire on
	 * `reset()`, `destroy()`, and when a newer read supersedes an older one.
	 */
	signal?: AbortSignal;
	/** Additional context properties for adapter-specific needs. */
	[key: string]: unknown;
}

/**
 * State shape for a single owner-scoped collection domain: a list of rows
 * plus pagination/meta info from the last list operation. Individual-row
 * operations (get/update/delete) mutate the list in place without replacing
 * meta, so optimistic updates work naturally.
 */
export interface OwnedCollectionState<TRow> {
	/** Rows owned by the current subject (server-scoped). */
	rows: TRow[];
	/** Metadata from the last list response (total count, pagination, etc.). */
	meta: Record<string, unknown>;
}
