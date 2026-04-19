/**
 * @module types/events
 *
 * Event type definitions for the ownsuite event system.
 */

import type { DomainError, DomainState } from "./state.ts";
import type {
	OAuthConnection,
	OAuthProvider,
	SessionState,
} from "./auth.ts";

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

/** State change event. */
export interface StateChangedEvent extends OwnsuiteEventBase {
	type: "domain:state:changed";
	previousState: DomainState;
	newState: DomainState;
}

/** Error event. */
export interface ErrorEvent extends OwnsuiteEventBase {
	type: "domain:error";
	error: DomainError;
}

/** Sync completed event. */
export interface SyncedEvent extends OwnsuiteEventBase {
	type: "domain:synced";
}

/** List fetched event. */
export interface ListFetchedEvent extends OwnsuiteEventBase {
	type: "own:list:fetched";
	count: number;
}

/** Single row fetched event. */
export interface RowFetchedEvent extends OwnsuiteEventBase {
	type: "own:row:fetched";
	rowId: string;
}

/** Row created event. */
export interface RowCreatedEvent extends OwnsuiteEventBase {
	type: "own:row:created";
	rowId: string;
}

/** Row updated event. */
export interface RowUpdatedEvent extends OwnsuiteEventBase {
	type: "own:row:updated";
	rowId: string;
}

/** Row deleted event. */
export interface RowDeletedEvent extends OwnsuiteEventBase {
	type: "own:row:deleted";
	rowId: string;
}

// ─────────────────────── auth / profile / session events ──────────────────

export interface AuthEventBase {
	timestamp: number;
}

export interface AuthRegisterEvent extends AuthEventBase {
	type: "auth:register";
	email: string;
	/** True when the server requires email verification (no auto-login). */
	requiresVerification: boolean;
}

export interface AuthLoginEvent extends AuthEventBase {
	type: "auth:login";
	email: string;
}

export interface AuthLogoutEvent extends AuthEventBase {
	type: "auth:logout";
	/** Id of the subject that just logged out, if known. */
	subjectId?: string;
}

export interface AuthSessionChangedEvent extends AuthEventBase {
	type: "auth:session:changed";
	session: SessionState;
}

export interface AuthVerificationRequiredEvent extends AuthEventBase {
	type: "auth:verification:required";
	email: string;
}

export interface ProfileUpdatedEvent extends AuthEventBase {
	type: "profile:updated";
	email: string;
}

export interface OAuthLinkedEvent extends AuthEventBase {
	type: "oauth:linked";
	connection: OAuthConnection;
}

export interface OAuthUnlinkedEvent extends AuthEventBase {
	type: "oauth:unlinked";
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
