/**
 * @module domains/session
 *
 * SessionManager — source of truth for the JWT and the authenticated subject.
 *
 * This is NOT an `OwnedCollectionManager` — there's no list-of-rows and no
 * remote adapter. The session is a single reactive record, persisted via a
 * pluggable `SessionStorage`, that drives every other manager (its JWT and
 * subjectId end up on `OwnsuiteContext`).
 *
 * Consumers subscribe directly (`suite.session.subscribe(fn)`) or read the
 * current snapshot (`suite.session.get()`). Writes go through the high-
 * level `AuthManager` methods (`login`, `logout`, etc.) which call into
 * this manager.
 */

import { createStore, type StoreLike } from "@marianmeres/store";
import { createPubSub, type PubSub } from "@marianmeres/pubsub";
import type {
	SessionState,
	SessionStorage,
	SessionStorageType,
	SessionSubject,
} from "../types/auth.ts";

const DEFAULT_STORAGE_KEY = "ownsuite:session";

const EMPTY: SessionState = {
	status: "anonymous",
	subject: null,
	jwt: null,
	expiresAt: null,
};

/** In-memory session storage — survives the current JS realm only. */
export function createMemorySessionStorage(): SessionStorage {
	const map = new Map<string, string>();
	return {
		get(k) {
			return map.has(k) ? map.get(k)! : null;
		},
		set(k, v) {
			map.set(k, v);
		},
		del(k) {
			map.delete(k);
		},
	};
}

/** Resolve a `SessionStorageType` union to a concrete `SessionStorage`.
 *  Gracefully falls back to memory storage when running in an environment
 *  without Web Storage (SSR, worker without storage, etc). */
export function resolveSessionStorage(
	type: SessionStorageType = "local",
): SessionStorage {
	if (typeof type === "object" && type !== null) return type;
	if (type === "memory") return createMemorySessionStorage();
	const backend: "localStorage" | "sessionStorage" = type === "session"
		? "sessionStorage"
		: "localStorage";
	const g = (globalThis as unknown as Record<string, Storage | undefined>);
	const store = g[backend];
	if (!store) return createMemorySessionStorage();
	return {
		get(k) {
			try {
				return store.getItem(k);
			} catch {
				return null;
			}
		},
		set(k, v) {
			try {
				store.setItem(k, v);
			} catch {
				// quota exceeded / disabled — degrade silently
			}
		},
		del(k) {
			try {
				store.removeItem(k);
			} catch {
				// ignore
			}
		},
	};
}

export interface SessionManagerOptions {
	/** Storage backend for session persistence. Default: "local". */
	storage?: SessionStorageType;
	/** Key used in the storage backend. Default: "ownsuite:session". */
	storageKey?: string;
	/** Shared pubsub for event emission. When omitted, a private one is
	 *  created — useful for standalone testing of the manager. */
	pubsub?: PubSub;
}

/**
 * Session manager — pure reactive state + persistence, no HTTP.
 *
 * Writes are driven by the AuthManager. On construction it hydrates from
 * storage; if the stored JWT has expired, it transitions to anonymous and
 * clears the storage.
 */
export class SessionManager {
	readonly #store: StoreLike<SessionState>;
	readonly #pubsub: PubSub;
	readonly #storage: SessionStorage;
	readonly #storageKey: string;

	constructor(options: SessionManagerOptions = {}) {
		this.#pubsub = options.pubsub ?? createPubSub();
		this.#storage = resolveSessionStorage(options.storage ?? "local");
		this.#storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
		this.#store = createStore<SessionState>({ ...EMPTY });
		this.#hydrate();
	}

	/** Read from storage and populate the store. Expired sessions are wiped. */
	#hydrate(): void {
		const raw = this.#storage.get(this.#storageKey);
		if (!raw) return;
		try {
			const parsed = JSON.parse(raw) as SessionState;
			// Basic shape check.
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				typeof parsed.status !== "string"
			) {
				this.#storage.del(this.#storageKey);
				return;
			}
			// Expiry check (only meaningful when expiresAt is set).
			if (
				parsed.expiresAt !== null &&
				parsed.expiresAt !== undefined &&
				parsed.expiresAt * 1000 <= Date.now()
			) {
				this.#storage.del(this.#storageKey);
				return;
			}
			this.#store.set(parsed);
		} catch {
			this.#storage.del(this.#storageKey);
		}
	}

	#persist(): void {
		const s = this.#store.get();
		if (s.status === "anonymous") {
			this.#storage.del(this.#storageKey);
		} else {
			this.#storage.set(this.#storageKey, JSON.stringify(s));
		}
	}

	#emitChange(): void {
		this.#pubsub.publish("auth:session:changed", {
			type: "auth:session:changed",
			timestamp: Date.now(),
			session: this.#store.get(),
		});
	}

	/** Svelte-compatible subscribe. */
	get subscribe(): StoreLike<SessionState>["subscribe"] {
		return this.#store.subscribe;
	}

	/** Current session state snapshot. */
	get(): SessionState {
		return this.#store.get();
	}

	get isAuthenticated(): boolean {
		return this.#store.get().status === "authenticated";
	}

	get isUnverified(): boolean {
		return this.#store.get().status === "unverified";
	}

	get isAnonymous(): boolean {
		return this.#store.get().status === "anonymous";
	}

	/** JWT for adapter `Authorization` headers, or null when anonymous. */
	getJwt(): string | null {
		return this.#store.get().jwt;
	}

	/** Transition to authenticated. Called after login/register/OAuth succeed
	 *  and the subject has been loaded. */
	setAuthenticated(opts: {
		jwt: string;
		subject: SessionSubject;
		expiresAt?: number | null;
	}): void {
		const { jwt, subject, expiresAt = null } = opts;
		this.#store.set({
			status: "authenticated",
			subject,
			jwt,
			expiresAt,
		});
		this.#persist();
		this.#emitChange();
	}

	/** Server confirmed credentials but refuses login until email is
	 *  verified. Expose the email so the UI can prompt "check your inbox"
	 *  without a second server call. No JWT in this state. */
	setUnverified(email: string): void {
		this.#store.set({
			status: "unverified",
			subject: {
				id: "",
				email,
				roles: [],
				isVerified: false,
				hasPassword: false,
			},
			jwt: null,
			expiresAt: null,
		});
		this.#persist();
		this.#emitChange();
	}

	/** Drop the session. Storage is cleared; downstream domains should be
	 *  reset by the suite orchestrator. */
	clear(): void {
		if (this.#store.get().status === "anonymous") return;
		this.#store.set({ ...EMPTY });
		this.#persist();
		this.#emitChange();
	}

	/** Patch the subject in place without touching the JWT. Used when the
	 *  profile manager changes email / linked providers / etc. */
	patchSubject(patch: Partial<SessionSubject>): void {
		const s = this.#store.get();
		if (!s.subject) return;
		const next: SessionState = {
			...s,
			subject: { ...s.subject, ...patch },
		};
		this.#store.set(next);
		this.#persist();
		this.#emitChange();
	}

	/** Test / reset hook — clears storage AND in-memory state without
	 *  emitting. Used by teardown. */
	destroy(): void {
		this.#storage.del(this.#storageKey);
		this.#store.set({ ...EMPTY });
	}
}
