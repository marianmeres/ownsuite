import { npmBuild } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	dependencies: [
		"@marianmeres/clog@^3",
		"@marianmeres/collection-types@^1",
		"@marianmeres/http-utils@^2",
		"@marianmeres/pubsub@^2",
		"@marianmeres/store@^2",
	],
});
