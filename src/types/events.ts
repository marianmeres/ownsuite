/**
 * @module types/events
 *
 * Event type definitions for the ownsuite event system.
 */

import type { DomainError, DomainState } from "./state.ts";
import type { OAuthConnection, OAuthProvider, SessionState } from "./auth.ts";

/**
 * Domain identifier in ownsuite is an arbitrary string (the collection name
 * or any label the consumer chose), unlike ecsuite's fixed enum of six
 * domains. Users register their own domains by name.
 */
export type DomainName = string;

/** Event types emitted by the suite. */
export type OwnsuiteEventType =
	| "domain:state:changed"
	| "domain:error"
	| "domain:synced"
	| "own:list:fetched"
	| "own:row:fetched"
	| "own:row:created"
	| "own:row:updated"
	| "own:row:deleted"
	// Auth / profile / session lifecycle — emitted by the new managers.
	| "auth:register"
	| "auth:login"
	| "auth:logout"
	| "auth:session:changed"
	| "auth:verification:required"
	| "profile:updated"
	| "oauth:linked"
	| "oauth:unlinked";

/** Base event data. */
export interface OwnsuiteEventBase {
	/** Event timestamp */
	timestamp: number;
	/** Domain that emitted the event */
	domain: DomainName;
}

/** Emitted when a domain transitions between lifecycle states
 *  (`initializing` → `ready` ↔ `syncing` → `error`). */
export interface StateChangedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "domain:state:changed";
	/** State before the transition. */
	previousState: DomainState;
	/** State after the transition. */
	newState: DomainState;
}

/** Emitted when a domain's mutation or read fails. */
export interface ErrorEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "domain:error";
	/** The failure — normalized across list / get / mutation paths. */
	error: DomainError;
}

/** Emitted when a sync (initialize / refresh / mutation) completes. */
export interface SyncedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "domain:synced";
}

/** Emitted after a successful list read. */
export interface ListFetchedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "own:list:fetched";
	/** Number of rows returned. */
	count: number;
}

/** Emitted after a successful single-row read (`getOne`). */
export interface RowFetchedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "own:row:fetched";
	/** Id of the row that was fetched. */
	rowId: string;
}

/** Emitted after a row is created on the server. */
export interface RowCreatedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "own:row:created";
	/** Server-assigned id of the new row. */
	rowId: string;
}

/** Emitted after a row is updated on the server. */
export interface RowUpdatedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "own:row:updated";
	/** Id of the updated row. */
	rowId: string;
}

/** Emitted after a row is deleted on the server. */
export interface RowDeletedEvent extends OwnsuiteEventBase {
	/** Discriminator. */
	type: "own:row:deleted";
	/** Id of the deleted row. */
	rowId: string;
}

// ─────────────────────── auth / profile / session events ──────────────────

/** Base fields shared by every auth / profile / session event. Unlike
 *  {@link OwnsuiteEventBase} there is no `domain` — these events live at the
 *  suite level, not a specific domain. */
export interface AuthEventBase {
	/** Unix millis at emission time. */
	timestamp: number;
}

/** Emitted after `AuthManager.register` returns a server response. Fires
 *  whether or not the verification gate was hit. */
export interface AuthRegisterEvent extends AuthEventBase {
	/** Discriminator. */
	type: "auth:register";
	/** Email the account was created with. */
	email: string;
	/** True when the server requires email verification (no auto-login). */
	requiresVerification: boolean;
}

/** Emitted after `AuthManager.login` completes a credential exchange. Does
 *  not imply `status === "authenticated"` — the verification gate may still
 *  flip it to `"unverified"` afterwards. */
export interface AuthLoginEvent extends AuthEventBase {
	/** Discriminator. */
	type: "auth:login";
	/** Email used to log in. */
	email: string;
}

/** Emitted on `AuthManager.logout` and `deleteAccount` once the session has
 *  been cleared locally. */
export interface AuthLogoutEvent extends AuthEventBase {
	/** Discriminator. */
	type: "auth:logout";
	/** Id of the subject that just logged out, if known. */
	subjectId?: string;
}

/** Emitted whenever `SessionManager` persists a new state — including
 *  hydration-driven changes and `patchSubject` writes. */
export interface AuthSessionChangedEvent extends AuthEventBase {
	/** Discriminator. */
	type: "auth:session:changed";
	/** Snapshot of the session *after* the change. */
	session: SessionState;
}

/** Emitted when the server rejects login/register because the account is
 *  not yet verified. UI should surface a "check your inbox" prompt. */
export interface AuthVerificationRequiredEvent extends AuthEventBase {
	/** Discriminator. */
	type: "auth:verification:required";
	/** Email that needs to be verified. */
	email: string;
}

/** Emitted after `ProfileManager.update` succeeds. The session subject has
 *  already been patched in place by the time this fires. */
export interface ProfileUpdatedEvent extends AuthEventBase {
	/** Discriminator. */
	type: "profile:updated";
	/** Email on the profile *after* the update. */
	email: string;
}

/** Emitted after a successful OAuth *link* flow (popup / redirect). */
export interface OAuthLinkedEvent extends AuthEventBase {
	/** Discriminator. */
	type: "oauth:linked";
	/** Connection that was just added to the subject's account. */
	connection: OAuthConnection;
}

/** Emitted after `ProfileManager.unlinkOAuth` succeeds. */
export interface OAuthUnlinkedEvent extends AuthEventBase {
	/** Discriminator. */
	type: "oauth:unlinked";
	/** Provider that was just unlinked. */
	provider: OAuthProvider;
}

/** All event types union. */
export type OwnsuiteEvent =
	| StateChangedEvent
	| ErrorEvent
	| SyncedEvent
	| ListFetchedEvent
	| RowFetchedEvent
	| RowCreatedEvent
	| RowUpdatedEvent
	| RowDeletedEvent
	| AuthRegisterEvent
	| AuthLoginEvent
	| AuthLogoutEvent
	| AuthSessionChangedEvent
	| AuthVerificationRequiredEvent
	| ProfileUpdatedEvent
	| OAuthLinkedEvent
	| OAuthUnlinkedEvent;
