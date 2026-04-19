/**
 * Unit tests for the openOAuthPopup helper.
 *
 * Uses a shim window host so we can simulate the server's postMessage-based
 * callback protocol without a real browser. The host exposes a "post" method
 * the tests call to deliver a message into the listener.
 */

import {
	openOAuthPopup,
	type PopupWindowHandle,
	type PopupWindowHost,
} from "../src/oauth/popup.ts";
import { assertEquals, assertRejects } from "@std/assert";

interface FakeHost extends PopupWindowHost {
	post(message: unknown, origin?: string): void;
	closePopup(): void;
}

function createFakeHost(): FakeHost {
	let listener: ((e: MessageEvent) => void) | null = null;
	const popup: PopupWindowHandle = {
		closed: false,
		close() {
			this.closed = true;
		},
	};
	return {
		open() {
			return popup;
		},
		addEventListener(_type, fn) {
			listener = fn;
		},
		removeEventListener(_type, fn) {
			if (listener === fn) listener = null;
		},
		post(data, origin = "http://localhost") {
			if (listener) {
				listener({ data, origin } as unknown as MessageEvent);
			}
		},
		closePopup() {
			popup.closed = true;
		},
	};
}

Deno.test("openOAuthPopup - resolves on oauth_login_success message", async () => {
	const host = createFakeHost();
	const promise = openOAuthPopup("http://x/init", { host, closedPollMs: 50 });
	queueMicrotask(() => {
		host.post({
			type: "oauth_login_success",
			jwt: "j",
			email: "e@e.com",
			roles: ["user"],
		});
	});
	const msg = await promise;
	if (msg.type !== "oauth_login_success") throw new Error("wrong type");
	assertEquals(msg.jwt, "j");
	assertEquals(msg.email, "e@e.com");
});

Deno.test("openOAuthPopup - resolves on oauth_link_success message", async () => {
	const host = createFakeHost();
	const promise = openOAuthPopup("http://x/init", { host, closedPollMs: 50 });
	queueMicrotask(() => {
		host.post({ type: "oauth_link_success", provider: "google" });
	});
	const msg = await promise;
	if (msg.type !== "oauth_link_success") throw new Error("wrong type");
	assertEquals(msg.provider, "google");
});

Deno.test("openOAuthPopup - rejects on oauth_error message", async () => {
	const host = createFakeHost();
	const promise = openOAuthPopup("http://x/init", { host, closedPollMs: 50 });
	queueMicrotask(() => {
		host.post({ type: "oauth_error", error: "EXAMPLE_ERROR" });
	});
	await assertRejects(() => promise, Error, "EXAMPLE_ERROR");
});

Deno.test("openOAuthPopup - rejects when popup closed without a message", async () => {
	const host = createFakeHost();
	const promise = openOAuthPopup("http://x/init", { host, closedPollMs: 10 });
	queueMicrotask(() => host.closePopup());
	await assertRejects(() => promise, Error, "OAUTH_POPUP_CLOSED");
});

Deno.test("openOAuthPopup - origin mismatch silently drops message", async () => {
	const host = createFakeHost();
	const promise = openOAuthPopup("http://x/init", {
		host,
		closedPollMs: 20,
		expectedOrigin: "http://expected.com",
	});
	// Wrong origin — listener drops it.
	queueMicrotask(() => {
		host.post(
			{ type: "oauth_login_success", jwt: "j", email: "e@e.com" },
			"http://other.com",
		);
		// Then close the popup → rejection path fires.
		setTimeout(() => host.closePopup(), 30);
	});
	await assertRejects(() => promise, Error, "OAUTH_POPUP_CLOSED");
});

Deno.test("openOAuthPopup - rejects with OAUTH_POPUP_BLOCKED when host.open returns null", async () => {
	const blockedHost: PopupWindowHost = {
		open() {
			return null;
		},
		addEventListener() {},
		removeEventListener() {},
	};
	await assertRejects(
		() => openOAuthPopup("http://x", { host: blockedHost }),
		Error,
		"OAUTH_POPUP_BLOCKED",
	);
});

Deno.test("openOAuthPopup - timeout fires when no message arrives", async () => {
	const host = createFakeHost();
	await assertRejects(
		() =>
			openOAuthPopup("http://x/init", {
				host,
				closedPollMs: 0,
				timeoutMs: 30,
			}),
		Error,
		"OAUTH_POPUP_TIMEOUT",
	);
});
