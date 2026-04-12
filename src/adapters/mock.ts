/**
 * @module adapters/mock
 *
 * In-memory mock adapter for testing. Stores rows in a local Map keyed by
 * `model_id`, applies an optional latency, and can inject failures. Useful
 * for unit tests without a real server, and for exercising the manager's
 * optimistic-update rollback path deterministically.
 */

import type {
	OwnedCollectionAdapter,
	OwnedListResult,
	OwnedRowResult,
} from "../types/adapter.ts";
import type { OwnsuiteContext } from "../types/state.ts";

export interface MockAdapterOptions<TRow> {
	/** Initial seed rows. */
	seed?: TRow[];
	/** Artificial latency per call (ms). */
	delayMs?: number;
	/** If set, every call on matching operation throws. Use for rollback tests. */
	failOn?: {
		list?: boolean;
		getOne?: boolean;
		create?: boolean;
		update?: boolean;
		delete?: boolean;
	};
	/** Row-id resolver. Defaults to `row.model_id` or `row.id`. */
	getRowId?: (row: TRow) => string;
	/** Factory for new row ids (defaults to `crypto.randomUUID`). */
	newId?: () => string;
}

const defaultGetRowId = <TRow>(r: TRow): string => {
	const rec = r as Record<string, unknown>;
	const id = rec.model_id ?? rec.id;
	if (typeof id !== "string") {
		throw new Error(
			"MockAdapter: row has no string `model_id` or `id`; pass `getRowId`",
		);
	}
	return id;
};

/**
 * Build an in-memory `OwnedCollectionAdapter` for tests.
 */
export function createMockOwnedCollectionAdapter<
	TRow extends Record<string, unknown> = Record<string, unknown>,
	TCreate = Partial<TRow>,
	TUpdate = Partial<TRow>,
>(
	options: MockAdapterOptions<TRow> = {},
): OwnedCollectionAdapter<TRow, TCreate, TUpdate> & {
	/** Peek at the underlying store (tests only). */
	_rows(): TRow[];
} {
	const {
		delayMs = 0,
		failOn = {},
		getRowId = defaultGetRowId,
		newId = () => crypto.randomUUID(),
	} = options;

	const store = new Map<string, TRow>();
	for (const r of options.seed ?? []) store.set(getRowId(r), r);

	const sleep = () =>
		delayMs > 0
			? new Promise<void>((res) => setTimeout(res, delayMs))
			: Promise.resolve();

	return {
		async list(
			_ctx: OwnsuiteContext,
			_query?: Record<string, unknown>,
		): Promise<OwnedListResult<TRow>> {
			await sleep();
			if (failOn.list) throw new Error("mock: list failed");
			const rows = [...store.values()];
			return { data: rows, meta: { total: rows.length } };
		},

		async getOne(id: string, _ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>> {
			await sleep();
			if (failOn.getOne) throw new Error("mock: getOne failed");
			const row = store.get(id);
			if (!row) throw new Error(`mock: row ${id} not found`);
			return { data: row };
		},

		async create(data: TCreate, _ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>> {
			await sleep();
			if (failOn.create) throw new Error("mock: create failed");
			const id = newId();
			const row = { ...(data as object), model_id: id } as unknown as TRow;
			store.set(id, row);
			return { data: row };
		},

		async update(
			id: string,
			data: TUpdate,
			_ctx: OwnsuiteContext,
		): Promise<OwnedRowResult<TRow>> {
			await sleep();
			if (failOn.update) throw new Error("mock: update failed");
			const existing = store.get(id);
			if (!existing) throw new Error(`mock: row ${id} not found`);
			const merged = { ...existing, ...(data as object) } as TRow;
			store.set(id, merged);
			return { data: merged };
		},

		async delete(id: string, _ctx: OwnsuiteContext): Promise<boolean> {
			await sleep();
			if (failOn.delete) throw new Error("mock: delete failed");
			return store.delete(id);
		},

		_rows: () => [...store.values()],
	};
}
