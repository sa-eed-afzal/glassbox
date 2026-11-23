import { defineConfig } from "tsup";

/** Node side: protocol core, bridge library, CLI. Runtime deps stay external (pin-drift visible in the tree). */
const node = defineConfig({
	entry: { core: "src/core/index.ts", index: "src/index.ts", cli: "src/cli.ts" },
	format: ["esm"],
	dts: true,
	target: "node20",
	// keep each entry self-contained: the CLI's isMain guard compares import.meta.url to argv[1]
	splitting: false,
	external: ["ws", "zod", "@modelcontextprotocol/sdk"],
});

/** Browser side: the page SDK, fully bundled (zero runtime deps, spec §7.4). */
const browser = defineConfig({
	entry: { glassbox: "sdk/glassbox.ts" },
	format: ["esm"],
	dts: true,
	target: "es2022",
});

export default [node, browser];
