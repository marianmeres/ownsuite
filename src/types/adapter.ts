/**
 * @module types/adapter
 *
 * Adapter interface for server communication. One adapter instance drives
 * one owner-scoped domain (a single collection path on the server).
 *
 * Implementations typically wrap `fetch()` calls against the stack's
 * `/me/<collection-path>/mod` endpoints; see `stack-common/ownsuite` for
 * the matching server-side convention.
 */

import type { OwnsuiteContext } from "./state.ts";

/**
 * Standard list result shape: rows + meta. Matches the collection package's
 * REST response envelope for consistency, but adapters are free to return
 * whatever shape their server uses and map it here.
 */
export interface OwnedListResult<TRow> {
	data: TRow[];
	meta: Record<string, unknown>;
}

/**
 * Standard single-row result shape: one row + meta. Also matches the
 * collection package's REST envelope.
 */
export interface OwnedRowResult<TRow> {
	data: TRow;
	meta?: Record<string, unknown>;
}

/**
 * Adapter for a single owner-scoped collection domain.
 *
 * Notes for implementors:
 * - `owner_id` is enforced server-side. Do NOT attempt to pass it from the
 *   client. The client can only act on rows it owns.
 * - Errors should throw (ideally `HTTP_ERROR` from `@marianmeres/http-utils`);
 *   the manager handles rollback and error state.
 * - `ctx.signal` is populated by the manager on every call — forward it to
 *   `fetch(url, { signal: ctx.signal })` to support route-change and
 *   destroy cancellation. Ignoring the signal is safe but leaves abandoned
 *   requests running to completion (wasted bandwidth; no state corruption).
 */
export interface OwnedCollectionAdapter<TRow, TCreate = unknown, TUpdate = unknown> {
	/** List rows owned by the current subject. Query params are implementation-defined. */
	list(ctx: OwnsuiteContext, query?: Record<string, unknown>): Promise<OwnedListResult<TRow>>;

	/** Get one row by id (server returns 404 if not owned by subject). */
	getOne(id: string, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>>;

	/** Create a new row (server stamps owner_id from the authenticated subject). */
	create(data: TCreate, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>>;

	/** Update a row by id (owner_id is immutable server-side). */
	update(id: string, data: TUpdate, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>>;

	/** Delete a row by id (404 if not owned). */
	delete(id: string, ctx: OwnsuiteContext): Promise<boolean>;
}
