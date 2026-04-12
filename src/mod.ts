/**
 * @module @marianmeres/ownsuite
 *
 * Client-side helper library for owner-scoped UIs. Generic domain managers
 * with optimistic updates, Svelte-compatible stores, and adapter-based
 * server sync — mirrors the shape of `@marianmeres/ecsuite` but applies to
 * arbitrary owner-scoped collections instead of hard-coded e-commerce
 * domains.
 *
 * Pairs with the server-side `ownsuite` module in
 * `@marianmeres/stack-common` and the `ownerIdScope` hook in
 * `@marianmeres/collection`.
 *
 * @example
 * ```typescript
 * import { createOwnsuite, createMockOwnedCollectionAdapter } from "@marianmeres/ownsuite";
 *
 * const suite = createOwnsuite({
 *   domains: {
 *     orders: { adapter: myOrdersAdapter },
 *   },
 * });
 * await suite.initialize();
 * suite.domain("orders").subscribe((s) => render(s.data?.rows));
 * await suite.domain("orders").create({ data: { total: 99 } });
 * ```
 */

export * from "./ownsuite.ts";
export * from "./domains/mod.ts";
export * from "./types/mod.ts";
export * from "./adapters/mod.ts";
