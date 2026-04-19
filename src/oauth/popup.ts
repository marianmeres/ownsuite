/**
 * @module oauth/popup
 *
 * `openOAuthPopup(url)` — opens a popup window at the OAuth init URL and
 * resolves with the postMessage the server's callback page posts back.
 *
 * Server shape (stack-account): the OAuth callback page renders a `<script>`
 * that does `window.opener.postMessage({ type, jwt, email, ... }, "*")`.
 * We listen for those messages, validate the `type` field, and resolve.
 *
 * For tests, an injectable window-like interface lets us shim `postMessage`
 * via a MessageChannel without a real browser.
 */

export interface OAuthPopupLoginMessage {
	type: "oauth_login_success";
	jwt: string;
	email: string;
	roles?: string[];
	isNewAccount?: boolean;
	redirectUrl?: string;
}

export interface OAuthPopupLinkMessage {
	type: "oauth_link_success";
	provider: string;
}

export interface OAuthPopupErrorMessage {
	type: "oauth_error";
	error: string;
}

export type OAuthPopupMessage =
	| OAuthPopupLoginMessage
	| OAuthPopupLinkMessage;

/**
 * Minimal window-like surface we need. Real `Window` satisfies this; tests
 * supply a shim.
 */
export interface PopupWindowHost {
	open(url: string, target: string, features?: string): PopupWindowHandle | null;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
}

export interface PopupWindowHandle {
	closed: boolean;
	focus?(): void;
	close?(): void;
}

export interface OpenOAuthPopupOptions {
	/** Host window — defaults to `globalThis` when running in the browser. */
	host?: PopupWindowHost;
	/** How often to poll for popup-closed-without-message. Default 500ms. */
	closedPollMs?: number;
	/** Hard timeout in ms; 0 disables. Default 0. */
	timeoutMs?: number;
	/** Restrict accepted message origins. Default: no origin check (the
	 *  server's postMessage uses "*" intentionally; origin validation is the
	 *  caller's responsibility if needed). */
	expectedOrigin?: string;
	/** Popup window features string. */
	features?: string;
}

const DEFAULT_FEATURES = "width=500,height=700,noopener=no,noreferrer=no";

/**
 * Open the OAuth popup at `url` and await a success message from it.
 * Rejects if the popup is closed before a message arrives, if the received
 * message is an error, or if the optional timeout fires.
 */
export function openOAuthPopup(
	url: string,
	options: OpenOAuthPopupOptions = {},
): Promise<OAuthPopupMessage> {
	const host = (options.host ?? (globalThis as unknown as PopupWindowHost));
	if (typeof host.open !== "function" || typeof host.addEventListener !== "function") {
		return Promise.reject(
			new Error("openOAuthPopup: host window does not support popups"),
		);
	}
	const features = options.features ?? DEFAULT_FEATURES;
	const closedPollMs = options.closedPollMs ?? 500;

	const popup = host.open(url, "oauth_popup", features);
	if (!popup) {
		return Promise.reject(new Error("OAUTH_POPUP_BLOCKED"));
	}

	return new Promise<OAuthPopupMessage>((resolve, reject) => {
		let settled = false;
		let pollTimer: number | undefined;
		let timeoutTimer: number | undefined;

		const cleanup = () => {
			settled = true;
			host.removeEventListener("message", onMessage);
			if (pollTimer !== undefined) clearInterval(pollTimer);
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
		};

		const onMessage = (event: MessageEvent) => {
			if (settled) return;
			if (
				options.expectedOrigin !== undefined &&
				event.origin !== options.expectedOrigin
			) {
				return; // silently drop mismatched origin messages
			}
			const data = event.data as OAuthPopupMessage | OAuthPopupErrorMessage;
			if (!data || typeof data !== "object" || typeof data.type !== "string") {
				return;
			}
			if (
				data.type === "oauth_login_success" ||
				data.type === "oauth_link_success"
			) {
				cleanup();
				try {
					popup.close?.();
				} catch {
					// ignore
				}
				resolve(data);
				return;
			}
			if (data.type === "oauth_error") {
				cleanup();
				try {
					popup.close?.();
				} catch {
					// ignore
				}
				reject(new Error((data as OAuthPopupErrorMessage).error));
				return;
			}
		};

		host.addEventListener("message", onMessage);

		if (closedPollMs > 0) {
			pollTimer = setInterval(() => {
				if (settled) return;
				if (popup.closed) {
					cleanup();
					reject(new Error("OAUTH_POPUP_CLOSED"));
				}
			}, closedPollMs) as unknown as number;
		}

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				cleanup();
				try {
					popup.close?.();
				} catch {
					// ignore
				}
				reject(new Error("OAUTH_POPUP_TIMEOUT"));
			}, options.timeoutMs) as unknown as number;
		}
	});
}
