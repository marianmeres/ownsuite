/**
 * Regression tests for the stack-account auth adapter's wire→domain
 * normalization. The server emits token validity as ISO-8601 strings, but
 * `AuthTokenResult.validUntil` is consumed downstream as numeric epoch
 * seconds (it becomes `SessionState.expiresAt`, used in `expiresAt * 1000`
 * arithmetic). A previous blind `r.data as AuthTokenResult` cast laundered the
 * ISO string into the numeric field, so expired sessions never expired on
 * hydration. These pin the conversion so it can't silently regress.
 */

import { createStackAccountAuthAdapter } from "../src/adapters/stack-account.ts";
import { assert, assertEquals } from "@std/assert";

const ISO = "2026-06-07T10:00:00.000Z";
const EPOCH_SECONDS = Math.floor(Date.parse(ISO) / 1000);

/** A `fetch` stand-in that always resolves with the given JSON body (200). */
function fetchReturning(body: unknown): typeof fetch {
	return ((_url: string | URL | Request, _init?: RequestInit) =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)) as unknown as typeof fetch;
}

/** Build a structurally-valid (unsigned) JWT carrying the given payload, so
 *  `jwtExpSeconds` can read its `exp`. */
function makeJwt(payload: Record<string, unknown>): string {
	const enc = (o: unknown) =>
		btoa(JSON.stringify(o))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

function adapterWith(body: unknown) {
	return createStackAccountAuthAdapter({
		baseUrl: "/api/account",
		fetch: fetchReturning(body),
	});
}

Deno.test("stack-account adapter - login: ISO validUntil → epoch seconds", async () => {
	const adapter = adapterWith({
		data: { jwt: "j", email: "e@e.com", roles: ["user"], validUntil: ISO },
	});
	const r = await adapter.login({ email: "e@e.com", password: "x" }, {});
	assertEquals(typeof r.validUntil, "number");
	assert(Number.isFinite(r.validUntil!));
	assertEquals(r.validUntil, EPOCH_SECONDS);
});

Deno.test("stack-account adapter - register: ISO validUntil → epoch seconds", async () => {
	const adapter = adapterWith({
		data: { jwt: "j", email: "e@e.com", roles: ["user"], validUntil: ISO },
	});
	const r = await adapter.register(
		{ email: "e@e.com", password: "x", password_confirm: "x" },
		{},
	);
	assertEquals(r.validUntil, EPOCH_SECONDS);
	assert(Number.isFinite(r.validUntil!));
});

Deno.test("stack-account adapter - validFrom is also converted to epoch seconds", async () => {
	const adapter = adapterWith({
		data: {
			jwt: "j",
			email: "e@e.com",
			roles: [],
			validFrom: ISO,
			validUntil: ISO,
		},
	});
	const r = await adapter.login({ email: "e@e.com", password: "x" }, {});
	assertEquals(r.validFrom, EPOCH_SECONDS);
});

Deno.test("stack-account adapter - already-numeric validUntil is idempotent", async () => {
	const adapter = adapterWith({
		data: { jwt: "j", email: "e@e.com", roles: [], validUntil: EPOCH_SECONDS },
	});
	const r = await adapter.login({ email: "e@e.com", password: "x" }, {});
	assertEquals(r.validUntil, EPOCH_SECONDS);
});

Deno.test("stack-account adapter - epoch-ms numeric validUntil is scaled to seconds", async () => {
	const ms = Date.parse(ISO); // > 1e12
	const adapter = adapterWith({
		data: { jwt: "j", email: "e@e.com", roles: [], validUntil: ms },
	});
	const r = await adapter.login({ email: "e@e.com", password: "x" }, {});
	assertEquals(r.validUntil, EPOCH_SECONDS);
});

Deno.test("stack-account adapter - garbage validUntil (no usable JWT exp) → undefined", async () => {
	const adapter = adapterWith({
		data: {
			jwt: "not-a-jwt",
			email: "e@e.com",
			roles: [],
			validUntil: "nonsense",
		},
	});
	const r = await adapter.login({ email: "e@e.com", password: "x" }, {});
	assertEquals(r.validUntil, undefined);
});

Deno.test("stack-account adapter - missing validUntil falls back to JWT exp claim", async () => {
	const jwt = makeJwt({ sub: "u1", exp: EPOCH_SECONDS });
	const adapter = adapterWith({
		data: { jwt, email: "e@e.com", roles: [] }, // no validUntil
	});
	const r = await adapter.login({ email: "e@e.com", password: "x" }, {});
	assertEquals(r.validUntil, EPOCH_SECONDS);
});

Deno.test("stack-account adapter - unverified (no JWT) response is passed through", async () => {
	const adapter = adapterWith({
		data: { email: "e@e.com", roles: [], requiresVerification: true },
	});
	const r = await adapter.register(
		{ email: "e@e.com", password: "x", password_confirm: "x" },
		{},
	);
	assertEquals(r.requiresVerification, true);
	assertEquals(r.jwt, undefined);
	assertEquals(r.validUntil, undefined);
});
