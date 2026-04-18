import { assert, assertEquals } from "@std/assert";
import {
	createMockOwnedCollectionAdapter,
	createOwnsuite,
	type OwnsuiteEvent,
} from "../src/mod.ts";

type Row = { model_id: string; data: { label: string } };

Deno.test(
	"concurrent create + delete: delete does not get resurrected",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [
				{ model_id: "1", data: { label: "a" } },
				{ model_id: "2", data: { label: "b" } },
			],
			delayMs: 20,
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();

		const dom = suite.domain<Row>("notes");
		// Fire both concurrently. Mutations serialize, so whichever is first
		// in the chain runs first — either order MUST preserve the delete.
		const [_created, deleted] = await Promise.all([
			dom.create({ data: { label: "new" } }),
			dom.delete("1"),
		]);
		assert(deleted);
		const ids = dom.getRows().map((r) => r.model_id);
		// Row "1" must be gone, even though create's captured snapshot included it.
		assertEquals(ids.includes("1"), false);
	},
);

Deno.test(
	"concurrent overlapping updates on the same row serialize correctly",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "v0" } }],
			delayMs: 20,
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();
		const dom = suite.domain<Row>("notes");

		await Promise.all([
			dom.update("1", { data: { label: "v1" } }),
			dom.update("1", { data: { label: "v2" } }),
		]);
		// Final state is whichever update ran last on the serialized chain.
		// Both should complete; the row should hold v2 (second in call order).
		assertEquals(dom.findRow("1")?.data.label, "v2");
		assertEquals(dom.get().state, "ready");
	},
);

Deno.test(
	"overlapping refresh calls: newer supersedes older (abort-supersede)",
	async () => {
		// Slow adapter to create an overlap window.
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "a" } }],
			delayMs: 40,
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();
		const dom = suite.domain<Row>("notes");

		// Fire both back-to-back.
		const [a, b] = [dom.refresh(), dom.refresh()];
		await Promise.all([a, b]);
		// Domain must be ready (second refresh completed).
		assertEquals(dom.get().state, "ready");
	},
);

Deno.test(
	"getOne failure does NOT transition domain to error",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "a" } }],
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();
		const dom = suite.domain<Row>("notes");
		assertEquals(dom.get().state, "ready");

		// Ask for a row that doesn't exist — adapter throws.
		const row = await dom.getOne("nonexistent");
		assertEquals(row, null);
		// Critical: list state must remain healthy.
		assertEquals(dom.get().state, "ready");
		assertEquals(dom.get().error, null);
		// List view must still be intact.
		assertEquals(dom.getRows().length, 1);
	},
);

Deno.test("update for absent id does NOT create a phantom row", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [
			{ model_id: "1", data: { label: "a" } },
			{ model_id: "2", data: { label: "b" } },
		],
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();
	const dom = suite.domain<Row>("notes");

	// Seed the mock with a row that's not in the manager's cached list.
	adapter._rows(); // just to touch the exposed store
	const result = await dom.update("99", { data: { label: "ghost" } });
	// Update throws in the adapter (row 99 not in store) → rollback, state=error.
	assertEquals(result, null);
	// List unchanged — no phantom row.
	assertEquals(dom.getRows().length, 2);
	assertEquals(dom.findRow("99"), undefined);
});

Deno.test(
	"update for id present in server but NOT in cached list emits event without inserting",
	async () => {
		// Adapter stores row "x" but the manager's cache won't include it
		// because we'll register an empty list then seed the mock afterwards.
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "a" } }],
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();
		const dom = suite.domain<Row>("notes");

		// Inject a row into the mock store without the manager knowing.
		// Easiest path: use the mock's internal via create (which adds both
		// server-side and through the manager). Instead: subvert by calling
		// adapter directly.
		await adapter.create(
			{ data: { label: "z" } } as Partial<Row>,
			{ signal: new AbortController().signal },
		);
		// manager's cache still has only model_id "1"; the mock has 2 rows.
		const mockRows = adapter._rows();
		assertEquals(mockRows.length, 2);
		const hiddenId = mockRows.find((r) => r.model_id !== "1")!.model_id;

		let seenUpdated = false;
		suite.on("own:row:updated", () => {
			seenUpdated = true;
		});

		const result = await dom.update(hiddenId, { data: { label: "zz" } });
		// Server succeeded.
		assert(result !== null);
		// But the row was absent from the cached list — no phantom insert.
		assertEquals(dom.getRows().length, 1);
		assertEquals(dom.findRow(hiddenId), undefined);
		// Event still emitted (server confirmed the update).
		assert(seenUpdated);
	},
);

Deno.test("reset() emits domain:state:changed", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [{ model_id: "1", data: { label: "a" } }],
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();

	const events: OwnsuiteEvent[] = [];
	suite.on("domain:state:changed", (e) => {
		if (e.type === "domain:state:changed") events.push(e);
	});

	suite.domain<Row>("notes").reset();
	const hit = events.find(
		(e) => e.type === "domain:state:changed" && e.newState === "initializing",
	);
	assert(hit, "reset() must emit a state-changed event to `initializing`");
});

Deno.test("destroy() aborts in-flight refresh and marks destroyed", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [{ model_id: "1", data: { label: "a" } }],
		delayMs: 60,
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	const dom = suite.domain<Row>("notes");

	// Start a refresh that will be aborted.
	const p = dom.refresh();
	// Tick briefly then destroy.
	await new Promise((r) => setTimeout(r, 5));
	suite.destroy();
	await p;
	// Destroyed suite: managers are destroyed, no crash.
	assertEquals(dom.isDestroyed, true);
	assertEquals(suite.isDestroyed, true);
});

Deno.test(
	"suite.hasErrors() and suite.errors() reflect domain error state",
	async () => {
		const ok = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "a" } }],
		});
		const bad = createMockOwnedCollectionAdapter<Row>({
			failOn: { list: true },
		});
		const suite = createOwnsuite({
			domains: { good: { adapter: ok }, broken: { adapter: bad } },
		});
		await suite.initialize();

		assert(suite.hasErrors());
		const errs = suite.errors();
		assertEquals(Object.keys(errs), ["broken"]);
		assertEquals(errs.broken?.operation, "initialize");
	},
);

Deno.test("setContext({ replace: true }) replaces context wholesale", () => {
	const suite = createOwnsuite({
		context: { subjectId: "x", tenant: "t1" },
		domains: { notes: { adapter: createMockOwnedCollectionAdapter<Row>() } },
	});
	suite.setContext({ subjectId: "y" }, { replace: true });
	assertEquals(suite.getContext(), { subjectId: "y" });
	assertEquals(suite.domain("notes").getContext(), { subjectId: "y" });
});

Deno.test(
	"setContext({ refresh: true }) triggers refresh on every domain",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "a" } }],
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();
		const dom = suite.domain<Row>("notes");

		let fetchCount = 0;
		suite.on("own:list:fetched", () => {
			fetchCount++;
		});
		suite.setContext({ subjectId: "new" }, { refresh: true });
		// fire-and-forget; wait for microtasks
		await new Promise((r) => setTimeout(r, 10));
		assert(fetchCount >= 1);
		assertEquals(dom.get().state, "ready");
	},
);

Deno.test(
	"initialize(['typo']) logs a warning and does not throw",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>();
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		// should not throw on an unknown name
		await suite.initialize(["notes", "nope"]);
		assertEquals(suite.hasDomain("nope"), false);
	},
);

Deno.test("mock adapter rejects create payloads containing model_id", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>();
	let caught: Error | null = null;
	try {
		await adapter.create(
			{ model_id: "forged", data: { label: "x" } } as Partial<Row>,
			{ signal: new AbortController().signal },
		);
	} catch (e) {
		caught = e as Error;
	}
	assert(caught, "mock must reject client-supplied model_id");
});

Deno.test(
	"defaultGetRowId rejects empty-string ids",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>();
		// A fresh suite on which we call update against an id of "" — the
		// manager uses the caller-passed id directly, not defaultGetRowId,
		// so exercise the row-side path via seed instead.
		let caught: Error | null = null;
		try {
			createMockOwnedCollectionAdapter<Row>({
				seed: [{ model_id: "", data: { label: "empty" } }],
			});
		} catch (e) {
			caught = e as Error;
		}
		assert(caught, "empty-string model_id must be rejected");
		// Confirm adapter itself is still constructible when seed omitted.
		assert(adapter);
	},
);

Deno.test(
	"ctx.signal aborts an in-flight list via abort-supersede",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [{ model_id: "1", data: { label: "a" } }],
			delayMs: 80,
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		const dom = suite.domain<Row>("notes");

		// Start initialize, then fire refresh which supersedes it.
		const initP = dom.initialize();
		await new Promise((r) => setTimeout(r, 10));
		const refreshP = dom.refresh();
		await Promise.all([initP, refreshP]);
		// Should end in ready, not error — the superseded init must not have
		// written a late error to the store.
		assertEquals(dom.get().state, "ready");
	},
);

Deno.test(
	"refresh interleaved with update: no phantom, final state coherent",
	async () => {
		const adapter = createMockOwnedCollectionAdapter<Row>({
			seed: [
				{ model_id: "1", data: { label: "v0" } },
				{ model_id: "2", data: { label: "other" } },
			],
			delayMs: 20,
		});
		const suite = createOwnsuite({ domains: { notes: { adapter } } });
		await suite.initialize();
		const dom = suite.domain<Row>("notes");

		// Kick off update + refresh. They should serialize the update,
		// abort-supersede on the refresh, and end in a state where row 1
		// has the updated label (update wins since it was serialized before
		// the final refresh landed).
		await Promise.all([
			dom.update("1", { data: { label: "v1" } }),
			dom.refresh(),
		]);
		// Either v1 (update landed after refresh) or v0 (refresh landed after
		// update applied server-side) — but the mock sequences mutations
		// through the same store so the end state should reflect v1.
		assertEquals(dom.findRow("1")?.data.label, "v1");
		// Row 2 must still be present — neither op removed it.
		assert(dom.findRow("2"));
	},
);
