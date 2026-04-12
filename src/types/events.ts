/**
 * @module types/events
 *
 * Event type definitions for the ownsuite event system.
 */

import type { DomainError, DomainState } from "./state.ts";

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
	| "own:row:deleted";

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

/** All event types union. */
export type OwnsuiteEvent =
	| StateChangedEvent
	| ErrorEvent
	| SyncedEvent
	| ListFetchedEvent
	| RowFetchedEvent
	| RowCreatedEvent
	| RowUpdatedEvent
	| RowDeletedEvent;
