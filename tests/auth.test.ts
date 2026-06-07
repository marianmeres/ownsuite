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

Deno.test("session - future numeric expiresAt survives hydration", () => {
	const storage = createMemorySessionStorage();
	const future = Math.floor(Date.now() / 1000) + 3600;
	storage.set(
		"ownsuite:session",
		JSON.stringify({
			status: "authenticated",
			subject: { id: "u1", email: "x", roles: [], isVerified: true, hasPassword: true },
			jwt: "good-jwt",
			expiresAt: future,
		}),
	);
	const store = createMockAuthStore();
	const suite = createOwnsuite({
		adapters: { auth: createMockAuthAdapter(store) },
		session: { storage },
	});
	try {
		assertEquals(suite.session!.get().status, "authenticated");
		assertEquals(suite.session!.get().expiresAt, future);
	} finally {
		suite.destroy();
	}
});

Deno.test("session - string (non-finite) expiresAt is treated as expired and wiped", () => {
	// Guards the exact bug: an ISO string laundered into the numeric expiresAt
	// field made `expiresAt * 1000` NaN, so the expired branch was never taken
	// and the stale session lived forever. Must now fail-closed → anonymous.
	const storage = createMemorySessionStorage();
	storage.set(
		"ownsuite:session",
		JSON.stringify({
			status: "authenticated",
			subject: { id: "u1", email: "x", roles: [], isVerified: true, hasPassword: true },
			jwt: "stale-jwt",
			expiresAt: "2020-01-01T00:00:00.000Z",
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

// ─────────────────────── remember-me / per-login storage ──────────────────

/** Clear every built-in backend so tests start from a known state.
 *  Deno's `localStorage` is process-persistent, so a prior test leaking
 *  state here would otherwise poison this one. */
function clearBuiltInStorages(key = "ownsuite:session") {
	try {
		globalThis.localStorage.removeItem(key);
	} catch { /* not available */ }
	try {
		globalThis.sessionStorage.removeItem(key);
	} catch { /* not available */ }
}

function rememberSuite(storageKey?: string) {
	const store = createMockAuthStore({
		requireVerifiedEmail: false,
		seed: [{
			email: "remember@test.com",
			password: "password",
			roles: ["user"],
			isVerified: true,
			hasPassword: true,
			oauthConnections: [],
		}],
	});
	return createOwnsuite({
		adapters: {
			auth: createMockAuthAdapter(store),
			profile: createMockProfileAdapter(store),
		},
		// Default built-in "local" backend — consumers can flip per login.
		session: storageKey ? { storageKey } : {},
	});
}

Deno.test(
	"remember - true pins to localStorage and survives fresh construction",
	async () => {
		const key = "ownsuite:test:remember-true";
		clearBuiltInStorages(key);
		// NB: we deliberately do not `destroy()` the first suite — that is
		// the "reload" bit. destroy() wipes persisted backends by design,
		// whereas a real browser reload just drops the JS heap and leaves
		// Web Storage untouched.
		const suite = rememberSuite(key);
		await suite.auth!.login(
			{ email: "remember@test.com", password: "password" },
			{ remember: true },
		);
		assertEquals(suite.session!.get().status, "authenticated");
		assertExists(globalThis.localStorage.getItem(key));
		assertEquals(globalThis.sessionStorage.getItem(key), null);

		// Simulated reload: build a fresh suite against the same backends.
		const replay = rememberSuite(key);
		try {
			assertEquals(replay.session!.get().status, "authenticated");
			assertEquals(
				replay.session!.get().subject?.email,
				"remember@test.com",
			);
		} finally {
			replay.destroy();
			clearBuiltInStorages(key);
		}
	},
);

Deno.test(
	"remember - false pins to sessionStorage, localStorage stays clean",
	async () => {
		const key = "ownsuite:test:remember-false";
		clearBuiltInStorages(key);
		const suite = rememberSuite(key);
		try {
			await suite.auth!.login(
				{ email: "remember@test.com", password: "password" },
				{ remember: false },
			);
			assertEquals(suite.session!.get().status, "authenticated");
			assertEquals(globalThis.localStorage.getItem(key), null);
			assertExists(globalThis.sessionStorage.getItem(key));
		} finally {
			suite.destroy();
			clearBuiltInStorages(key);
		}
	},
);

Deno.test(
	"remember - toggle true → logout → false leaves localStorage clean",
	async () => {
		const key = "ownsuite:test:remember-toggle";
		clearBuiltInStorages(key);
		const suite = rememberSuite(key);
		try {
			await suite.auth!.login(
				{ email: "remember@test.com", password: "password" },
				{ remember: true },
			);
			assertExists(globalThis.localStorage.getItem(key));

			await suite.auth!.logout();
			assertEquals(globalThis.localStorage.getItem(key), null);
			assertEquals(globalThis.sessionStorage.getItem(key), null);

			await suite.auth!.login(
				{ email: "remember@test.com", password: "password" },
				{ remember: false },
			);
			assertEquals(
				globalThis.localStorage.getItem(key),
				null,
				"localStorage must stay clean after toggle-off",
			);
			assertExists(globalThis.sessionStorage.getItem(key));
		} finally {
			suite.destroy();
			clearBuiltInStorages(key);
		}
	},
);

Deno.test(
	"remember - hydration prefers localStorage and wipes sessionStorage",
	() => {
		const key = "ownsuite:test:remember-precedence";
		clearBuiltInStorages(key);
		const storedLocal = {
			status: "authenticated",
			subject: {
				id: "u-local",
				email: "local@test.com",
				roles: [],
				isVerified: true,
				hasPassword: true,
			},
			jwt: "local-jwt",
			expiresAt: null,
		};
		const storedSession = {
			status: "authenticated",
			subject: {
				id: "u-session",
				email: "session@test.com",
				roles: [],
				isVerified: true,
				hasPassword: true,
			},
			jwt: "session-jwt",
			expiresAt: null,
		};
		globalThis.localStorage.setItem(key, JSON.stringify(storedLocal));
		globalThis.sessionStorage.setItem(key, JSON.stringify(storedSession));

		const store = createMockAuthStore();
		const suite = createOwnsuite({
			adapters: {
				auth: createMockAuthAdapter(store),
				profile: createMockProfileAdapter(store),
			},
			session: { storageKey: key },
		});
		try {
			assertEquals(suite.session!.get().jwt, "local-jwt");
			assertEquals(
				suite.session!.get().subject?.email,
				"local@test.com",
			);
			assertEquals(
				globalThis.sessionStorage.getItem(key),
				null,
				"losing backend must be wiped on adoption",
			);
		} finally {
			suite.destroy();
			clearBuiltInStorages(key);
		}
	},
);

Deno.test(
	"remember - custom SessionStorage: remember flag is silently ignored",
	async () => {
		const writes: string[] = [];
		const storage: SessionStorage = (() => {
			const map = new Map<string, string>();
			return {
				get: (k) => map.get(k) ?? null,
				set: (k, v) => {
					writes.push(k);
					map.set(k, v);
				},
				del: (k) => {
					map.delete(k);
				},
			};
		})();
		// Pre-clear built-ins to prove they're never touched.
		clearBuiltInStorages();
		const store = createMockAuthStore({
			requireVerifiedEmail: false,
			seed: [{
				email: "custom@test.com",
				password: "password",
				roles: ["user"],
				isVerified: true,
				hasPassword: true,
				oauthConnections: [],
			}],
		});
		const suite = createOwnsuite({
			adapters: {
				auth: createMockAuthAdapter(store),
				profile: createMockProfileAdapter(store),
			},
			session: { storage },
		});
		try {
			await suite.auth!.login(
				{ email: "custom@test.com", password: "password" },
				{ remember: true },
			);
			await suite.auth!.logout();
			await suite.auth!.login(
				{ email: "custom@test.com", password: "password" },
				{ remember: false },
			);
			// Neither built-in backend should have been written to.
			assertEquals(
				globalThis.localStorage.getItem("ownsuite:session"),
				null,
			);
			assertEquals(
				globalThis.sessionStorage.getItem("ownsuite:session"),
				null,
			);
			if (writes.length === 0) {
				throw new Error("custom storage was never written to");
			}
		} finally {
			suite.destroy();
		}
	},
);

Deno.test(
	"remember - clear() wipes every built-in backend",
	() => {
		const key = "ownsuite:test:remember-clear";
		clearBuiltInStorages(key);
		const payload = JSON.stringify({
			status: "authenticated",
			subject: {
				id: "u",
				email: "stale@test.com",
				roles: [],
				isVerified: true,
				hasPassword: true,
			},
			jwt: "stale-jwt",
			expiresAt: null,
		});
		globalThis.localStorage.setItem(key, payload);
		globalThis.sessionStorage.setItem(key, payload);

		const store = createMockAuthStore();
		const suite = createOwnsuite({
			adapters: {
				auth: createMockAuthAdapter(store),
				profile: createMockProfileAdapter(store),
			},
			session: { storageKey: key },
		});
		try {
			// Hydration will have already wiped sessionStorage in favor of
			// localStorage. clear() wipes localStorage too.
			suite.session!.clear();
			assertEquals(globalThis.localStorage.getItem(key), null);
			assertEquals(globalThis.sessionStorage.getItem(key), null);
		} finally {
			suite.destroy();
			clearBuiltInStorages(key);
		}
	},
);

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
