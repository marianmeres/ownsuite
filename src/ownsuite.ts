/**
 * @module ownsuite
 *
 * Ownsuite — orchestrator for owner-scoped domain managers.
 *
 * Unlike ecsuite (which hard-codes six e-commerce domains), ownsuite is
 * generic: consumers register arbitrary owner-scoped collection domains by
 * name. Each domain operates through an adapter that talks to a server
 * mount (conventionally `/me/<collection-path>`) with owner scoping
 * enforced by the server via `@marianmeres/collection`'s `ownerIdScope`
 * hook and `@marianmeres/stack-common`'s `ownsuiteOptions()` helper.
 */

import { type Clog, createClog } from "@marianmeres/clog";
import {
	createPubSub,
	type PubSub,
	type Subscriber,
	type Unsubscriber,
} from "@marianmeres/pubsub";
import type { DomainError, OwnsuiteContext } from "./types/state.ts";
import type { OwnedCollectionAdapter } from "./types/adapter.ts";
import type { OwnsuiteEventType } from "./types/events.ts";
import { OwnedCollectionManager } from "./domains/owned-collection.ts";

/**
 * Configuration for a single domain at construction time. The caller
 * provides a unique name and an adapter. A custom `getRowId` is optional
 * (defaults to reading `row.model_id` or `row.id`).
 */
// deno-lint-ignore no-explicit-any
export interface OwnsuiteDomainConfig<TRow = any, TCreate = any, TUpdate = any> {
	adapter: OwnedCollectionAdapter<TRow, TCreate, TUpdate>;
	getRowId?: (row: TRow) => string;
}

/** Top-level ownsuite configuration. */
export interface OwnsuiteConfig {
	/** Initial context passed to every adapter call. */
	context?: OwnsuiteContext;
	/** Domain registry. Keys are domain names (arbitrary labels). */
	domains?: Record<string, OwnsuiteDomainConfig>;
	/** Auto-initialize all registered domains on creation (default: false). */
	autoInitialize?: boolean;
}

/** Options for {@link Ownsuite.setContext}. */
export interface SetContextOptions {
	/** If true, replace the context entirely instead of merging. Default: false (merge). */
	replace?: boolean;
	/** If true, fire `refresh()` on every domain after the context change. Default: false. */
	refresh?: boolean;
}

/**
 * Main Ownsuite class — coordinates owner-scoped domain managers.
 *
 * @example
 * ```typescript
 * const suite = createOwnsuite({
 *   context: { subjectId: "user-123" },
 *   domains: {
 *     orders: { adapter: myOrdersAdapter },
 *     addresses: { adapter: myAddressesAdapter },
 *   },
 * });
 * await suite.initialize(); // or pass autoInitialize: true
 *
 * suite.domain("orders").subscribe((s) => console.log(s.state, s.data?.rows));
 * await suite.domain("orders").create({ data: { ... } });
 * ```
 */
export class Ownsuite {
	readonly #clog: Clog = createClog("ownsuite", { color: "auto" });
	readonly #pubsub: PubSub;
	#context: OwnsuiteContext;
	// deno-lint-ignore no-explicit-any
	readonly #domains = new Map<string, OwnedCollectionManager<any, any, any>>();
	#destroyed = false;

	constructor(config: OwnsuiteConfig = {}) {
		this.#pubsub = createPubSub();
		this.#context = { ...(config.context ?? {}) };

		for (const [name, cfg] of Object.entries(config.domains ?? {})) {
			this.registerDomain(name, cfg);
		}

		if (config.autoInitialize) {
			// `initialize()` is non-rejecting by contract; per-domain errors
			// land in that domain's error state. See `hasErrors()` / `errors()`
			// to detect them after boot.
			void this.initialize();
		}
	}

	/** True after `destroy()` has been called. */
	get isDestroyed(): boolean {
		return this.#destroyed;
	}

	/** Register a new domain after construction. */
	// deno-lint-ignore no-explicit-any
	registerDomain<TRow = any, TCreate = any, TUpdate = any>(
		name: string,
		cfg: OwnsuiteDomainConfig<TRow, TCreate, TUpdate>,
	): OwnedCollectionManager<TRow, TCreate, TUpdate> {
		if (this.#destroyed) {
			throw new Error("Ownsuite: cannot register on a destroyed suite");
		}
		if (this.#domains.has(name)) {
			throw new Error(`Ownsuite: domain "${name}" already registered`);
		}
		const manager = new OwnedCollectionManager<TRow, TCreate, TUpdate>(name, {
			adapter: cfg.adapter,
			getRowId: cfg.getRowId,
			context: this.#context,
			pubsub: this.#pubsub,
		});
		this.#domains.set(name, manager);
		return manager;
	}

	/** Look up a domain manager by name. Throws if unknown. */
	// deno-lint-ignore no-explicit-any
	domain<TRow = any, TCreate = any, TUpdate = any>(
		name: string,
	): OwnedCollectionManager<TRow, TCreate, TUpdate> {
		const m = this.#domains.get(name);
		if (!m) throw new Error(`Ownsuite: unknown domain "${name}"`);
		return m as OwnedCollectionManager<TRow, TCreate, TUpdate>;
	}

	/** True if a domain by this name is registered. */
	hasDomain(name: string): boolean {
		return this.#domains.has(name);
	}

	/** List registered domain names. */
	domainNames(): string[] {
		return [...this.#domains.keys()];
	}

	/**
	 * Initialize all registered domains (or a subset). Runs in parallel.
	 * Individual domain errors land in that domain's error state — they
	 * do not reject the overall promise. Use `hasErrors()` / `errors()` to
	 * inspect the result. Unknown domain names in `names` are logged and
	 * skipped.
	 */
	async initialize(names?: string[]): Promise<void> {
		if (this.#destroyed) return;
		const targets = names ?? this.domainNames();
		await Promise.all(
			targets.map((n) => {
				const m = this.#domains.get(n);
				if (!m) {
					this.#clog.warn(`initialize: unknown domain "${n}", skipping`);
					return Promise.resolve();
				}
				return m.initialize();
			}),
		);
	}

	/**
	 * Update shared context and propagate to every domain manager.
	 *
	 * - `options.replace: true` — replace the context wholesale (no merge).
	 * - `options.refresh: true` — fire-and-forget `refresh()` on every
	 *   domain after the context change (so stale per-subject caches don't
	 *   linger when, e.g., `subjectId` changes).
	 */
	setContext(ctx: OwnsuiteContext, options: SetContextOptions = {}): void {
		if (this.#destroyed) return;
		this.#context = options.replace
			? { ...ctx }
			: { ...this.#context, ...ctx };
		for (const m of this.#domains.values()) {
			if (options.replace) m.replaceContext(this.#context);
			else m.setContext(this.#context);
		}
		if (options.refresh) {
			for (const m of this.#domains.values()) {
				// Fire-and-forget. refresh() is non-rejecting (lands in error state
				// on failure), but we defensively swallow anything unexpected.
				void m.refresh().catch((e) =>
					this.#clog.error("setContext: refresh failed", e)
				);
			}
		}
	}

	getContext(): OwnsuiteContext {
		return { ...this.#context };
	}

	/** Subscribe to a specific event type. */
	on(type: OwnsuiteEventType, subscriber: Subscriber): Unsubscriber {
		return this.#pubsub.subscribe(type, subscriber);
	}

	/**
	 * Subscribe to all events. Wildcard subscribers receive an envelope
	 * `{ event: string, data: OwnsuiteEvent }` — see `@marianmeres/pubsub`.
	 */
	onAny(subscriber: Subscriber): Unsubscriber {
		return this.#pubsub.subscribe("*", subscriber);
	}

	/** Map of currently-errored domains to their error, empty if none. */
	errors(): Record<string, DomainError> {
		const out: Record<string, DomainError> = {};
		for (const [name, m] of this.#domains) {
			const s = m.get();
			if (s.state === "error" && s.error) out[name] = s.error;
		}
		return out;
	}

	/** True if any domain is currently in `error` state. */
	hasErrors(): boolean {
		for (const m of this.#domains.values()) {
			if (m.get().state === "error") return true;
		}
		return false;
	}

	/** Reset all domains to initializing state. Aborts in-flight ops. */
	reset(): void {
		for (const m of this.#domains.values()) m.reset();
	}

	/**
	 * Dispose of the suite: destroys every registered domain (aborting
	 * in-flight requests), drops the domain map, and unsubscribes every
	 * listener this suite owns on its pubsub. Safe to call multiple times.
	 *
	 * Note: if the pubsub was constructed internally (the default), all
	 * subscribers are unsubscribed. If consumers passed an external pubsub
	 * to managers directly, that shared pubsub is not cleared — they own it.
	 */
	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const m of this.#domains.values()) m.destroy();
		this.#domains.clear();
		// Our internal pubsub: clear all subscribers. Best-effort — if a custom
		// pubsub implementation doesn't expose `unsubscribeAll`, skip it.
		const ps = this.#pubsub as unknown as { unsubscribeAll?: () => void };
		ps.unsubscribeAll?.();
	}
}

/** Convenience factory matching the ecsuite `createECSuite` convention. */
export function createOwnsuite(config: OwnsuiteConfig = {}): Ownsuite {
	return new Ownsuite(config);
}
