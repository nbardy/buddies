import type { ElectrobunConfig } from "electrobun";

// The app is a shell around the UNMODIFIED Buddies server: `stage/payload` is
// written by tools/desktop-build.mjs (bundled node + server/client/addons) and
// copied to Contents/Resources/app/payload. Build with `pnpm desktop:build`.
export default {
	app: {
		name: "Buddies",
		identifier: "sh.buddies.desktop",
		version: "0.0.1",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/main/index.ts",
		},
		views: {
			tabs: {
				entrypoint: "src/tabs/index.ts",
			},
		},
		copy: {
			"src/loading/index.html": "views/loading/index.html",
			"src/tabs/index.html": "views/tabs/index.html",
			"stage/payload": "payload",
		},
		mac: {
			bundleCEF: true,
			defaultRenderer: "cef",
			createDmg: true,
			// BUDDIES_DESKTOP_CDP=<port> at build time: inspect the window over CDP.
			chromiumFlags: process.env.BUDDIES_DESKTOP_CDP
				? { "remote-debugging-port": process.env.BUDDIES_DESKTOP_CDP }
				: {},
		},
	},
} satisfies ElectrobunConfig;
