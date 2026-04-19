/**
 * @module adapters/mock-auth
 *
 * In-memory mock implementations of AuthAdapter and ProfileAdapter.
 * Drives the unit tests for AuthManager / ProfileManager / SessionManager
 * without a real server. Consumers can also use it to build demos or
 * storybooks that exercise the full suite.
 *
 * Deliberately small: everything is held in a shared `Store` object the
 * adapters close over, so tests can peek at or mutate state directly.
 */

import type {
	AuthAdapter,
	AuthTokenResult,
	OAuthConnection,
	OAuthInitOptions,
	OAuthProvider,
	OwnsuiteContext,
	ProfileAdapter,
	ProfileResult,
} from "../types/mod.ts";

interface MockAccount {
	email: string;
	password: string;
	roles: string[];
	isVerified: boolean;
	hasPassword: boolean;
	oauthConnections: OAuthConnection[];
}

export interface MockAuthStore {
	accounts: Map<string, MockAccount>;
	/** If true, register/login return requiresVerification=true until the
	 *  email is explicitly verified via `verifyMockAccount()`. */
	requireVerifiedEmail: boolean;
	/** Last-issued JWT per email (just a synthetic string). */
	jwtsByEmail: Map<string, string>;
}

export function createMockAuthStore(init: {
	requireVerifiedEmail?: boolean;
	seed?: MockAccount[];
} = {}): MockAuthStore {
	const store: MockAuthStore = {
		accounts: new Map(),
		requireVerifiedEmail: init.requireVerifiedEmail ?? false,
		jwtsByEmail: new Map(),
	};
	for (const a of init.seed ?? []) {
		store.accounts.set(a.email, { ...a });
	}
	return store;
}

function mintJwt(email: string): string {
	return `mock.${btoa(email)}.${Date.now().toString(36)}`;
}

export function createMockAuthAdapter(store: MockAuthStore): AuthAdapter {
	return {
		register(input, _ctx: OwnsuiteContext) {
			if (store.accounts.has(input.email)) {
				return Promise.reject(
					Object.assign(new Error("Conflict"), { status: 409 }),
				);
			}
			const roles = (input.roles ?? ["user"]).filter((r) =>
				!["admin", "root", "guest"].includes(r)
			);
			const effectiveRoles = roles.length > 0 ? roles : ["user"];
			const account: MockAccount = {
				email: input.email,
				password: input.password,
				roles: effectiveRoles,
				isVerified: false,
				hasPassword: true,
				oauthConnections: [],
			};
			store.accounts.set(input.email, account);

			if (store.requireVerifiedEmail) {
				return Promise.resolve<AuthTokenResult>({
					email: input.email,
					roles: effectiveRoles,
					requiresVerification: true,
				});
			}

			const jwt = mintJwt(input.email);
			store.jwtsByEmail.set(input.email, jwt);
			return Promise.resolve<AuthTokenResult>({
				jwt,
				email: input.email,
				roles: effectiveRoles,
				isVerified: account.isVerified,
			});
		},

		login(input, _ctx: OwnsuiteContext) {
			const acc = store.accounts.get(input.email);
			if (!acc || acc.password !== input.password) {
				return Promise.reject(
					Object.assign(new Error("Unauthorized"), { status: 401 }),
				);
			}
			if (store.requireVerifiedEmail && !acc.isVerified) {
				return Promise.reject(
					Object.assign(new Error("EMAIL_NOT_VERIFIED"), {
						status: 403,
						code: "EMAIL_NOT_VERIFIED",
					}),
				);
			}
			const jwt = mintJwt(input.email);
			store.jwtsByEmail.set(input.email, jwt);
			return Promise.resolve<AuthTokenResult>({
				jwt,
				email: acc.email,
				roles: acc.roles,
				isVerified: acc.isVerified,
			});
		},

		logout(ctx: OwnsuiteContext) {
			// Revoke the JWT associated with this bearer.
			const jwt = ctx.jwt as string | undefined;
			if (jwt) {
				for (const [email, j] of store.jwtsByEmail) {
					if (j === jwt) {
						store.jwtsByEmail.delete(email);
						break;
					}
				}
			}
			return Promise.resolve();
		},

		oauthInitUrl(provider: OAuthProvider, opts: OAuthInitOptions) {
			const qs = new URLSearchParams({ action: opts.action });
			if (opts.redirect) qs.set("redirect", opts.redirect);
			if (opts.lang) qs.set("lang", opts.lang);
			return `mock://oauth/${provider}/init?${qs}`;
		},

		resendVerification(input, _ctx) {
			// Silently succeed whether or not the account exists.
			if (!store.accounts.has(input.email)) return Promise.resolve();
			// No-op in the mock — verifyMockAccount() stands in for the user
			// clicking the link.
			return Promise.resolve();
		},

		requestPasswordReset(_input, _ctx) {
			return Promise.resolve();
		},

		changePassword(input, ctx: OwnsuiteContext) {
			const jwt = ctx.jwt as string | undefined;
			let email: string | undefined;
			if (jwt) {
				for (const [e, j] of store.jwtsByEmail) {
					if (j === jwt) {
						email = e;
						break;
					}
				}
			}
			if (!email) {
				return Promise.reject(
					Object.assign(new Error("Unauthorized"), { status: 401 }),
				);
			}
			const acc = store.accounts.get(email);
			if (!acc) {
				return Promise.reject(
					Object.assign(new Error("NotFound"), { status: 404 }),
				);
			}
			if (acc.password !== input.current_password) {
				return Promise.reject(
					Object.assign(new Error("BadRequest"), { status: 400 }),
				);
			}
			acc.password = input.new_password;
			return Promise.resolve();
		},

		deleteAccount(_input, ctx: OwnsuiteContext) {
			const jwt = ctx.jwt as string | undefined;
			if (!jwt) {
				return Promise.reject(
					Object.assign(new Error("Unauthorized"), { status: 401 }),
				);
			}
			for (const [email, j] of store.jwtsByEmail) {
				if (j === jwt) {
					store.accounts.delete(email);
					store.jwtsByEmail.delete(email);
					return Promise.resolve({ deleted: true } as const);
				}
			}
			return Promise.reject(
				Object.assign(new Error("Unauthorized"), { status: 401 }),
			);
		},
	};
}

export function createMockProfileAdapter(store: MockAuthStore): ProfileAdapter {
	function emailFromCtx(ctx: OwnsuiteContext): string | null {
		const jwt = ctx.jwt as string | undefined;
		if (!jwt) return null;
		for (const [email, j] of store.jwtsByEmail) {
			if (j === jwt) return email;
		}
		return null;
	}

	return {
		get(ctx: OwnsuiteContext): Promise<ProfileResult> {
			const email = emailFromCtx(ctx);
			if (!email) {
				return Promise.reject(
					Object.assign(new Error("Unauthorized"), { status: 401 }),
				);
			}
			const acc = store.accounts.get(email);
			if (!acc) {
				return Promise.reject(
					Object.assign(new Error("NotFound"), { status: 404 }),
				);
			}
			return Promise.resolve({
				email: acc.email,
				roles: acc.roles,
				isVerified: acc.isVerified,
				hasPassword: acc.hasPassword,
				oauthConnections: [...acc.oauthConnections],
			});
		},

		update(input, ctx: OwnsuiteContext): Promise<ProfileResult> {
			const email = emailFromCtx(ctx);
			if (!email) {
				return Promise.reject(
					Object.assign(new Error("Unauthorized"), { status: 401 }),
				);
			}
			const acc = store.accounts.get(email);
			if (!acc) {
				return Promise.reject(
					Object.assign(new Error("NotFound"), { status: 404 }),
				);
			}
			if (input.email && input.email !== acc.email) {
				if (store.requireVerifiedEmail) acc.isVerified = false;
				store.accounts.delete(acc.email);
				acc.email = input.email;
				store.accounts.set(acc.email, acc);
				// Refresh JWT mapping too.
				const jwt = store.jwtsByEmail.get(email);
				if (jwt) {
					store.jwtsByEmail.delete(email);
					store.jwtsByEmail.set(acc.email, jwt);
				}
			}
			return Promise.resolve({
				email: acc.email,
				roles: acc.roles,
				isVerified: acc.isVerified,
				hasPassword: acc.hasPassword,
				oauthConnections: [...acc.oauthConnections],
			});
		},

		listOAuth(ctx: OwnsuiteContext): Promise<OAuthConnection[]> {
			const email = emailFromCtx(ctx);
			if (!email) return Promise.resolve([]);
			const acc = store.accounts.get(email);
			return Promise.resolve(acc ? [...acc.oauthConnections] : []);
		},

		unlinkOAuth(provider: OAuthProvider, ctx: OwnsuiteContext) {
			const email = emailFromCtx(ctx);
			if (!email) {
				return Promise.reject(
					Object.assign(new Error("Unauthorized"), { status: 401 }),
				);
			}
			const acc = store.accounts.get(email);
			if (!acc) {
				return Promise.reject(
					Object.assign(new Error("NotFound"), { status: 404 }),
				);
			}
			acc.oauthConnections = acc.oauthConnections.filter(
				(c) => c.provider !== provider,
			);
			return Promise.resolve();
		},
	};
}

/** Test helper — mark a mock account as verified as if the user had clicked
 *  the link in the verification email. */
export function verifyMockAccount(store: MockAuthStore, email: string): void {
	const acc = store.accounts.get(email);
	if (acc) acc.isVerified = true;
}
