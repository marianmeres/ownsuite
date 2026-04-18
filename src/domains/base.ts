/**
 * @module domains/base
 *
 * Base domain manager. Provides reactive state, state-machine transitions,
 * optimistic update pattern, mutation serialization, abort-supersede reads,
 * and event emission. Mirrors the shape of `@marianmeres/ecsuite`'s
 * `BaseDomainManager` so consumers already familiar with ecsuite can
 * read/subscribe to ownsuite domains identically.
 */

import { type Clog, createClog } from "@marianmeres/clog";
import { createStore, type StoreLike } from "@marianmeres/store";
import { createPubSub, type PubSub } from "@marianmeres/pubsub";
import type {
	DomainError,
	DomainState,
	DomainStateWrapper,
	OwnsuiteContext,
} from "../types/state.ts";
import type { DomainName, OwnsuiteEvent } from "../types/events.ts";

/** Base options for domain managers. */
export interface BaseDomainOptions {
	/** Initial context passed to adapters. */
	context?: OwnsuiteContext;
	/** Shared pubsub instance for events. */
	pubsub?: PubSub;
}

/**
 * Deep-clone helper with fallback. Uses `structuredClone` where available;
 * if a payload contains non-cloneable values (functions, class instances),
 * falls back to a JSON round-trip. A final fallback returns the original
 * reference (preserves pre-cloning behavior rather than throwing).
 */
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

/**
 * Abstract base class for ownsuite domain managers.
 *
 * @typeParam TData - The domain data shape (for ownsuite, typically `OwnedCollectionState<TRow>`).
 * @typeParam TAdapter - The adapter interface type for server communication.
 */
export abstract class BaseDomainManager<TData, TAdapter> {
	protected readonly store: StoreLike<DomainStateWrapper<TData>>;
	protected readonly pubsub: PubSub;
	protected readonly domainName: DomainName;
	protected readonly clog: Clog;
	protected adapter: TAdapter | null = null;
	protected context: OwnsuiteContext = {};

	/** Mutation chain head. Each create/update/delete appends itself here. */
	#mutationChain: Promise<unknown> = Promise.resolve();

	/** Controller for the currently-active read (initialize/refresh). */
	#readController: AbortController | null = null;

	/** All active controllers created via `newController()`, for bulk abort. */
	readonly #activeControllers: Set<AbortController> = new Set();

	#destroyed = false;

	constructor(domainName: DomainName, options: BaseDomainOptions = {}) {
		this.domainName = domainName;
		this.clog = createClog(`ownsuite:${domainName}`, { color: "auto" });
		this.pubsub = options.pubsub ?? createPubSub();
		this.context = options.context ?? {};

		const initialState: DomainStateWrapper<TData> = {
			state: "initializing",
			data: null,
			error: null,
			lastSyncedAt: null,
		};
		this.store = createStore<DomainStateWrapper<TData>>(initialState);
	}

	/** Svelte-compatible subscribe method. */
	get subscribe(): StoreLike<DomainStateWrapper<TData>>["subscribe"] {
		return this.store.subscribe;
	}

	/** Get current state synchronously. */
	get(): DomainStateWrapper<TData> {
		return this.store.get();
	}

	/** True after `destroy()` has been called. */
	get isDestroyed(): boolean {
		return this.#destroyed;
	}

	setAdapter(adapter: TAdapter): void {
		this.adapter = adapter;
	}

	getAdapter(): TAdapter | null {
		return this.adapter;
	}

	/**
	 * Merge `ctx` into the current context. Keys not present in `ctx` are
	 * preserved. To replace the context entirely use `replaceContext`.
	 */
	setContext(context: OwnsuiteContext): void {
		this.context = { ...this.context, ...context };
	}

	/** Replace the context object entirely (no merge with existing). */
	replaceContext(context: OwnsuiteContext): void {
		this.context = { ...context };
	}

	getContext(): OwnsuiteContext {
		return { ...this.context };
	}

	/** Transition to a new state. */
	protected setState(state: DomainState): void {
		const current = this.store.get();
		if (current.state !== state) {
			this.store.update((s) => ({ ...s, state }));
			this.emit({
				type: "domain:state:changed",
				domain: this.domainName,
				timestamp: Date.now(),
				previousState: current.state,
				newState: state,
			});
		}
	}

	/** Update data and optionally flip to ready. */
	protected setData(data: TData, markReady = true): void {
		this.store.update((s) => ({
			...s,
			data,
			state: markReady ? "ready" : s.state,
			error: null,
		}));
	}

	/** Set error state. */
	protected setError(error: DomainError): void {
		this.clog.error("error", {
			code: error.code,
			message: error.message,
			operation: error.operation,
		});
		this.store.update((s) => ({ ...s, state: "error", error }));
		this.emit({
			type: "domain:error",
			domain: this.domainName,
			timestamp: Date.now(),
			error,
		});
	}

	/** Mark as synced. */
	protected markSynced(): void {
		this.store.update((s) => ({
			...s,
			state: "ready",
			lastSyncedAt: Date.now(),
		}));
		this.emit({
			type: "domain:synced",
			domain: this.domainName,
			timestamp: Date.now(),
		});
	}

	/** Emit an event via pubsub. */
	protected emit(event: OwnsuiteEvent): void {
		this.pubsub.publish(event.type, event);
	}

	/**
	 * Create a new AbortController registered with this manager. `destroy()`
	 * and `reset()` abort all active controllers. Call `releaseController`
	 * when the operation is done (success or failure) to let the controller
	 * be garbage-collected.
	 */
	protected newController(): AbortController {
		const ctrl = new AbortController();
		this.#activeControllers.add(ctrl);
		return ctrl;
	}

	/** Stop tracking a controller. Call after the associated op completes. */
	protected releaseController(ctrl: AbortController): void {
		this.#activeControllers.delete(ctrl);
	}

	/** Abort every active controller (reads, mutations, other). */
	protected abortAll(reason?: string): void {
		for (const c of this.#activeControllers) {
			try {
				c.abort(reason);
			} catch {
				// ignore — abort() is idempotent in practice
			}
		}
		this.#activeControllers.clear();
		this.#readController = null;
	}

	/**
	 * Serialize mutations. Each call queues behind any in-flight mutation on
	 * this manager. Rejections are swallowed on the chain so subsequent
	 * callers always proceed (their own fn can still throw/reject and the
	 * caller sees it).
	 */
	protected async serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.#mutationChain;
		// Chain tail intentionally swallows rejection — serial order only.
		const mine = prev.then(() => fn(), () => fn());
		this.#mutationChain = mine.then(
			() => undefined,
			() => undefined,
		);
		return mine;
	}

	/**
	 * Run a read with abort-supersede semantics. Calling a second read
	 * aborts the first (its signal flips to aborted before/after the
	 * adapter resolves). The callback receives the signal and should check
	 * `signal.aborted` after any async step to skip state writes that would
	 * overwrite a fresher response.
	 */
	protected async serializeRead(
		fn: (signal: AbortSignal) => Promise<void>,
	): Promise<void> {
		// Supersede: abort the previous read if any.
		if (this.#readController) {
			try {
				this.#readController.abort("superseded");
			} catch {
				// ignore
			}
			this.#activeControllers.delete(this.#readController);
		}
		const ctrl = this.newController();
		this.#readController = ctrl;
		try {
			await fn(ctrl.signal);
		} finally {
			if (this.#readController === ctrl) this.#readController = null;
			this.releaseController(ctrl);
		}
	}

	/**
	 * Execute an async mutation with the optimistic-update pattern:
	 *   1. apply optimistic update immediately
	 *   2. flip to "syncing"
	 *   3. on success: mark synced, call onSuccess
	 *   4. on error: call onError for caller-driven rollback, then set error
	 *
	 * Callers provide both the optimistic mutation and its inverse (via
	 * `onError`). The inverse runs against the *live* store, which matters
	 * when a refresh landed between the optimistic write and the failure.
	 *
	 * A snapshot is captured via `safeClone` and passed to `onError` for
	 * callers that prefer a whole-data restore over per-change inversion.
	 */
	protected async withOptimisticUpdate<T>(
		operation: string,
		optimisticUpdate: () => void,
		serverSync: () => Promise<T>,
		onSuccess?: (result: T) => void,
		onError?: (error: DomainError, snapshot: TData | null) => void,
	): Promise<void> {
		const snapshot = safeClone(this.store.get().data);
		optimisticUpdate();
		this.setState("syncing");
		try {
			const result = await serverSync();
			this.markSynced();
			onSuccess?.(result);
		} catch (e) {
			const error: DomainError = {
				code: "SYNC_FAILED",
				message: e instanceof Error ? e.message : "Unknown error",
				originalError: e,
				operation,
			};
			if (onError) {
				onError(error, snapshot);
			} else if (snapshot !== null) {
				// Default rollback: restore full snapshot (pre-1.1.0 behavior).
				this.setData(snapshot, false);
			}
			this.setError(error);
		}
	}

	abstract initialize(): Promise<void>;

	/**
	 * Reset to `initializing` state. Aborts any in-flight reads/mutations
	 * (their completions become no-ops once they observe `signal.aborted`),
	 * clears cached data, and emits `domain:state:changed`.
	 */
	reset(): void {
		this.abortAll("reset");
		const prev = this.store.get().state;
		this.store.set({
			state: "initializing",
			data: null,
			error: null,
			lastSyncedAt: null,
		});
		if (prev !== "initializing") {
			this.emit({
				type: "domain:state:changed",
				domain: this.domainName,
				timestamp: Date.now(),
				previousState: prev,
				newState: "initializing",
			});
		}
	}

	/**
	 * Dispose of this manager: abort in-flight ops, drop the adapter
	 * reference, and mark destroyed. Subsequent method calls are a best-
	 * effort no-op (they observe aborted controllers and return early).
	 *
	 * Note: the shared pubsub is NOT cleared — other consumers may still
	 * hold subscriptions against it. `Ownsuite.destroy()` owns that.
	 */
	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.abortAll("destroyed");
		this.adapter = null;
	}
}
