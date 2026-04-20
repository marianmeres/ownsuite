/**
 * @module domains/profile
 *
 * ProfileManager — a singleton (one-row) reactive container for the
 * authenticated subject's `/me` data: email, roles, verification flag,
 * whether the account has a password, and the list of linked OAuth
 * connections.
 *
 * Deliberately NOT an OwnedCollectionManager. The underlying `/me` endpoint
 * is a single-record resource: no list, no optimistic create/delete, and
 * update returns the full profile. Shoehorning it into the collection
 * manager would leak CRUD semantics that don't apply and complicate
 * ownership semantics.
 *
 * This manager mutates the companion `SessionManager`'s subject in place
 * when the profile changes (e.g. email edited) so consumers reading from
 * `suite.session` see the update without a second fetch.
 */

import { createStore, type StoreLike } from "@marianmeres/store";
import { createPubSub, type PubSub } from "@marianmeres/pubsub";
import type {
	OAuthConnection,
	OAuthProvider,
	OwnsuiteContext,
	ProfileAdapter,
	ProfileResult,
} from "../types/mod.ts";
import type { SessionManager } from "./session.ts";

/** Construction-time options for {@link ProfileManager}. Assembled by
 *  `createOwnsuite` when a profile adapter is supplied. */
export interface ProfileManagerOptions {
	/** Profile adapter — talks to `/me`. */
	adapter: ProfileAdapter;
	/** Session manager — used to patch the subject in place on fetch /
	 *  update so consumers reading the session see updates without a second
	 *  subscription. */
	session: SessionManager;
	/** Shared pubsub for event emission. Private if omitted. */
	pubsub?: PubSub;
	/** Initial context passed to adapter calls. Extended per-call with
	 *  `jwt` and `signal` by the manager. */
	context?: OwnsuiteContext;
}

/** Reactive state exposed by {@link ProfileManager.get} / `subscribe`. */
export interface ProfileState {
	/** Null until the first successful fetch. */
	profile: ProfileResult | null;
	/** True while a request is in flight. */
	loading: boolean;
	/** Most recent error, or null. Cleared on the next successful call. */
	error: Error | null;
}

const EMPTY: ProfileState = {
	profile: null,
	loading: false,
	error: null,
};

/**
 * Profile manager — singleton state for `/me`.
 */
export class ProfileManager {
	readonly #store: StoreLike<ProfileState>;
	readonly #pubsub: PubSub;
	readonly #adapter: ProfileAdapter;
	readonly #session: SessionManager;
	#context: OwnsuiteContext;

	/** Currently-active read controller, for abort-supersede semantics. */
	#readController: AbortController | null = null;

	/** Build a new profile manager. Normally called by `createOwnsuite`. */
	constructor(options: ProfileManagerOptions) {
		this.#adapter = options.adapter;
		this.#session = options.session;
		this.#pubsub = options.pubsub ?? createPubSub();
		this.#context = options.context ?? {};
		this.#store = createStore<ProfileState>({ ...EMPTY });
	}

	/** Svelte-compatible subscribe method over {@link ProfileState}. */
	get subscribe(): StoreLike<ProfileState>["subscribe"] {
		return this.#store.subscribe;
	}

	/** Current profile state snapshot. */
	get(): ProfileState {
		return this.#store.get();
	}

	/** Merge `ctx` into the adapter context (keys not present are kept). */
	setContext(ctx: OwnsuiteContext): void {
		this.#context = { ...this.#context, ...ctx };
	}

	/** Replace the adapter context wholesale. */
	replaceContext(ctx: OwnsuiteContext): void {
		this.#context = { ...ctx };
	}

	/** Build a per-op context with the current JWT from the session. */
	#ctxFor(signal: AbortSignal): OwnsuiteContext {
		const jwt = this.#session.getJwt();
		return {
			...this.#context,
			...(jwt ? { jwt } : {}),
			signal,
		};
	}

	#abortActiveRead(reason = "superseded"): void {
		if (this.#readController) {
			try {
				this.#readController.abort(reason);
			} catch {
				// ignore
			}
			this.#readController = null;
		}
	}

	/** Fetch `/me`. Supersedes any in-flight fetch. */
	async fetch(): Promise<ProfileResult> {
		this.#abortActiveRead();
		const ctrl = new AbortController();
		this.#readController = ctrl;

		this.#store.update((s) => ({ ...s, loading: true }));
		try {
			const profile = await this.#adapter.get(this.#ctxFor(ctrl.signal));
			if (ctrl.signal.aborted) {
				// A newer request already took over; don't overwrite its data.
				throw new Error("aborted");
			}
			this.#store.set({
				profile,
				loading: false,
				error: null,
			});
			// Keep the session's subject in sync with /me so consumers reading
			// from session don't need to also subscribe to profile.
			this.#session.patchSubject({
				email: profile.email,
				roles: profile.roles,
				isVerified: profile.isVerified,
				hasPassword: profile.hasPassword,
			});
			return profile;
		} catch (e) {
			if (!ctrl.signal.aborted) {
				const err = e instanceof Error ? e : new Error(String(e));
				this.#store.update((s) => ({ ...s, loading: false, error: err }));
			}
			throw e;
		} finally {
			if (this.#readController === ctrl) this.#readController = null;
		}
	}

	/** Update profile (currently: email). Triggers a re-verification email
	 *  server-side when the gate is on. Returns the refreshed profile. */
	async update(input: {
		email?: string;
		current_password?: string;
	}): Promise<ProfileResult> {
		const ctrl = new AbortController();
		this.#store.update((s) => ({ ...s, loading: true }));
		try {
			const profile = await this.#adapter.update(
				input,
				this.#ctxFor(ctrl.signal),
			);
			this.#store.set({ profile, loading: false, error: null });
			this.#session.patchSubject({
				email: profile.email,
				roles: profile.roles,
				isVerified: profile.isVerified,
				hasPassword: profile.hasPassword,
			});
			this.#pubsub.publish("profile:updated", {
				type: "profile:updated",
				timestamp: Date.now(),
				email: profile.email,
			});
			return profile;
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			this.#store.update((s) => ({ ...s, loading: false, error: err }));
			throw e;
		}
	}

	/** List OAuth provider connections linked to the authenticated account. */
	async listOAuth(): Promise<OAuthConnection[]> {
		const ctrl = new AbortController();
		return await this.#adapter.listOAuth(this.#ctxFor(ctrl.signal));
	}

	/** Unlink an OAuth provider. Emits `oauth:unlinked` and best-effort
	 *  re-fetches the profile so the connection list reflects the change. */
	async unlinkOAuth(provider: OAuthProvider): Promise<void> {
		const ctrl = new AbortController();
		await this.#adapter.unlinkOAuth(provider, this.#ctxFor(ctrl.signal));
		this.#pubsub.publish("oauth:unlinked", {
			type: "oauth:unlinked",
			timestamp: Date.now(),
			provider,
		});
		// Refresh so the profile reflects the new connection list.
		try {
			await this.fetch();
		} catch {
			// swallow — caller already got a successful unlink
		}
	}

	/** Abort any in-flight fetch and clear cached profile state. */
	reset(): void {
		this.#abortActiveRead("reset");
		this.#store.set({ ...EMPTY });
	}

	/** Tear down the manager — aborts in-flight fetches and clears state.
	 *  Called by `Ownsuite.destroy()`. */
	destroy(): void {
		this.#abortActiveRead("destroyed");
		this.#store.set({ ...EMPTY });
	}
}
