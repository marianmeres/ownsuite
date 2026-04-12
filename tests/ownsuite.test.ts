import { assert, assertEquals, assertExists } from "@std/assert";
import {
	createMockOwnedCollectionAdapter,
	createOwnsuite,
	OwnedCollectionManager,
} from "../src/mod.ts";

type Row = { model_id: string; data: { label: string } };

Deno.test("createOwnsuite: registers domains and exposes managers", () => {
	const suite = createOwnsuite({
		domains: {
			notes: { adapter: createMockOwnedCollectionAdapter<Row>() },
			addresses: { adapter: createMockOwnedCollectionAdapter<Row>() },
		},
	});
	assertEquals(suite.domainNames().sort(), ["addresses", "notes"]);
	assert(suite.hasDomain("notes"));
	assert(!suite.hasDomain("nope"));
	assert(suite.domain("notes") instanceof OwnedCollectionManager);
});

Deno.test("OwnedCollectionManager: initialize loads seeded rows", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [
			{ model_id: "1", data: { label: "a" } },
			{ model_id: "2", data: { label: "b" } },
		],
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();
	const state = suite.domain<Row>("notes").get();
	assertEquals(state.state, "ready");
	assertEquals(state.data?.rows.length, 2);
});

Deno.test("OwnedCollectionManager: create prepends to list and emits event", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>();
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();

	let createdId: string | null = null;
	suite.on("own:row:created", (e) => {
		if (e.type === "own:row:created") createdId = e.rowId;
	});

	const row = await suite.domain<Row>("notes").create({ data: { label: "new" } });
	assertExists(row);
	assertEquals(row.data.label, "new");
	assertEquals(suite.domain<Row>("notes").getRows()[0].data.label, "new");
	assertExists(createdId);
});

Deno.test("OwnedCollectionManager: update applies optimistic merge", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [{ model_id: "1", data: { label: "old" } }],
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();

	const updated = await suite
		.domain<Row>("notes")
		.update("1", { data: { label: "new" } });
	assertEquals(updated?.data.label, "new");
	assertEquals(suite.domain<Row>("notes").findRow("1")?.data.label, "new");
});

Deno.test("OwnedCollectionManager: delete removes row", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [
			{ model_id: "1", data: { label: "a" } },
			{ model_id: "2", data: { label: "b" } },
		],
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();

	const ok = await suite.domain<Row>("notes").delete("1");
	assert(ok);
	assertEquals(suite.domain<Row>("notes").getRows().length, 1);
	assertEquals(suite.domain<Row>("notes").findRow("1"), undefined);
});

Deno.test("OwnedCollectionManager: failed create rolls back and sets error state", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [{ model_id: "1", data: { label: "a" } }],
		failOn: { create: true },
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();
	const before = suite.domain<Row>("notes").getRows().length;

	const row = await suite.domain<Row>("notes").create({ data: { label: "x" } });
	assertEquals(row, null);
	// list unchanged
	assertEquals(suite.domain<Row>("notes").getRows().length, before);
	// state went to error
	assertEquals(suite.domain<Row>("notes").get().state, "error");
});

Deno.test("OwnedCollectionManager: failed update rolls back list", async () => {
	const adapter = createMockOwnedCollectionAdapter<Row>({
		seed: [{ model_id: "1", data: { label: "old" } }],
		failOn: { update: true },
	});
	const suite = createOwnsuite({ domains: { notes: { adapter } } });
	await suite.initialize();

	await suite.domain<Row>("notes").update("1", { data: { label: "new" } });
	// rolled back to "old"
	assertEquals(suite.domain<Row>("notes").findRow("1")?.data.label, "old");
	assertEquals(suite.domain<Row>("notes").get().state, "error");
});

Deno.test("Ownsuite: setContext propagates to all domains", async () => {
	const a = createMockOwnedCollectionAdapter<Row>();
	const b = createMockOwnedCollectionAdapter<Row>();
	const suite = createOwnsuite({
		context: { subjectId: "x" },
		domains: { one: { adapter: a }, two: { adapter: b } },
	});
	suite.setContext({ subjectId: "y", tenant: "t" });
	assertEquals(suite.domain("one").getContext(), {
		subjectId: "y",
		tenant: "t",
	});
	assertEquals(suite.domain("two").getContext(), {
		subjectId: "y",
		tenant: "t",
	});
});

Deno.test("Ownsuite: registering a duplicate domain throws", () => {
	const suite = createOwnsuite({
		domains: {
			notes: { adapter: createMockOwnedCollectionAdapter<Row>() },
		},
	});
	let err: Error | null = null;
	try {
		suite.registerDomain("notes", {
			adapter: createMockOwnedCollectionAdapter<Row>(),
		});
	} catch (e) {
		err = e as Error;
	}
	assertExists(err);
});

Deno.test("Ownsuite: domain(name) throws for unknown domain", () => {
	const suite = createOwnsuite();
	let err: Error | null = null;
	try {
		suite.domain("nope");
	} catch (e) {
		err = e as Error;
	}
	assertExists(err);
});
