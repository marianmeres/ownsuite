/**
 * @module domains/owned-collection
 *
 * Generic manager for a single owner-scoped collection domain. Operates on
 * any row shape `TRow` via an injected `OwnedCollectionAdapter`. All CRUD
 * operations are implicitly scoped to the authenticated subject by the
 * server — the client never sets `owner_id`.
 */

import type { OwnedCollectionAdapter } from "../types/adapter.ts";
import type { OwnedCollectionState } from "../types/state.ts";
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
	if (typeof id !== "string") {
		throw new Error(
			"OwnedCollectionManager: row has no string `model_id` or `id`; " +
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

	/** Initialize by fetching the list from the server. */
	override async initialize(): Promise<void> {
		if (!this.adapter) {
			this.setState("ready");
			return;
		}
		this.setState("syncing");
		try {
			const res = await this.adapter.list(this.context);
			this.setData({ rows: res.data, meta: res.meta });
			this.markSynced();
			this.emit({
				type: "own:list:fetched",
				domain: this.domainName,
				timestamp: Date.now(),
				count: res.data.length,
			});
		} catch (e) {
			this.setError({
				code: "FETCH_FAILED",
				message: e instanceof Error ? e.message : "Failed to fetch list",
				originalError: e,
				operation: "initialize",
			});
		}
	}

	/** Refresh the list from server. Same as initialize but re-entrant. */
	async refresh(query?: Record<string, unknown>): Promise<void> {
		if (!this.adapter) return;
		this.setState("syncing");
		try {
			const res = await this.adapter.list(this.context, query);
			this.setData({ rows: res.data, meta: res.meta });
			this.markSynced();
			this.emit({
				type: "own:list:fetched",
				domain: this.domainName,
				timestamp: Date.now(),
				count: res.data.length,
			});
		} catch (e) {
			this.setError({
				code: "FETCH_FAILED",
				message: e instanceof Error ? e.message : "Failed to refresh list",
				originalError: e,
				operation: "refresh",
			});
		}
	}

	/** Fetch a single row by id; returns the row but does not update the list. */
	async getOne(id: string): Promise<TRow | null> {
		if (!this.adapter) return null;
		try {
			const res = await this.adapter.getOne(id, this.context);
			this.emit({
				type: "own:row:fetched",
				domain: this.domainName,
				timestamp: Date.now(),
				rowId: id,
			});
			return res.data;
		} catch (e) {
			this.setError({
				code: "FETCH_FAILED",
				message: e instanceof Error ? e.message : "Failed to fetch row",
				originalError: e,
				operation: "getOne",
			});
			return null;
		}
	}

	/** Create a new row. Optimistically prepends to the list. */
	async create(data: TCreate): Promise<TRow | null> {
		if (!this.adapter) return null;
		const current = this.store.get().data ?? { rows: [], meta: {} };
		let result: TRow | null = null;
		await this.withOptimisticUpdate(
			"create",
			() => {
				// No optimistic row insertion: we don't know the server-assigned id.
				// Just keep the list unchanged; flip to syncing is handled for us.
			},
			async () => {
				const res = await this.adapter!.create(data, this.context);
				return res.data;
			},
			(serverRow) => {
				result = serverRow;
				this.setData({
					rows: [serverRow, ...current.rows],
					meta: current.meta,
				});
				this.emit({
					type: "own:row:created",
					domain: this.domainName,
					timestamp: Date.now(),
					rowId: this.#getRowId(serverRow),
				});
			},
		);
		return result;
	}

	/** Update a row. Optimistically merges into the list. */
	async update(id: string, data: TUpdate): Promise<TRow | null> {
		if (!this.adapter) return null;
		const current = this.store.get().data ?? { rows: [], meta: {} };
		const idx = current.rows.findIndex((r) => this.#getRowId(r) === id);
		let result: TRow | null = null;
		await this.withOptimisticUpdate(
			"update",
			() => {
				if (idx === -1) return;
				const optimistic = { ...current.rows[idx], ...(data as object) } as TRow;
				const rows = current.rows.slice();
				rows[idx] = optimistic;
				this.setData({ rows, meta: current.meta }, false);
			},
			async () => {
				const res = await this.adapter!.update(id, data, this.context);
				return res.data;
			},
			(serverRow) => {
				result = serverRow;
				const rows =
					idx === -1
						? [serverRow, ...current.rows]
						: current.rows.map((r, i) => (i === idx ? serverRow : r));
				this.setData({ rows, meta: current.meta });
				this.emit({
					type: "own:row:updated",
					domain: this.domainName,
					timestamp: Date.now(),
					rowId: id,
				});
			},
		);
		return result;
	}

	/** Delete a row. Optimistically removes from the list. */
	async delete(id: string): Promise<boolean> {
		if (!this.adapter) return false;
		const current = this.store.get().data ?? { rows: [], meta: {} };
		let ok = false;
		await this.withOptimisticUpdate(
			"delete",
			() => {
				this.setData(
					{
						rows: current.rows.filter((r) => this.#getRowId(r) !== id),
						meta: current.meta,
					},
					false,
				);
			},
			async () => {
				return await this.adapter!.delete(id, this.context);
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
		);
		return ok;
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
