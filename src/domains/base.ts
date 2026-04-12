/**
 * @module domains/base
 *
 * Base domain manager. Provides reactive state, state-machine transitions,
 * optimistic update pattern, and event emission. Mirrors the shape of
 * `@marianmeres/ecsuite`'s `BaseDomainManager` so consumers already familiar
 * with ecsuite can read/subscribe to ownsuite domains identically.
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

	setAdapter(adapter: TAdapter): void {
		this.adapter = adapter;
	}

	getAdapter(): TAdapter | null {
		return this.adapter;
	}

	setContext(context: OwnsuiteContext): void {
		this.context = { ...this.context, ...context };
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
	 * Execute an async operation with the optimistic-update pattern:
	 *   1. capture current data for rollback
	 *   2. apply optimistic update immediately
	 *   3. flip to "syncing"
	 *   4. on success: mark synced, call onSuccess
	 *   5. on error: restore previous data, set error, call onError
	 */
	protected async withOptimisticUpdate<T>(
		operation: string,
		optimisticUpdate: () => void,
		serverSync: () => Promise<T>,
		onSuccess?: (result: T) => void,
		onError?: (error: DomainError) => void,
	): Promise<void> {
		const previousData = this.store.get().data;
		optimisticUpdate();
		this.setState("syncing");
		try {
			const result = await serverSync();
			this.markSynced();
			onSuccess?.(result);
		} catch (e) {
			if (previousData !== null) this.setData(previousData, false);
			const error: DomainError = {
				code: "SYNC_FAILED",
				message: e instanceof Error ? e.message : "Unknown error",
				originalError: e,
				operation,
			};
			this.setError(error);
			onError?.(error);
		}
	}

	abstract initialize(): Promise<void>;

	reset(): void {
		this.store.set({
			state: "initializing",
			data: null,
			error: null,
			lastSyncedAt: null,
		});
	}
}
