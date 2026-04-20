/**
 * @module adapters/stack-account
 *
 * Default implementations of `AuthAdapter` and `ProfileAdapter` that target
 * the `@marianmeres/stack-account` REST surface:
 *
 *   POST /api/account/register
 *   POST /api/account/login
 *   POST /api/account/logout
 *   GET  /api/account/oauth/[provider]/init
 *   POST /api/account/verify/resend
 *   POST /api/account/password/reset
 *   POST /api/account/password/change
 *   GET/PUT/DELETE /api/account/me
 *   GET  /api/account/me/oauth
 *   DELETE /api/account/me/oauth/[provider]
 *
 * Apps whose server mounts stack-account at this path can just do:
 *
 *   const suite = createOwnsuite({
 *     adapters: {
 *       auth: createStackAccountAuthAdapter({ baseUrl: "/api/account" }),
 *       profile: createStackAccountProfileAdapter({ baseUrl: "/api/account" }),
 *     },
 *   });
 *
 * Apps with custom routes should write their own adapter against the
 * AuthAdapter / ProfileAdapter interfaces.
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

/** Options shared by the two stack-account adapter factories. */
export interface StackAccountAdapterOptions {
	/** Base URL of the mounted stack-account app. Default: "/api/account". */
	baseUrl?: string;
	/** Override the `fetch` implementation (useful for tests / SSR). */
	fetch?: typeof fetch;
}

function resolveFetch(opts?: StackAccountAdapterOptions): typeof fetch {
	return opts?.fetch ?? (globalThis.fetch.bind(globalThis));
}

function join(base: string, path: string): string {
	if (!base) return path;
	if (base.endsWith("/")) return `${base.slice(0, -1)}${path}`;
	return `${base}${path}`;
}

function authHeaders(ctx: OwnsuiteContext): HeadersInit {
	return ctx.jwt ? { Authorization: `Bearer ${ctx.jwt}` } : {};
}

async function postJson<T>(
	doFetch: typeof fetch,
	url: string,
	body: unknown,
	ctx: OwnsuiteContext,
): Promise<T> {
	const res = await doFetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...authHeaders(ctx),
		},
		body: JSON.stringify(body),
		signal: ctx.signal,
	});
	if (!res.ok) {
		const text = await res.text();
		throw Object.assign(new Error(text || res.statusText), {
			status: res.status,
			body: text,
		});
	}
	return (await res.json()) as T;
}

async function requestJson<T>(
	doFetch: typeof fetch,
	url: string,
	init: RequestInit,
	ctx: OwnsuiteContext,
): Promise<T> {
	const res = await doFetch(url, {
		...init,
		headers: {
			...(init.headers ?? {}),
			...authHeaders(ctx),
			...(init.body
				? { "Content-Type": "application/json" }
				: {}),
		},
		signal: ctx.signal,
	});
	if (!res.ok) {
		const text = await res.text();
		throw Object.assign(new Error(text || res.statusText), {
			status: res.status,
			body: text,
		});
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

interface ServerAuthResponse {
	data: {
		jwt?: string;
		email: string;
		roles: string[];
		isVerified?: boolean;
		validFrom?: number;
		validUntil?: number;
		requiresVerification?: boolean;
		ok?: boolean;
	};
}

interface ServerMeResponse {
	data: ProfileResult;
}

/** Build the default {@link AuthAdapter} for `@marianmeres/stack-account`.
 *  Points at `{baseUrl}/auth/*` (register/login/logout/verify/password/
 *  delete) and `{baseUrl}/oauth/*` (init + callback). */
export function createStackAccountAuthAdapter(
	opts: StackAccountAdapterOptions = {},
): AuthAdapter {
	const base = opts.baseUrl ?? "/api/account";
	const doFetch = resolveFetch(opts);

	return {
		async register(input, ctx) {
			const r = await postJson<ServerAuthResponse>(
				doFetch,
				join(base, "/register"),
				input,
				ctx,
			);
			return r.data as AuthTokenResult;
		},

		async login(input, ctx) {
			const r = await postJson<ServerAuthResponse>(
				doFetch,
				join(base, "/login"),
				input,
				ctx,
			);
			return r.data as AuthTokenResult;
		},

		async logout(ctx) {
			await requestJson<void>(
				doFetch,
				join(base, "/logout"),
				{ method: "POST" },
				ctx,
			);
		},

		oauthInitUrl(
			provider: OAuthProvider,
			options: OAuthInitOptions,
			_ctx: OwnsuiteContext,
		): string {
			const qs = new URLSearchParams({ action: options.action });
			if (options.redirect) qs.set("redirect", options.redirect);
			if (options.lang) qs.set("lang", options.lang);
			return `${join(base, `/oauth/${provider}/init`)}?${qs}`;
		},

		async resendVerification(input, ctx) {
			await postJson(
				doFetch,
				join(base, "/verify/resend"),
				input,
				ctx,
			);
		},

		async requestPasswordReset(input, ctx) {
			await postJson(
				doFetch,
				join(base, "/password/reset"),
				input,
				ctx,
			);
		},

		async changePassword(input, ctx) {
			await postJson(
				doFetch,
				join(base, "/password/change"),
				input,
				ctx,
			);
		},

		async deleteAccount(input, ctx) {
			await requestJson<void>(
				doFetch,
				join(base, "/me"),
				{
					method: "DELETE",
					body: JSON.stringify(input),
				},
				ctx,
			);
			return { deleted: true } as const;
		},
	};
}

/** Build the default {@link ProfileAdapter} for `@marianmeres/stack-account`.
 *  Points at `{baseUrl}/me` (GET + PUT) and `{baseUrl}/me/oauth/*` for
 *  connection listing / unlinking. */
export function createStackAccountProfileAdapter(
	opts: StackAccountAdapterOptions = {},
): ProfileAdapter {
	const base = opts.baseUrl ?? "/api/account";
	const doFetch = resolveFetch(opts);

	return {
		async get(ctx) {
			const r = await requestJson<ServerMeResponse>(
				doFetch,
				join(base, "/me"),
				{ method: "GET" },
				ctx,
			);
			return r.data;
		},

		async update(input, ctx) {
			const r = await requestJson<ServerMeResponse>(
				doFetch,
				join(base, "/me"),
				{
					method: "PUT",
					body: JSON.stringify(input),
				},
				ctx,
			);
			return r.data;
		},

		async listOAuth(ctx): Promise<OAuthConnection[]> {
			const r = await requestJson<{ data: OAuthConnection[] }>(
				doFetch,
				join(base, "/me/oauth"),
				{ method: "GET" },
				ctx,
			);
			return r.data ?? [];
		},

		async unlinkOAuth(provider, ctx) {
			await requestJson<void>(
				doFetch,
				join(base, `/me/oauth/${provider}`),
				{ method: "DELETE" },
				ctx,
			);
		},
	};
}
