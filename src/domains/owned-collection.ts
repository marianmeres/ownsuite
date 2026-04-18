/**
 * @module domains/owned-collection
 *
 * Generic manager for a single owner-scoped collection domain. Operates on
 * any row shape `TRow` via an injected `OwnedCollectionAdapter`. All CRUD
 * operations are implicitly scoped to the authenticated subject by the
 * server — the client never sets `owner_id`.
 *
 * Concurrency model:
 * - Mutations (create/update/delete) serialize through a per-manager chain.
 * - Reads (initialize/refresh) use abort-supersede: a newer read aborts
 *   any in-flight older read.
 * - `onSuccess` callbacks read the live store (not a captured snapshot) so
 *   interleaving reads do not erase each other's writes.
 */

import type { OwnedCollectionAdapter } from "../types/adapter.ts";
import type { OwnedCollectionState, OwnsuiteContext } from "../types/state.ts";
import { BaseDomainManager, type BaseDomainOptions } from "./base.ts";

export interface OwnedCollectionManagerOptions<TRow, TCreate, TUpdate>
	extends BaseDomainOptions {
	adapter?: OwnedCollectionAdapter<TRow, TCreate, TUpdate>;
	/** Function that extracts the row id from a row. Defaults to `row.model_id`. */
	getRowId?: (row: TRow) => string;
}

const defaultGetRowId = <TRow>(row: TRow): string => {
	const r = row as Record<string, unknown>;
	const id = r.model_id ?? r.id;
	if (typeof id !== "string" || id === "") {
		throw new Error(
			"OwnedCollectionManager: row has no non-empty string `model_id` or `id`; " +
				"pass a custom `getRowId` in options.",
		);
	}
	return id;
};

/**
 * Generic domain manager for one owner-scoped collection.
 *
 * State shape: `{ rows: TRow[]; meta: {...} }`. List operations replace
 * rows wholesale; single-row operations (create/update/delete) apply
 * in-place mutations so the list stays stable without a re-fetch.
 */
export class OwnedCollectionManager<
	TRow = Record<string, unknown>,
	TCreate = Partial<TRow>,
	TUpdate = Partial<TRow>,
> extends BaseDomainManager<
	OwnedCollectionState<TRow>,
	OwnedCollectionAdapter<TRow, TCreate, TUpdate>
> {
	readonly #getRowId: (row: TRow) => string;

	constructor(
		domainName: string,
		options: OwnedCollectionManagerOptions<TRow, TCreate, TUpdate> = {},
	) {
		super(domainName, options);
		this.#getRowId = options.getRowId ?? defaultGetRowId;
		if (options.adapter) this.adapter = options.adapter;
	}

	/** Build the per-op adapter context with the injected signal. */
	#ctx(signal: AbortSignal): OwnsuiteContext {
		return { ...this.context, signal };
	}

	/** Current data or an empty shell. */
	#live(): OwnedCollectionState<TRow> {
		return this.store.get().data ?? { rows: [], meta: {} };
	}

	/** Initialize by fetching the list from the server. */
	override async initialize(): Promise<void> {
		if (this.isDestroyed) return;
		if (!this.adapter) {
			this.setState("ready");
			return;
		}
		await this.serializeRead(async (signal) => {
			this.setState("syncing");
			try {
				const res = await this.adapter!.list(this.#ctx(signal));
				if (signal.aborted) return;
				this.setData({ rows: res.data, meta: res.meta });
				this.markSynced();
				this.emit({
					type: "own:list:fetched",
					domain: this.domainName,
					timestamp: Date.now(),
					count: res.data.length,
				});
			} catch (e) {
				if (signal.aborted) return;
				this.setError({
					code: "FETCH_FAILED",
					message: e instanceof Error ? e.message : "Failed to fetch list",
					originalError: e,
					operation: "initialize",
				});
			}
		});
	}

	/** Refresh the list from server. Same as initialize but re-entrant. */
	async refresh(query?: Record<string, unknown>): Promise<void> {
		if (this.isDestroyed || !this.adapter) return;
		await this.serializeRead(async (signal) => {
			this.setState("syncing");
			try {
				const res = await this.adapter!.list(this.#ctx(signal), query);
				if (signal.aborted) return;
				this.setData({ rows: res.data, meta: res.meta });
				this.markSynced();
				this.emit({
					type: "own:list:fetched",
					domain: this.domainName,
					timestamp: Date.now(),
					count: res.data.length,
				});
			} catch (e) {
				if (signal.aborted) return;
				this.setError({
					code: "FETCH_FAILED",
					message: e instanceof Error ? e.message : "Failed to refresh list",
					originalError: e,
					operation: "refresh",
				});
			}
		});
	}

	/**
	 * Fetch a single row by id. Does NOT update the list and does NOT
	 * transition the domain to `error` on failure — a 404 for an un-owned
	 * row or a network blip on a read shouldn't invalidate a healthy list
	 * view. Emits `own:row:fetched` on success.
	 *
	 * Returns `null` on any failure (including missing adapter). Callers
	 * that need error detail should wrap this method and inspect the thrown
	 * adapter error themselves.
	 */
	async getOne(id: string): Promise<TRow | null> {
		if (this.isDestroyed || !this.adapter) return null;
		const ctrl = this.newController();
		try {
			const res = await this.adapter.getOne(id, this.#ctx(ctrl.signal));
			if (ctrl.signal.aborted) return null;
			this.emit({
				type: "own:row:fetched",
				domain: this.domainName,
				timestamp: Date.now(),
				rowId: id,
			});
			return res.data;
		} catch (e) {
			if (ctrl.signal.aborted) return null;
			this.clog.debug("getOne failed", {
				id,
				error: e instanceof Error ? e.message : e,
			});
			return null;
		} finally {
			this.releaseController(ctrl);
		}
	}

	/** Create a new row. Server assigns the id; on success, prepends to the list. */
	async create(data: TCreate): Promise<TRow | null> {
		if (this.isDestroyed || !this.adapter) return null;
		return this.serializeMutation(async () => {
			let result: TRow | null = null;
			await this.withOptimisticUpdate(
				"create",
				() => {
					// No optimistic insertion — no client-assigned id. `syncing`
					// transition still happens so subscribers see the pending state.
				},
				async () => {
					const ctrl = this.newController();
					try {
						const res = await this.adapter!.create(data, this.#ctx(ctrl.signal));
						return res.data;
					} finally {
						this.releaseController(ctrl);
					}
				},
				(serverRow) => {
					result = serverRow;
					// Read live state (not snapshot) so a concurrent delete/refresh is preserved.
					const live = this.#live();
					this.setData({
						rows: [serverRow, ...live.rows],
						meta: live.meta,
					});
					this.emit({
						type: "own:row:created",
						domain: this.domainName,
						timestamp: Date.now(),
						rowId: this.#getRowId(serverRow),
					});
				},
				// No onError: create has no optimistic state to revert; default
				// rollback (restore snapshot) also not needed since we never mutated.
				() => {},
			);
			return result;
		});
	}

	/**
	 * Update a row. Optimistically merges `data` into the existing row; on
	 * server failure reverts that single row to its pre-call value (without
	 * clobbering any interleaved refresh or other mutations).
	 *
	 * If `id` is not in the current list (e.g., filtered out by an active
	 * query or not owned), the optimistic step is a no-op AND the successful
	 * server response is NOT inserted — call `refresh()` if you want the
	 * row to appear. Emits `own:row:updated` on success regardless.
	 */
	async update(id: string, data: TUpdate): Promise<TRow | null> {
		if (this.isDestroyed || !this.adapter) return null;
		return this.serializeMutation(async () => {
			const startData = this.#live();
			const startIdx = startData.rows.findIndex(
				(r) => this.#getRowId(r) === id,
			);
			const originalRow = startIdx !== -1 ? startData.rows[startIdx] : null;
			let result: TRow | null = null;
			await this.withOptimisticUpdate(
				"update",
				() => {
					if (originalRow === null) return;
					const optimistic = {
						...(originalRow as object),
						...(data as object),
					} as TRow;
					const live = this.#live();
					const liveIdx = live.rows.findIndex((r) => this.#getRowId(r) === id);
					if (liveIdx === -1) return;
					const rows = live.rows.slice();
					rows[liveIdx] = optimistic;
					this.setData({ rows, meta: live.meta }, false);
				},
				async () => {
					const ctrl = this.newController();
					try {
						const res = await this.adapter!.update(
							id,
							data,
							this.#ctx(ctrl.signal),
						);
						return res.data;
					} finally {
						this.releaseController(ctrl);
					}
				},
				(serverRow) => {
					result = serverRow;
					const live = this.#live();
					const liveIdx = live.rows.findIndex(
						(r) => this.#getRowId(r) === id,
					);
					if (liveIdx !== -1) {
						const rows = live.rows.map((r, i) => (i === liveIdx ? serverRow : r));
						this.setData({ rows, meta: live.meta });
					}
					// If liveIdx === -1 the row is not in the current list; do NOT
					// insert (avoids phantom rows when filtered/unknown).
					this.emit({
						type: "own:row:updated",
						domain: this.domainName,
						timestamp: Date.now(),
						rowId: id,
					});
				},
				(_error, _snapshot) => {
					// Per-row rollback: restore the one row we mutated (or nothing).
					if (originalRow === null) return;
					const live = this.#live();
					const liveIdx = live.rows.findIndex(
						(r) => this.#getRowId(r) === id,
					);
					if (liveIdx === -1) return; // row was removed by another op; don't re-add
					const rows = live.rows.slice();
					rows[liveIdx] = originalRow;
					this.setData({ rows, meta: live.meta }, false);
				},
			);
			return result;
		});
	}

	/** Delete a row. Optimistically removes from the list; re-inserts on failure. */
	async delete(id: string): Promise<boolean> {
		if (this.isDestroyed || !this.adapter) return false;
		return this.serializeMutation(async () => {
			const startData = this.#live();
			const startIdx = startData.rows.findIndex(
				(r) => this.#getRowId(r) === id,
			);
			const originalRow = startIdx !== -1 ? startData.rows[startIdx] : null;
			let ok = false;
			await this.withOptimisticUpdate(
				"delete",
				() => {
					const live = this.#live();
					this.setData(
						{
							rows: live.rows.filter((r) => this.#getRowId(r) !== id),
							meta: live.meta,
						},
						false,
					);
				},
				async () => {
					const ctrl = this.newController();
					try {
						return await this.adapter!.delete(id, this.#ctx(ctrl.signal));
					} finally {
						this.releaseController(ctrl);
					}
				},
				(serverOk) => {
					ok = serverOk;
					this.emit({
						type: "own:row:deleted",
						domain: this.domainName,
						timestamp: Date.now(),
						rowId: id,
					});
				},
				(_error, _snapshot) => {
					// Per-row rollback: re-insert the deleted row at its original
					// position, unless it was independently re-added by another op.
					if (originalRow === null) return;
					const live = this.#live();
					if (live.rows.some((r) => this.#getRowId(r) === id)) return;
					const rows = live.rows.slice();
					// Clamp insertion index to current list length.
					const insertAt = Math.min(startIdx, rows.length);
					rows.splice(insertAt < 0 ? 0 : insertAt, 0, originalRow);
					this.setData({ rows, meta: live.meta }, false);
				},
			);
			return ok;
		});
	}

	/** Snapshot of current rows (empty array if not loaded). */
	getRows(): TRow[] {
		return this.store.get().data?.rows ?? [];
	}

	/** Find a row by id in the current list (without hitting the server). */
	findRow(id: string): TRow | undefined {
		return this.getRows().find((r) => this.#getRowId(r) === id);
	}
}
