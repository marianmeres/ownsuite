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
import type { OwnsuiteContext } from "./types/state.ts";
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

	constructor(config: OwnsuiteConfig = {}) {
		this.#pubsub = createPubSub();
		this.#context = { ...(config.context ?? {}) };

		for (const [name, cfg] of Object.entries(config.domains ?? {})) {
			this.registerDomain(name, cfg);
		}

		if (config.autoInitialize) {
			// fire-and-forget; consumers who care should await initialize() explicitly
			this.initialize().catch((e) => this.#clog.error("autoInitialize", e));
		}
	}

	/** Register a new domain after construction. */
	// deno-lint-ignore no-explicit-any
	registerDomain<TRow = any, TCreate = any, TUpdate = any>(
		name: string,
		cfg: OwnsuiteDomainConfig<TRow, TCreate, TUpdate>,
	): OwnedCollectionManager<TRow, TCreate, TUpdate> {
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
	 * do not reject the overall promise.
	 */
	async initialize(names?: string[]): Promise<void> {
		const targets = names ?? this.domainNames();
		await Promise.all(
			targets.map((n) => this.#domains.get(n)?.initialize() ?? Promise.resolve()),
		);
	}

	/** Update shared context and propagate to all domain managers. */
	setContext(ctx: OwnsuiteContext): void {
		this.#context = { ...this.#context, ...ctx };
		for (const m of this.#domains.values()) m.setContext(this.#context);
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

	/** Reset all domains to initializing state. */
	reset(): void {
		for (const m of this.#domains.values()) m.reset();
	}
}

/** Convenience factory matching the ecsuite `createECSuite` convention. */
export function createOwnsuite(config: OwnsuiteConfig = {}): Ownsuite {
	return new Ownsuite(config);
}
