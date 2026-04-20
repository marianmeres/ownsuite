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
	/** Server-assigned subject identifier. Empty string before `/me` lands. */
	id: string;
	/** Verified or unverified email address of the subject. */
	email: string;
	/** Authorization roles — drive UI gating, not security. */
	roles: string[];
	/** True when the server has confirmed the email address. */
	isVerified: boolean;
	/** Whether the account has a password (OAuth-only accounts do not). */
	hasPassword: boolean;
}

/** Observable session state — stored by the SessionManager. */
export interface SessionState {
	/** Current lifecycle bucket; see {@link SessionStatus}. */
	status: SessionStatus;
	/** Loaded subject, or `null` when anonymous. */
	subject: SessionSubject | null;
	/** JWT for outgoing `Authorization` headers, `null` when anonymous. */
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
	/** Read a value by key; return `null` when missing or unreadable. */
	get(key: string): string | null;
	/** Write a value; silently no-op on quota errors. */
	set(key: string, value: string): void;
	/** Delete a value; silently no-op when absent. */
	del(key: string): void;
}

/** Accepted `storage` option for `SessionManager`. String values resolve to
 *  the three built-in backends; a {@link SessionStorage} object overrides
 *  the defaults entirely (single custom backend — per-login `remember` is
 *  silently ignored in that mode). */
export type SessionStorageType = "local" | "session" | "memory" | SessionStorage;

// ─────────────────────── OAuth connection shape ────────────────────────────

/** Supported OAuth provider identifiers — the server side (`@marianmeres/
 *  stack-account`) decides which are actually enabled. */
export type OAuthProvider = "google" | "facebook" | "apple" | "twitter";

/** A single linked OAuth provider connection on the subject's account. */
export interface OAuthConnection {
	/** Which provider this connection represents. */
	provider: OAuthProvider;
	/** Human-readable display name as reported by the provider. */
	display_name?: string;
	/** Avatar URL reported by the provider (not proxied — may be public). */
	avatar_url?: string;
	/** Email reported by the provider (may differ from the account email). */
	email?: string;
}

/** Action verb for the OAuth init URL — `login` creates/looks-up an account,
 *  `link` attaches the provider to the currently authenticated subject. */
export type OAuthAction = "login" | "link";

/** Options for starting an OAuth flow via `AuthManager.initiateOAuth`. */
export interface OAuthInitOptions {
	/** Whether this flow creates/looks-up an account (`login`) or attaches
	 *  the provider to the currently authenticated subject (`link`). */
	action: OAuthAction;
	/** Where to redirect after the provider callback (server honours this). */
	redirect?: string;
	/** Language code forwarded to the server for error-page localization. */
	lang?: string;
	/** `"popup"` (default) or `"redirect"` — the manager uses this to decide
	 *  whether to open a popup and wait for a postMessage, or redirect the
	 *  top window. */
	mode?: "popup" | "redirect";
	/** Same semantics as {@link AuthActionOptions.remember} — pins the
	 *  resulting session to `localStorage` (`true`) or `sessionStorage`
	 *  (`false`). Only meaningful for `action: "login"`. */
	remember?: boolean;
}

/**
 * Options accepted by `AuthManager.login` / `register` /
 * `handleOAuthCallback` to express per-login storage preference
 * ("Remember me").
 */
export interface AuthActionOptions {
	/** `true` → persist the resulting session to `localStorage` (survives
	 *  browser restart).
	 *  `false` → persist to `sessionStorage` (dies with the tab).
	 *  `undefined` → use the `SessionManager`'s configured default backend.
	 *
	 *  Silently ignored when the `SessionManager` was constructed with a
	 *  custom `SessionStorage` object — the single custom backend is used
	 *  regardless. */
	remember?: boolean;
}

// ─────────────────────── auth result shapes ────────────────────────────────

/**
 * Uniform result shape for `register` / `login` / OAuth success. When the
 * server returns `requiresVerification: true` (i.e. the verification gate is
 * on and the email is not yet verified), the JWT will be absent and the
 * manager flips session.status to "unverified".
 */
export interface AuthTokenResult {
	/** JWT to present on subsequent authenticated requests. Absent when
	 *  `requiresVerification` is `true`. */
	jwt?: string;
	/** Email as recognised by the server (may be normalised). */
	email: string;
	/** Roles granted by the server. */
	roles: string[];
	/** True when the server confirms the email is already verified. */
	isVerified?: boolean;
	/** JWT `not-before` claim in unix seconds (when server returns one). */
	validFrom?: number;
	/** JWT `expires-at` claim in unix seconds (when server returns one). */
	validUntil?: number;
	/** Set by the server when login auto-login is declined for a not-yet-
	 *  verified account. Mutually exclusive with jwt in practice. */
	requiresVerification?: boolean;
}

// ─────────────────────── profile shape ─────────────────────────────────────

/** `/me` profile payload returned by `ProfileAdapter.get` / `update`. */
export interface ProfileResult {
	/** Current email on the account. */
	email: string;
	/** Current authorization roles. */
	roles: string[];
	/** Whether the email is verified. */
	isVerified: boolean;
	/** Whether the account has a password. */
	hasPassword: boolean;
	/** Linked OAuth provider connections. */
	oauthConnections: OAuthConnection[];
}

// ─────────────────────── adapter interfaces ────────────────────────────────

/**
 * Contract the `AuthManager` uses to talk to the server. Implement this
 * against whatever transport the backend exposes — `createStackAccountAuth
 * Adapter` provides the default for `@marianmeres/stack-account`. Adapters
 * hold no state; they forward `ctx.jwt` / `ctx.signal` per call.
 */
export interface AuthAdapter {
	/** Create an account. When the verification gate is on, the returned
	 *  result sets `requiresVerification: true` and omits the JWT. */
	register(
		input: {
			/** Email as entered; server normalises + stores. */
			email: string;
			/** Plaintext password — server hashes. */
			password: string;
			/** Plaintext confirmation, server cross-checks. */
			password_confirm: string;
			/** Roles to request on the account (server may reject). */
			roles?: string[];
			/** Optional extras — consumer forwards any configured
			 *  registrationFields the server expects. */
			extras?: Record<string, unknown>;
		},
		ctx: OwnsuiteContext,
	): Promise<AuthTokenResult>;

	/** Exchange credentials for a JWT. Throws on bad credentials; sets
	 *  `requiresVerification: true` when the verification gate is on. */
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

	/** Request a fresh verification email. Anti-enumeration: must resolve
	 *  regardless of whether the address exists. */
	resendVerification(
		input: { email: string; lang?: string },
		ctx: OwnsuiteContext,
	): Promise<void>;

	/** Request a password-reset email. Anti-enumeration: must resolve
	 *  regardless of whether the address exists. */
	requestPasswordReset(
		input: { email: string; lang?: string },
		ctx: OwnsuiteContext,
	): Promise<void>;

	/** Change or reset the password. Provide `current_password` for an
	 *  authenticated self-change, or `token` for a reset-link flow. */
	changePassword(
		input: {
			/** Required for authenticated self-change. */
			current_password?: string;
			/** New password (plaintext — hashed server-side). */
			new_password: string;
			/** Confirmation — must match new_password. */
			confirm_password: string;
			/** Required for token-based reset. */
			token?: string;
		},
		ctx: OwnsuiteContext,
	): Promise<void>;

	/** Irreversibly delete the authenticated account. Resolves with
	 *  `{ deleted: true }` on success; any failure rejects. */
	deleteAccount(
		input: { password?: string; confirm?: boolean },
		ctx: OwnsuiteContext,
	): Promise<{ deleted: true }>;
}

/** Contract the `ProfileManager` uses to read + mutate `/me`. Like
 *  `AuthAdapter`, stateless — reads `ctx.jwt` per call. */
export interface ProfileAdapter {
	/** GET `/me` → current profile snapshot. */
	get(ctx: OwnsuiteContext): Promise<ProfileResult>;
	/** PUT `/me` — update email and/or confirm current password. Returns
	 *  the refreshed profile. */
	update(
		input: { email?: string; current_password?: string },
		ctx: OwnsuiteContext,
	): Promise<ProfileResult>;
	/** GET linked OAuth connections for the authenticated subject. */
	listOAuth(ctx: OwnsuiteContext): Promise<OAuthConnection[]>;
	/** DELETE a linked OAuth connection. */
	unlinkOAuth(
		provider: OAuthProvider,
		ctx: OwnsuiteContext,
	): Promise<void>;
}
