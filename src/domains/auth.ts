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
	AuthAdapter,
	AuthTokenResult,
	OAuthInitOptions,
	OAuthProvider,
	OwnsuiteContext,
	ProfileAdapter,
	SessionSubject,
} from "../types/mod.ts";
import { openOAuthPopup } from "../oauth/popup.ts";
import type { SessionManager } from "./session.ts";
import type { ProfileManager } from "./profile.ts";

export interface AuthManagerOptions {
	adapter: AuthAdapter;
	session: SessionManager;
	/** Profile manager — auth hydrates the session subject from `/me`
	 *  immediately after login so subscribers see roles/isVerified/etc.
	 *  without a second await. */
	profile: ProfileManager;
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

export class AuthManager {
	readonly #pubsub: PubSub;
	readonly #adapter: AuthAdapter;
	readonly #session: SessionManager;
	readonly #profile: ProfileManager;
	readonly #onIdentityChanged?: (
		ctx: OwnsuiteContext,
	) => Promise<void> | void;
	#context: OwnsuiteContext;

	constructor(options: AuthManagerOptions) {
		this.#adapter = options.adapter;
		this.#session = options.session;
		this.#profile = options.profile;
		this.#pubsub = options.pubsub ?? createPubSub();
		this.#onIdentityChanged = options.onIdentityChanged;
		this.#context = options.context ?? {};
	}

	setContext(ctx: OwnsuiteContext): void {
		this.#context = { ...this.#context, ...ctx };
	}

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
	 *  actual login. */
	async #applyAuthResult(result: AuthTokenResult): Promise<AuthTokenResult> {
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
		this.#session.setAuthenticated({
			jwt: result.jwt,
			subject: provisional,
			expiresAt: result.validUntil ?? null,
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

	async register(input: {
		email: string;
		password: string;
		password_confirm: string;
		roles?: string[];
		extras?: Record<string, unknown>;
	}): Promise<AuthTokenResult> {
		const result = await this.#adapter.register(input, this.#ctx());
		this.#pubsub.publish("auth:register", {
			type: "auth:register",
			timestamp: Date.now(),
			email: input.email,
			requiresVerification: Boolean(result.requiresVerification),
		});
		return await this.#applyAuthResult(result);
	}

	async login(input: {
		email: string;
		password: string;
	}): Promise<AuthTokenResult> {
		const result = await this.#adapter.login(input, this.#ctx());
		this.#pubsub.publish("auth:login", {
			type: "auth:login",
			timestamp: Date.now(),
			email: input.email,
		});
		return await this.#applyAuthResult(result);
	}

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

	async resendVerification(input: {
		email: string;
		lang?: string;
	}): Promise<void> {
		await this.#adapter.resendVerification(input, this.#ctx());
	}

	async requestPasswordReset(input: {
		email: string;
		lang?: string;
	}): Promise<void> {
		await this.#adapter.requestPasswordReset(input, this.#ctx());
	}

	async changePassword(input: {
		current_password?: string;
		new_password: string;
		confirm_password: string;
		token?: string;
	}): Promise<void> {
		await this.#adapter.changePassword(input, this.#ctx());
	}

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
		return await this.#applyAuthResult(result);
	}

	/** For the redirect-mode callback page: delegate to the adapter if
	 *  available to extract the result from the current URL/page state. */
	async handleOAuthCallback(): Promise<AuthTokenResult | void> {
		if (!this.#adapter.handleOAuthCallback) {
			throw new Error(
				"AuthManager: handleOAuthCallback is not implemented by the adapter",
			);
		}
		const result = await this.#adapter.handleOAuthCallback(this.#ctx());
		return await this.#applyAuthResult(result);
	}
}
