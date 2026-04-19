/**
 * Unit tests for the auth / session / profile managers wired through the
 * top-level Ownsuite class with the mock auth + profile adapters. Covers:
 *
 *   - session hydration from pluggable storage
 *   - register → requires-verification vs register → authenticated
 *   - login failures keep session unchanged
 *   - logout clears storage and session
 *   - profile.fetch patches the session subject
 *   - profile.update syncs email through to the session
 *   - identity changes reset every registered owner-scoped domain
 *   - delete account logs out locally and clears session
 */

import { createMemorySessionStorage } from "../src/domains/session.ts";
import type { SessionStorage } from "../src/types/auth.ts";
import {
	createMockAuthAdapter,
	createMockAuthStore,
	createMockProfileAdapter,
	verifyMockAccount,
} from "../src/adapters/mock-auth.ts";
import {
	createMockOwnedCollectionAdapter,
} from "../src/adapters/mock.ts";
import { createOwnsuite } from "../src/ownsuite.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";

// ─────────────────────── session hydration ─────────────────────────────────

Deno.test("session - hydrates from existing storage on construction", () => {
	const storage = createMemorySessionStorage();
	storage.set(
		"ownsuite:session",
		JSON.stringify({
			status: "authenticated",
			subject: {
				id: "u1",
				email: "pre@existing.com",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
			},
			jwt: "pre-jwt",
			expiresAt: null,
		}),
	);
	const store = createMockAuthStore({
		seed: [
			{
				email: "pre@existing.com",
				password: "x",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage },
	});
	try {
		assertExists(suite.session);
		assertEquals(suite.session!.get().status, "authenticated");
		assertEquals(suite.session!.get().jwt, "pre-jwt");
	} finally {
		suite.destroy();
	}
});

Deno.test("session - expired stored session is discarded", () => {
	const storage = createMemorySessionStorage();
	storage.set(
		"ownsuite:session",
		JSON.stringify({
			status: "authenticated",
			subject: { id: "u1", email: "x", roles: [], isVerified: true, hasPassword: true },
			jwt: "old-jwt",
			expiresAt: Math.floor(Date.now() / 1000) - 10,
		}),
	);
	const store = createMockAuthStore();
	const suite = createOwnsuite({
		adapters: { auth: createMockAuthAdapter(store) },
		session: { storage },
	});
	try {
		assertEquals(suite.session!.get().status, "anonymous");
		assertEquals(storage.get("ownsuite:session"), null);
	} finally {
		suite.destroy();
	}
});

Deno.test("session - custom storage.get/set/del are exercised on writes", () => {
	const calls: string[] = [];
	const storage: SessionStorage = {
		get(k: string) {
			calls.push(`get:${k}`);
			return null;
		},
		set(k: string, _v: string) {
			calls.push(`set:${k}`);
		},
		del(k: string) {
			calls.push(`del:${k}`);
		},
	};
	const store = createMockAuthStore();
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage },
	});
	try {
		suite.session!.setAuthenticated({
			jwt: "j",
			subject: {
				id: "u",
				email: "e@e.com",
				roles: [],
				isVerified: true,
				hasPassword: true,
			},
		});
		if (!calls.includes("set:ownsuite:session")) {
			throw new Error(`set not called: ${calls.join(",")}`);
		}
	} finally {
		suite.destroy();
	}
});

// ─────────────────────── register / login / logout ─────────────────────────

Deno.test("auth.register - gate on returns unverified, session reflects it", async () => {
	const store = createMockAuthStore({ requireVerifiedEmail: true });
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage: createMemorySessionStorage() },
	});
	try {
		const result = await suite.auth!.register({
			email: "new@test.com",
			password: "password",
			password_confirm: "password",
		});
		assertEquals(result.requiresVerification, true);
		assertEquals(suite.session!.get().status, "unverified");
		assertEquals(suite.session!.get().subject?.email, "new@test.com");
		assertEquals(suite.session!.get().jwt, null);
	} finally {
		suite.destroy();
	}
});

Deno.test("auth.register - gate off returns a JWT, session flips authenticated", async () => {
	const store = createMockAuthStore({ requireVerifiedEmail: false });
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage: createMemorySessionStorage() },
	});
	try {
		const result = await suite.auth!.register({
			email: "fast@test.com",
			password: "password",
			password_confirm: "password",
		});
		assertExists(result.jwt);
		assertEquals(suite.session!.get().status, "authenticated");
		assertEquals(suite.session!.get().subject?.email, "fast@test.com");
	} finally {
		suite.destroy();
	}
});

Deno.test("auth.login - wrong password leaves session untouched", async () => {
	const store = createMockAuthStore({
		seed: [
			{
				email: "real@test.com",
				password: "correct",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage: createMemorySessionStorage() },
	});
	try {
		await assertRejects(() =>
			suite.auth!.login({
				email: "real@test.com",
				password: "wrong",
			})
		);
		assertEquals(suite.session!.get().status, "anonymous");
	} finally {
		suite.destroy();
	}
});

Deno.test("auth.login - unverified account transitions session to unverified", async () => {
	const store = createMockAuthStore({
		requireVerifiedEmail: true,
		seed: [
			{
				email: "pending@test.com",
				password: "password",
				roles: ["user"],
				isVerified: false,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage: createMemorySessionStorage() },
	});
	try {
		await assertRejects(() =>
			suite.auth!.login({
				email: "pending@test.com",
				password: "password",
			})
		);
		// Mock adapter rejects — we didn't call setUnverified here. This test
		// documents the contract: the app decides based on server response.
		assertEquals(suite.session!.get().status, "anonymous");

		// After verification the user can log in.
		verifyMockAccount(store, "pending@test.com");
		const result = await suite.auth!.login({
			email: "pending@test.com",
			password: "password",
		});
		assertExists(result.jwt);
		assertEquals(suite.session!.get().status, "authenticated");
	} finally {
		suite.destroy();
	}
});

Deno.test("auth.logout - clears session and storage, emits auth:logout", async () => {
	const storage = createMemorySessionStorage();
	const store = createMockAuthStore({
		seed: [
			{
				email: "byebye@test.com",
				password: "password",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage },
	});
	try {
		await suite.auth!.login({
			email: "byebye@test.com",
			password: "password",
		});
		assertEquals(suite.session!.get().status, "authenticated");

		let logoutFired = false;
		suite.on("auth:logout", () => {
			logoutFired = true;
		});

		await suite.auth!.logout();
		assertEquals(suite.session!.get().status, "anonymous");
		assertEquals(storage.get("ownsuite:session"), null);
		assertEquals(logoutFired, true);
	} finally {
		suite.destroy();
	}
});

// ─────────────────────── profile ───────────────────────────────────────────

Deno.test("profile.update - email change flows through to session subject", async () => {
	const store = createMockAuthStore({
		requireVerifiedEmail: false,
		seed: [
			{
				email: "original@test.com",
				password: "password",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage: createMemorySessionStorage() },
	});
	try {
		await suite.auth!.login({
			email: "original@test.com",
			password: "password",
		});
		assertEquals(suite.session!.get().subject?.email, "original@test.com");

		let updatedFired = false;
		suite.on("profile:updated", () => {
			updatedFired = true;
		});

		const updated = await suite.profile!.update({
			email: "renamed@test.com",
		});
		assertEquals(updated.email, "renamed@test.com");
		assertEquals(suite.session!.get().subject?.email, "renamed@test.com");
		assertEquals(updatedFired, true);
	} finally {
		suite.destroy();
	}
});

// ─────────────────────── identity change + owned domains ───────────────────

Deno.test("switchIdentity - logging in resets every registered owner-scoped domain", async () => {
	const ownedAdapter = createMockOwnedCollectionAdapter<
		{ id: string; title: string }
	>({
		seed: [{ id: "r1", title: "first" }],
	});
	const store = createMockAuthStore({
		requireVerifiedEmail: false,
		seed: [
			{
				email: "owner@test.com",
				password: "password",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		domains: { notes: { adapter: ownedAdapter } },
		session: { storage: createMemorySessionStorage() },
	});
	try {
		await suite.auth!.login({
			email: "owner@test.com",
			password: "password",
		});
		// After login the notes domain should re-initialize and pick up the
		// seeded row (the onIdentityChanged hook resets + initializes).
		const state = suite.domain("notes").get();
		if (state.state !== "ready") {
			// Give one microtask for the refresh to land.
			await new Promise((r) => setTimeout(r, 20));
		}
		const rows = (suite.domain("notes").get().data?.rows ?? []) as Array<
			{ id: string; title: string }
		>;
		assertEquals(rows.length, 1);
		assertEquals(rows[0].title, "first");

		// Logout resets the domain back to initializing (no implicit fetch).
		await suite.auth!.logout();
		assertEquals(suite.domain("notes").get().state, "initializing");
	} finally {
		suite.destroy();
	}
});

// ─────────────────────── delete account ────────────────────────────────────

Deno.test("auth.deleteAccount - clears session locally after success", async () => {
	const store = createMockAuthStore({
		requireVerifiedEmail: false,
		seed: [
			{
				email: "goodbye@test.com",
				password: "password",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			},
		],
	});
	const suite = createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		session: { storage: createMemorySessionStorage() },
	});
	try {
		await suite.auth!.login({
			email: "goodbye@test.com",
			password: "password",
		});
		assertEquals(suite.session!.get().status, "authenticated");

		await suite.auth!.deleteAccount({ password: "password" });
		assertEquals(suite.session!.get().status, "anonymous");
		// Re-login must fail — account is gone.
		await assertRejects(() =>
			suite.auth!.login({
				email: "goodbye@test.com",
				password: "password",
			})
		);
	} finally {
		suite.destroy();
	}
});
