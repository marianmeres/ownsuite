/**
 * @module domains/auth
 *
 * AuthManager — verbs for the account lifecycle. Holds no state of its own:
 *   - credentials flow through to the adapter,
 *   - server responses are piped into the SessionManager,
 *   - successful session changes trigger a refresh of owner-scoped domains
 *     via a caller-supplied `switchIdentity` hook.
 *
 * Non-goals (explicit): password strength UI, form validation, rendering,
 * i18n strings, CSRF/PKCE (server-side), refresh-token rotation, cookie
 * management.
 */

import { createPubSub, type PubSub } from "@marianmeres/pubsub";
import type {
	AuthActionOptions,
	AuthAdapter,
	AuthTokenResult,
	OAuthInitOptions,
	OAuthProvider,
	OwnsuiteContext,
	ProfileAdapter,
	SessionStorageType,
	SessionSubject,
} from "../types/mod.ts";
import { openOAuthPopup } from "../oauth/popup.ts";
import type { SessionManager } from "./session.ts";
import type { ProfileManager } from "./profile.ts";

/** Construction-time options for {@link AuthManager}. Normally assembled
 *  by `createOwnsuite` — call sites rarely instantiate this directly. */
export interface AuthManagerOptions {
	/** Server adapter. The manager is stateless beyond what it pushes into
	 *  {@link SessionManager}. */
	adapter: AuthAdapter;
	/** Session manager that receives the JWT / subject / status writes. */
	session: SessionManager;
	/** Profile manager — auth hydrates the session subject from `/me`
	 *  immediately after login so subscribers see roles/isVerified/etc.
	 *  without a second await. */
	profile: ProfileManager;
	/** Shared pubsub for event emission. Created privately when omitted. */
	pubsub?: PubSub;
	/** Called after a successful identity change (register/login/OAuth
	 *  login/logout). The orchestrator wires this to reset + re-init every
	 *  owner-scoped domain with the fresh context. */
	onIdentityChanged?: (ctx: OwnsuiteContext) => Promise<void> | void;
	/** Also passed into adapter calls (correlation id, feature flags, etc.).
	 *  The JWT + signal are added per-op by the manager. */
	context?: OwnsuiteContext;
	/** When the adapter provides a profile adapter explicitly, we pass it
	 *  through to resolving the subject. Kept optional for mock-driven
	 *  tests that don't need a separate profile fetch. */
	profileAdapter?: ProfileAdapter;
}

/**
 * Verbs for the account lifecycle: register / login / logout / OAuth /
 * password-reset / delete account. Holds no state of its own — every
 * outcome is piped into the linked {@link SessionManager}, which is the
 * single source of truth for JWT + subject + status. Usually accessed via
 * `suite.auth`, not constructed directly.
 */
export class AuthManager {
	readonly #pubsub: PubSub;
	readonly #adapter: AuthAdapter;
	readonly #session: SessionManager;
	readonly #profile: ProfileManager;
	readonly #onIdentityChanged?: (
		ctx: OwnsuiteContext,
	) => Promise<void> | void;
	#context: OwnsuiteContext;

	/** Construct a new `AuthManager`. Normally called by `createOwnsuite`,
	 *  not by consumers. */
	constructor(options: AuthManagerOptions) {
		this.#adapter = options.adapter;
		this.#session = options.session;
		this.#profile = options.profile;
		this.#pubsub = options.pubsub ?? createPubSub();
		this.#onIdentityChanged = options.onIdentityChanged;
		this.#context = options.context ?? {};
	}

	/** Merge `ctx` into the current adapter context. Keys not in `ctx`
	 *  are preserved. */
	setContext(ctx: OwnsuiteContext): void {
		this.#context = { ...this.#context, ...ctx };
	}

	/** Replace the adapter context wholesale. Callers use this when
	 *  switching subjects or clearing host-app context. */
	replaceContext(ctx: OwnsuiteContext): void {
		this.#context = { ...ctx };
	}

	#ctx(signal?: AbortSignal): OwnsuiteContext {
		const jwt = this.#session.getJwt();
		return {
			...this.#context,
			...(jwt ? { jwt } : {}),
			...(signal ? { signal } : {}),
		};
	}

	/** Flip the session state based on an AuthTokenResult. When the JWT is
	 *  present, we pull the profile to build a complete subject. When the
	 *  server returned requiresVerification, we surface the "unverified"
	 *  status without any profile fetch. Triggers identity-change hook on
	 *  actual login.
	 *
	 *  `remember` translates to a per-login storage pin on the session:
	 *  `true` → `"local"`, `false` → `"session"`, `undefined` → session
	 *  manager's configured default. Silently no-op in the verification-gate
	 *  branch (no JWT yet → nothing to persist). */
	async #applyAuthResult(
		result: AuthTokenResult,
		remember?: boolean,
	): Promise<AuthTokenResult> {
		if (result.requiresVerification || !result.jwt) {
			this.#session.setUnverified(result.email);
			this.#pubsub.publish("auth:verification:required", {
				type: "auth:verification:required",
				timestamp: Date.now(),
				email: result.email,
			});
			return result;
		}

		// Set a provisional subject so subsequent calls (including the profile
		// fetch itself) see the JWT on the session.
		const provisional: SessionSubject = {
			id: "",
			email: result.email,
			roles: result.roles ?? [],
			isVerified: result.isVerified ?? false,
			hasPassword: true, // corrected by profile fetch below
		};
		const storage: SessionStorageType | undefined = remember === true
			? "local"
			: remember === false
			? "session"
			: undefined;
		this.#session.setAuthenticated({
			jwt: result.jwt,
			subject: provisional,
			expiresAt: result.validUntil ?? null,
			...(storage ? { storage } : {}),
		});

		// Best-effort hydrate the subject from /me. If this fails we keep the
		// provisional subject; consumers can retry via profile.fetch().
		try {
			await this.#profile.fetch();
		} catch {
			// swallow — session stays authenticated with the provisional subject
		}

		if (this.#onIdentityChanged) {
			try {
				await this.#onIdentityChanged(this.#ctx());
			} catch {
				// swallow — hook errors must not destabilize auth state
			}
		}

		return result;
	}

	// ─────────────────────── verbs ──────────────────────────────────────────

	/** Create a new account. Returns the server's {@link AuthTokenResult}.
	 *  When the verification gate is on, the result carries
	 *  `requiresVerification: true` and the session flips to `"unverified"`
	 *  (no JWT). Otherwise the session flips to `"authenticated"` and the
	 *  profile is hydrated from `/me`. `options.remember` pins the session's
	 *  storage backend — see {@link AuthActionOptions.remember}. */
	async register(
		input: {
			email: string;
			password: string;
			password_confirm: string;
			roles?: string[];
			extras?: Record<string, unknown>;
		},
		options?: AuthActionOptions,
	): Promise<AuthTokenResult> {
		const result = await this.#adapter.register(input, this.#ctx());
		this.#pubsub.publish("auth:register", {
			type: "auth:register",
			timestamp: Date.now(),
			email: input.email,
			requiresVerification: Boolean(result.requiresVerification),
		});
		return await this.#applyAuthResult(result, options?.remember);
	}

	/** Exchange credentials for a JWT. On success the session flips to
	 *  `"authenticated"` and the profile is hydrated from `/me`. Rejects
	 *  on bad credentials (session untouched) or — when the server's
	 *  verification gate is on for an unverified account — throws through
	 *  the adapter. `options.remember` controls storage persistence. */
	async login(
		input: {
			email: string;
			password: string;
		},
		options?: AuthActionOptions,
	): Promise<AuthTokenResult> {
		const result = await this.#adapter.login(input, this.#ctx());
		this.#pubsub.publish("auth:login", {
			type: "auth:login",
			timestamp: Date.now(),
			email: input.email,
		});
		return await this.#applyAuthResult(result, options?.remember);
	}

	/** Log out. Best-effort server revoke + unconditional local clear;
	 *  the session is always wiped even if the server call fails. Fires
	 *  `auth:logout` and the `onIdentityChanged` hook. Safe to call when
	 *  already anonymous. */
	async logout(): Promise<void> {
		const subjectId = this.#session.get().subject?.id;
		try {
			await this.#adapter.logout(this.#ctx());
		} catch {
			// server logout is best-effort — still clear locally
		}
		this.#session.clear();
		this.#pubsub.publish("auth:logout", {
			type: "auth:logout",
			timestamp: Date.now(),
			subjectId,
		});
		if (this.#onIdentityChanged) {
			try {
				await this.#onIdentityChanged(this.#ctx());
			} catch {
				// swallow
			}
		}
	}

	/** Trigger a fresh verification email. Anti-enumeration: always resolves
	 *  regardless of whether the address corresponds to a real account. */
	async resendVerification(input: {
		email: string;
		lang?: string;
	}): Promise<void> {
		await this.#adapter.resendVerification(input, this.#ctx());
	}

	/** Trigger a password-reset email. Anti-enumeration: always resolves. */
	async requestPasswordReset(input: {
		email: string;
		lang?: string;
	}): Promise<void> {
		await this.#adapter.requestPasswordReset(input, this.#ctx());
	}

	/** Change the password. Pass `current_password` for an authenticated
	 *  self-change, or `token` for a reset-link flow. `new_password` and
	 *  `confirm_password` are always required. */
	async changePassword(input: {
		current_password?: string;
		new_password: string;
		confirm_password: string;
		token?: string;
	}): Promise<void> {
		await this.#adapter.changePassword(input, this.#ctx());
	}

	/** Irreversibly delete the authenticated account. On success clears the
	 *  local session and fires `auth:logout` + `onIdentityChanged`. */
	async deleteAccount(input: {
		password?: string;
		confirm?: boolean;
	}): Promise<void> {
		await this.#adapter.deleteAccount(input, this.#ctx());
		// Clear session locally and fire logout/identity-change.
		this.#session.clear();
		this.#pubsub.publish("auth:logout", {
			type: "auth:logout",
			timestamp: Date.now(),
		});
		if (this.#onIdentityChanged) {
			try {
				await this.#onIdentityChanged(this.#ctx());
			} catch {
				// swallow
			}
		}
	}

	/**
	 * Begin an OAuth flow. Returns:
	 *   - For popup mode: a Promise that resolves when the popup posts back
	 *     an auth result.
	 *   - For redirect mode: nothing useful; the top window navigates away.
	 */
	async initiateOAuth(
		provider: OAuthProvider,
		opts: OAuthInitOptions,
	): Promise<AuthTokenResult | void> {
		const url = this.#adapter.oauthInitUrl(provider, opts, this.#ctx());
		const mode = opts.mode ?? "popup";

		if (mode === "redirect") {
			if (typeof globalThis !== "undefined" && "location" in globalThis) {
				(globalThis as { location: Location }).location.href = url;
			}
			return;
		}

		// popup mode — wait for postMessage.
		const message = await openOAuthPopup(url);
		if (message.type === "oauth_link_success") {
			this.#pubsub.publish("oauth:linked", {
				type: "oauth:linked",
				timestamp: Date.now(),
				connection: { provider },
			});
			// Refresh profile so the new connection appears.
			try {
				await this.#profile.fetch();
			} catch {
				// swallow
			}
			return;
		}
		// login result
		const result: AuthTokenResult = {
			jwt: message.jwt,
			email: message.email,
			roles: message.roles ?? [],
			isVerified: true,
		};
		return await this.#applyAuthResult(result, opts.remember);
	}

	/** For the redirect-mode callback page: delegate to the adapter if
	 *  available to extract the result from the current URL/page state.
	 *  `options.remember` pins the resulting session to local/session
	 *  storage — pass the same value the user picked before the redirect. */
	async handleOAuthCallback(
		options?: AuthActionOptions,
	): Promise<AuthTokenResult | void> {
		if (!this.#adapter.handleOAuthCallback) {
			throw new Error(
				"AuthManager: handleOAuthCallback is not implemented by the adapter",
			);
		}
		const result = await this.#adapter.handleOAuthCallback(this.#ctx());
		return await this.#applyAuthResult(result, options?.remember);
	}
}
