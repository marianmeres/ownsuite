/// <reference lib="dom" />
/**
 * Vanilla-JS reference harness for the ownsuite account-lifecycle managers.
 *
 * Intentionally unstyled — the point is to see every verb wired against the
 * public API surface, not to demonstrate UI.
 */

import {
	createOwnsuite,
	createStackAccountAuthAdapter,
	createStackAccountProfileAdapter,
	type OAuthProvider,
	type Ownsuite,
} from "../../src/mod.ts";

const SERVER_URL_KEY = "ownsuite-example:serverUrl";
const SESSION_STORAGE_KEY = "ownsuite-example:session";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`element #${id} not found`);
	return el as T;
};

const serverUrlEl = $<HTMLInputElement>("serverUrl");
const emailEl = $<HTMLInputElement>("email");
const passwordEl = $<HTMLInputElement>("password");
const newPasswordEl = $<HTMLInputElement>("newPassword");
const providerEl = $<HTMLSelectElement>("provider");
const sessionEl = $<HTMLPreElement>("session");
const logEl = $<HTMLDivElement>("log");

let suite: Ownsuite | null = null;
let sessionUnsub: (() => void) | null = null;

function localTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(kind: string, data: unknown): void {
	const line = document.createElement("div");
	const payload = typeof data === "string" ? data : safeStringify(data);
	line.textContent = `[${localTimestamp()}] ${kind} — ${payload}`;
	logEl.appendChild(line);
	logEl.scrollTop = logEl.scrollHeight;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function renderSession(s: unknown): void {
	sessionEl.textContent = JSON.stringify(s, null, 2);
}

function buildSuite(): void {
	const baseUrl = serverUrlEl.value.trim();
	if (!baseUrl) {
		log("error", "server url is empty");
		return;
	}
	localStorage.setItem(SERVER_URL_KEY, baseUrl);

	if (suite) {
		sessionUnsub?.();
		sessionUnsub = null;
		suite.destroy();
		suite = null;
	}

	suite = createOwnsuite({
		adapters: {
			auth: createStackAccountAuthAdapter({ baseUrl }),
			profile: createStackAccountProfileAdapter({ baseUrl }),
		},
		session: {
			storage: "local",
			storageKey: SESSION_STORAGE_KEY,
		},
	});

	suite.onAny(({ event, data }) => log(`event:${event}`, data));
	sessionUnsub = suite.session!.subscribe(renderSession);

	log("info", `suite built against ${baseUrl}`);
}

function requireSuite(): Ownsuite | null {
	if (!suite) {
		log("error", "click 'initialize' first");
		return null;
	}
	return suite;
}

async function run<T>(label: string, fn: () => Promise<T>): Promise<void> {
	log(`action:${label}`, "started");
	try {
		const result = await fn();
		log(`action:${label}`, result ?? "ok");
	} catch (err) {
		const e = err as { message?: string; status?: number; body?: string };
		log(
			`action:${label}:ERROR`,
			e.status ? `${e.status} ${e.message} ${e.body ?? ""}`.trim() : e.message ??
				String(err),
		);
	}
}

// ──────────────────────────── wire buttons ─────────────────────────────────

$("initialize").addEventListener("click", buildSuite);

$("register").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("register", () =>
		s.auth!.register({
			email: emailEl.value,
			password: passwordEl.value,
			password_confirm: passwordEl.value,
		}));
});

$("login").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("login", () =>
		s.auth!.login({ email: emailEl.value, password: passwordEl.value }));
});

$("logout").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("logout", () => s.auth!.logout());
});

$("resendVerify").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("resendVerification", () =>
		s.auth!.resendVerification({ email: emailEl.value }));
});

$("requestReset").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("requestPasswordReset", () =>
		s.auth!.requestPasswordReset({ email: emailEl.value }));
});

$("changePassword").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("changePassword", () =>
		s.auth!.changePassword({
			current_password: passwordEl.value,
			new_password: newPasswordEl.value,
			confirm_password: newPasswordEl.value,
		}));
});

$("deleteAccount").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	if (!globalThis.confirm("Really delete this account? This cannot be undone.")) {
		return;
	}
	run("deleteAccount", () =>
		s.auth!.deleteAccount({ password: passwordEl.value, confirm: true }));
});

$("fetchProfile").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("profile.fetch", () => s.profile!.fetch());
});

$("updateProfile").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("profile.update", () =>
		s.profile!.update({
			email: emailEl.value,
			current_password: passwordEl.value,
		}));
});

$("listOAuth").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("profile.listOAuth", () => s.profile!.listOAuth());
});

$("unlinkOAuth").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("profile.unlinkOAuth", () =>
		s.profile!.unlinkOAuth(providerEl.value as OAuthProvider));
});

$("oauthLogin").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("initiateOAuth:login", () =>
		s.auth!.initiateOAuth(providerEl.value as OAuthProvider, {
			action: "login",
			mode: "popup",
		}));
});

$("oauthLink").addEventListener("click", () => {
	const s = requireSuite();
	if (!s) return;
	run("initiateOAuth:link", () =>
		s.auth!.initiateOAuth(providerEl.value as OAuthProvider, {
			action: "link",
			mode: "popup",
		}));
});

// ──────────────────────────── hydrate on load ──────────────────────────────

const savedUrl = localStorage.getItem(SERVER_URL_KEY);
if (savedUrl) {
	serverUrlEl.value = savedUrl;
	buildSuite();
} else {
	serverUrlEl.value = "/api/account";
	renderSession({ status: "not-connected" });
}
