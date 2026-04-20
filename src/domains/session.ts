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

type BuiltInStorageType = "local" | "session" | "memory";
const BUILT_IN_ORDER: readonly BuiltInStorageType[] = [
	"local",
	"session",
	"memory",
];

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
 * Writes are driven by the AuthManager. On construction it hydrates by
 * probing the built-in backends in order `local → session → memory` and
 * adopting whichever holds a non-expired payload as the active backend for
 * the rest of the instance's lifetime (until `clear()`). Stale blobs on the
 * other built-in backends are wiped on adoption.
 *
 * When constructed with a custom `SessionStorage` object, there is a single
 * backend and per-login `remember` choices are silently ignored.
 */
export class SessionManager {
	readonly #store: StoreLike<SessionState>;
	readonly #pubsub: PubSub;
	readonly #storageKey: string;
	/** Set only when the consumer passed a `SessionStorage` object at
	 *  construction — then there is one backend and no toggling. */
	readonly #customStorage: SessionStorage | null;
	/** Resolved eagerly in the string-storage case so `clear()` can wipe
	 *  every backend and per-login overrides can switch between them. */
	readonly #builtIn: Record<BuiltInStorageType, SessionStorage> | null;
	readonly #defaultStorageType: BuiltInStorageType;
	#activeStorage: SessionStorage;
	#activeStorageType: BuiltInStorageType | "custom";

	constructor(options: SessionManagerOptions = {}) {
		this.#pubsub = options.pubsub ?? createPubSub();
		this.#storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
		this.#store = createStore<SessionState>({ ...EMPTY });

		const configured = options.storage ?? "local";
		if (typeof configured === "object" && configured !== null) {
			this.#customStorage = configured;
			this.#builtIn = null;
			this.#defaultStorageType = "local";
			this.#activeStorage = configured;
			this.#activeStorageType = "custom";
		} else {
			this.#customStorage = null;
			this.#builtIn = {
				local: resolveSessionStorage("local"),
				session: resolveSessionStorage("session"),
				memory: createMemorySessionStorage(),
			};
			this.#defaultStorageType = configured;
			this.#activeStorage = this.#builtIn[configured];
			this.#activeStorageType = configured;
		}

		this.#hydrate();
	}

	/** Try to parse a payload and validate shape + expiry. Returns the state
	 *  on success, or `null` (and deletes the stored blob) on any failure. */
	#readCandidate(storage: SessionStorage): SessionState | null {
		const raw = storage.get(this.#storageKey);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as SessionState;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				typeof parsed.status !== "string"
			) {
				storage.del(this.#storageKey);
				return null;
			}
			if (
				parsed.expiresAt !== null &&
				parsed.expiresAt !== undefined &&
				parsed.expiresAt * 1000 <= Date.now()
			) {
				storage.del(this.#storageKey);
				return null;
			}
			return parsed;
		} catch {
			storage.del(this.#storageKey);
			return null;
		}
	}

	/** Read from storage and populate the store. Expired sessions are wiped.
	 *  In the built-in case, probes `local → session → memory` and wipes
	 *  the losing backends so stale blobs can't leak back in. */
	#hydrate(): void {
		if (this.#customStorage) {
			const parsed = this.#readCandidate(this.#customStorage);
			if (parsed) this.#store.set(parsed);
			return;
		}

		const builtIn = this.#builtIn!;
		for (const type of BUILT_IN_ORDER) {
			const parsed = this.#readCandidate(builtIn[type]);
			if (!parsed) continue;
			// Adopt this backend; wipe the others so a later login-with-toggle
			// can't accidentally re-hydrate a stale blob.
			for (const other of BUILT_IN_ORDER) {
				if (other !== type) builtIn[other].del(this.#storageKey);
			}
			this.#activeStorage = builtIn[type];
			this.#activeStorageType = type;
			this.#store.set(parsed);
			return;
		}
	}

	#persist(): void {
		const s = this.#store.get();
		if (s.status === "anonymous") {
			this.#activeStorage.del(this.#storageKey);
		} else {
			this.#activeStorage.set(this.#storageKey, JSON.stringify(s));
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
	 *  and the subject has been loaded.
	 *
	 *  When `opts.storage` is one of `"local"` / `"session"` / `"memory"`,
	 *  pins this session to that built-in backend; subsequent
	 *  `patchSubject` / `setUnverified` writes land on the same backend.
	 *  The previously-active backend's blob is wiped as part of the switch
	 *  so "Remember me" toggles don't leave stale data behind.
	 *
	 *  Ignored when the manager was constructed with a custom `SessionStorage`
	 *  object (single backend) or when `opts.storage` is itself an object
	 *  (no multi-backend custom storage by design). */
	setAuthenticated(opts: {
		jwt: string;
		subject: SessionSubject;
		expiresAt?: number | null;
		storage?: SessionStorageType;
	}): void {
		const { jwt, subject, expiresAt = null, storage } = opts;
		if (
			storage !== undefined &&
			typeof storage === "string" &&
			this.#builtIn
		) {
			const target = storage as BuiltInStorageType;
			if (this.#activeStorage !== this.#builtIn[target]) {
				this.#activeStorage.del(this.#storageKey);
				this.#activeStorage = this.#builtIn[target];
				this.#activeStorageType = target;
			}
		}
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

	/** Drop the session. Every built-in backend (local + session + memory)
	 *  is wiped — not just the active one — so stale blobs from a previous
	 *  "Remember me" toggle can't leak back in on the next construction.
	 *  Resets the active backend to the manager's configured default.
	 *  Downstream domains should be reset by the suite orchestrator. */
	clear(): void {
		this.#wipeAllBackends();
		if (this.#builtIn) {
			this.#activeStorage = this.#builtIn[this.#defaultStorageType];
			this.#activeStorageType = this.#defaultStorageType;
		}
		if (this.#store.get().status === "anonymous") return;
		this.#store.set({ ...EMPTY });
		this.#emitChange();
	}

	#wipeAllBackends(): void {
		if (this.#customStorage) {
			this.#customStorage.del(this.#storageKey);
			return;
		}
		const builtIn = this.#builtIn!;
		for (const type of BUILT_IN_ORDER) {
			builtIn[type].del(this.#storageKey);
		}
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

	/** Test / reset hook — clears every backend AND in-memory state without
	 *  emitting. Used by teardown. */
	destroy(): void {
		this.#wipeAllBackends();
		this.#store.set({ ...EMPTY });
	}
}
