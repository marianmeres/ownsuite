/**
 * @module types/auth
 *
 * Types for the auth / profile / session managers that extend ownsuite with
 * a first-class identity lifecycle (register, login, logout, OAuth link/
 * unlink, email verification, password reset, delete account, profile edit).
 *
 * Design notes:
 *  - The adapter pattern mirrors `OwnedCollectionAdapter` — consumers plug in
 *    an implementation; no HTTP code lives in managers.
 *  - The `SessionManager` is the single source of truth for the JWT and the
 *    current subject. Adapters never hold auth state.
 *  - OAuth initiation returns a URL — the popup / redirect dance is handled
 *    by the `openOAuthPopup` helper (see `oauth/popup.ts`) rather than the
 *    adapter itself.
 */

import type { OwnsuiteContext } from "./state.ts";

/** Lifecycle state of the current session. */
export type SessionStatus =
	/** No JWT. Either never logged in or explicitly logged out. */
	| "anonymous"
	/** JWT present, subject loaded, login succeeded. */
	| "authenticated"
	/**
	 * Account exists and credentials were correct BUT the server is blocking
	 * login because the email is not yet verified. UI should surface "check
	 * your email" without a second round-trip. Emitted when `auth.login()`
	 * or `auth.register()` hits the verification gate.
	 */
	| "unverified";

/**
 * Minimal subject shape exposed to consumers. Matches what stack-account's
 * `/me` returns plus the fields needed for role-gating.
 */
export interface SessionSubject {
	id: string;
	email: string;
	roles: string[];
	isVerified: boolean;
	/** Whether the account has a password (OAuth-only accounts do not). */
	hasPassword: boolean;
}

/** Observable session state — stored by the SessionManager. */
export interface SessionState {
	status: SessionStatus;
	subject: SessionSubject | null;
	jwt: string | null;
	/** Unix-seconds expiry (optional — not every server shape returns one). */
	expiresAt: number | null;
}

// ─────────────────────── session storage interface ─────────────────────────

/**
 * Pluggable storage for persisting session state across reloads. Consumers
 * can pass "local" / "session" / "memory" or supply their own object
 * matching this interface (useful for Tauri, WebExtensions, SSR guards).
 */
export interface SessionStorage {
	get(key: string): string | null;
	set(key: string, value: string): void;
	del(key: string): void;
}

export type SessionStorageType = "local" | "session" | "memory" | SessionStorage;

// ─────────────────────── OAuth connection shape ────────────────────────────

export type OAuthProvider = "google" | "facebook" | "apple" | "twitter";

export interface OAuthConnection {
	provider: OAuthProvider;
	display_name?: string;
	avatar_url?: string;
	email?: string;
}

/** Action verb for the OAuth init URL — `login` creates/looks-up an account,
 *  `link` attaches the provider to the currently authenticated subject. */
export type OAuthAction = "login" | "link";

export interface OAuthInitOptions {
	action: OAuthAction;
	/** Where to redirect after the provider callback (server honours this). */
	redirect?: string;
	/** Language code forwarded to the server for error-page localization. */
	lang?: string;
	/** `"popup"` (default) or `"redirect"` — the manager uses this to decide
	 *  whether to open a popup and wait for a postMessage, or redirect the
	 *  top window. */
	mode?: "popup" | "redirect";
}

// ─────────────────────── auth result shapes ────────────────────────────────

/**
 * Uniform result shape for `register` / `login` / OAuth success. When the
 * server returns `requiresVerification: true` (i.e. the verification gate is
 * on and the email is not yet verified), the JWT will be absent and the
 * manager flips session.status to "unverified".
 */
export interface AuthTokenResult {
	jwt?: string;
	email: string;
	roles: string[];
	isVerified?: boolean;
	validFrom?: number;
	validUntil?: number;
	/** Set by the server when login auto-login is declined for a not-yet-
	 *  verified account. Mutually exclusive with jwt in practice. */
	requiresVerification?: boolean;
}

// ─────────────────────── profile shape ─────────────────────────────────────

export interface ProfileResult {
	email: string;
	roles: string[];
	isVerified: boolean;
	hasPassword: boolean;
	oauthConnections: OAuthConnection[];
}

// ─────────────────────── adapter interfaces ────────────────────────────────

export interface AuthAdapter {
	register(
		input: {
			email: string;
			password: string;
			password_confirm: string;
			roles?: string[];
			/** Optional extras — consumer forwards any configured
			 *  registrationFields the server expects. */
			extras?: Record<string, unknown>;
		},
		ctx: OwnsuiteContext,
	): Promise<AuthTokenResult>;

	login(
		input: { email: string; password: string },
		ctx: OwnsuiteContext,
	): Promise<AuthTokenResult>;

	/** Best-effort server-side revocation. Must not throw on
	 *  already-anonymous state. */
	logout(ctx: OwnsuiteContext): Promise<void>;

	/** Sync URL builder. The manager opens this URL in a popup (default) or
	 *  redirects the top window depending on mode. */
	oauthInitUrl(
		provider: OAuthProvider,
		opts: OAuthInitOptions,
		ctx: OwnsuiteContext,
	): string;

	/** For the redirect-mode callback path: extract result from the current
	 *  URL (or a server-rendered payload) and return it. Popup-mode uses the
	 *  `openOAuthPopup` helper directly and does not call this. */
	handleOAuthCallback?(
		ctx: OwnsuiteContext,
	): Promise<AuthTokenResult>;

	resendVerification(
		input: { email: string; lang?: string },
		ctx: OwnsuiteContext,
	): Promise<void>;

	requestPasswordReset(
		input: { email: string; lang?: string },
		ctx: OwnsuiteContext,
	): Promise<void>;

	changePassword(
		input: {
			/** Required for authenticated self-change. */
			current_password?: string;
			new_password: string;
			confirm_password: string;
			/** Required for token-based reset. */
			token?: string;
		},
		ctx: OwnsuiteContext,
	): Promise<void>;

	deleteAccount(
		input: { password?: string; confirm?: boolean },
		ctx: OwnsuiteContext,
	): Promise<{ deleted: true }>;
}

export interface ProfileAdapter {
	get(ctx: OwnsuiteContext): Promise<ProfileResult>;
	update(
		input: { email?: string; current_password?: string },
		ctx: OwnsuiteContext,
	): Promise<ProfileResult>;
	listOAuth(ctx: OwnsuiteContext): Promise<OAuthConnection[]>;
	unlinkOAuth(
		provider: OAuthProvider,
		ctx: OwnsuiteContext,
	): Promise<void>;
}
