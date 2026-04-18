/**
 * @module adapters/mock
 *
 * In-memory mock adapter for testing. Stores rows in a local Map keyed by
 * `model_id`, applies an optional latency, honors `ctx.signal` for
 * cancellation, and can inject failures. Useful for unit tests without a
 * real server, and for exercising the manager's optimistic-update rollback
 * path deterministically.
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
	/**
	 * If true (default), `create` rejects payloads that include a
	 * `model_id` — matches the production server contract where the server
	 * is authoritative over ids. Set to `false` to bypass for legacy tests.
	 */
	rejectClientId?: boolean;
}

const defaultGetRowId = <TRow>(r: TRow): string => {
	const rec = r as Record<string, unknown>;
	const id = rec.model_id ?? rec.id;
	if (typeof id !== "string" || id === "") {
		throw new Error(
			"MockAdapter: row has no non-empty string `model_id` or `id`; pass `getRowId`",
		);
	}
	return id;
};

function safeClone<T>(value: T): T {
	if (value === null || value === undefined) return value;
	try {
		return structuredClone(value);
	} catch {
		try {
			return JSON.parse(JSON.stringify(value)) as T;
		} catch {
			return value;
		}
	}
}

/** Throw an AbortError-shaped error if the signal was aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		const reason = (signal as AbortSignal & { reason?: unknown }).reason;
		const err = new Error(
			typeof reason === "string" ? `mock: aborted (${reason})` : "mock: aborted",
		);
		err.name = "AbortError";
		throw err;
	}
}

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
		rejectClientId = true,
	} = options;

	const store = new Map<string, TRow>();
	for (const r of options.seed ?? []) store.set(getRowId(r), r);

	/**
	 * Latency helper that also observes abort. Returns when either the
	 * delay elapses or the signal fires — the caller then checks
	 * `throwIfAborted` to convert to an error.
	 */
	const sleep = (signal?: AbortSignal): Promise<void> => {
		if (delayMs <= 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const t = setTimeout(resolve, delayMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true },
			);
		});
	};

	return {
		async list(
			ctx: OwnsuiteContext,
			_query?: Record<string, unknown>,
		): Promise<OwnedListResult<TRow>> {
			await sleep(ctx.signal);
			throwIfAborted(ctx.signal);
			if (failOn.list) throw new Error("mock: list failed");
			const rows = [...store.values()].map((r) => safeClone(r));
			return { data: rows, meta: { total: rows.length } };
		},

		async getOne(id: string, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>> {
			await sleep(ctx.signal);
			throwIfAborted(ctx.signal);
			if (failOn.getOne) throw new Error("mock: getOne failed");
			const row = store.get(id);
			if (!row) throw new Error(`mock: row ${id} not found`);
			return { data: safeClone(row) };
		},

		async create(data: TCreate, ctx: OwnsuiteContext): Promise<OwnedRowResult<TRow>> {
			await sleep(ctx.signal);
			throwIfAborted(ctx.signal);
			if (failOn.create) throw new Error("mock: create failed");
			const input = data as unknown;
			if (
				rejectClientId &&
				input !== null &&
				typeof input === "object" &&
				"model_id" in (input as object)
			) {
				throw new Error(
					"mock: create payload must not include `model_id` — the server assigns the id",
				);
			}
			const id = newId();
			const cloned = safeClone(data as object);
			const row = { ...(cloned as object), model_id: id } as unknown as TRow;
			store.set(id, row);
			return { data: safeClone(row) };
		},

		async update(
			id: string,
			data: TUpdate,
			ctx: OwnsuiteContext,
		): Promise<OwnedRowResult<TRow>> {
			await sleep(ctx.signal);
			throwIfAborted(ctx.signal);
			if (failOn.update) throw new Error("mock: update failed");
			const existing = store.get(id);
			if (!existing) throw new Error(`mock: row ${id} not found`);
			const merged = {
				...(existing as object),
				...(safeClone(data) as object),
			} as TRow;
			store.set(id, merged);
			return { data: safeClone(merged) };
		},

		async delete(id: string, ctx: OwnsuiteContext): Promise<boolean> {
			await sleep(ctx.signal);
			throwIfAborted(ctx.signal);
			if (failOn.delete) throw new Error("mock: delete failed");
			return store.delete(id);
		},

		_rows: () => [...store.values()],
	};
}
