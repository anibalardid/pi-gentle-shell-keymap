#!/usr/bin/env node
/**
 * Link this repository into a Pi agent directory so Pi discovers it as
 * `<agent-dir>/extensions/pi-keymap`.
 *
 *   node scripts/install.mjs                      # ~/.pi/agent
 *   PI_CODING_AGENT_DIR=~/.gentle-shell/agent node scripts/install.mjs
 *
 * Gentle Shell runs with an isolated home, so pass its agent dir explicitly
 * (or run `gentle-shell` first and use the path it prints).
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.GENTLE_PI_AGENT_HOME || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const extensionsDir = join(agentDir, "extensions");
const target = join(extensionsDir, "pi-keymap");

mkdirSync(extensionsDir, { recursive: true });

if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
	rmSync(target, { recursive: true, force: true });
}
symlinkSync(repo, target, "dir");

console.log(`pi-keymap → ${target}`);
console.log(`keymap file: ${join(agentDir, "keymap.json")}`);
