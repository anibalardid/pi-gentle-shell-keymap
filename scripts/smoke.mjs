#!/usr/bin/env node
/**
 * Load the extension through Pi's real extension loader, without starting a
 * session. Proves that discovery, TypeScript import, and registration work
 * before you find out the hard way in a TUI.
 *
 *   node scripts/smoke.mjs [--pi <path-to-pi-coding-agent-package>]
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function resolvePi() {
	const flagIndex = process.argv.indexOf("--pi");
	if (flagIndex !== -1 && process.argv[flagIndex + 1]) return resolve(process.argv[flagIndex + 1]);
	try {
		return dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		// Pi is usually installed globally, so the project cannot resolve it.
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		return join(globalRoot, "@earendil-works", "pi-coding-agent");
	}
}

const piPackage = resolvePi();
const loaderUrl = pathToFileURL(join(piPackage, "dist", "core", "extensions", "loader.js")).href;
const { discoverAndLoadExtensions } = await import(loaderUrl);

const agentDir = mkdtempSync(join(tmpdir(), "pi-keymap-smoke-"));
mkdirSync(join(agentDir, "extensions"), { recursive: true });
symlinkSync(repo, join(agentDir, "extensions", "pi-keymap"), "dir");

process.env.PI_CODING_AGENT_DIR = agentDir;

try {
	const result = await discoverAndLoadExtensions([], repo, agentDir);
	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(`ERROR ${error.path}: ${error.error}`);
		process.exitCode = 1;
	} else {
		const extension = result.extensions.find((entry) => entry.path.includes("pi-keymap"));
		if (!extension) {
			console.error("ERROR: pi-keymap was not discovered");
			process.exitCode = 1;
		} else {
			const commands = [...extension.commands.keys()];
			const shortcuts = [...extension.shortcuts.keys()];
			console.log(`loaded: ${extension.path}`);
			console.log(`commands: ${commands.join(", ") || "(none)"}`);
			console.log(`shortcuts: ${shortcuts.join(", ") || "(none)"}`);
			const missing = ["keymap", "keybindings", "shortcuts"].filter((name) => !commands.includes(name));
			if (missing.length > 0) {
				console.error(`ERROR: missing commands: ${missing.join(", ")}`);
				process.exitCode = 1;
			}
			if (shortcuts.length === 0) {
				console.error("ERROR: no default shortcuts were registered");
				process.exitCode = 1;
			}
		}
	}
	if (result.warnings?.length) {
		for (const warning of result.warnings) console.warn(`WARN ${warning.path}: ${warning.warning}`);
	}
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
