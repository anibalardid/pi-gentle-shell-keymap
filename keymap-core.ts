/**
 * Pure core of pi-keymap: file format, key canonicalisation, and validation.
 * No Pi imports live here, so it can be unit tested with plain Node.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface KeymapBinding {
	/** A Pi KeyId, e.g. `ctrl+shift+p` or `f2`. */
	key: string;
	/** Slash command to dispatch, without the leading slash. */
	command: string;
	/** Optional human label shown in `/keymap`. */
	description?: string;
}

export interface KeymapFile {
	version: 1;
	bindings: KeymapBinding[];
}

export type LoadStatus = "file" | "defaults" | "malformed";

export interface LoadedKeymap {
	status: LoadStatus;
	bindings: KeymapBinding[];
	/** Human-readable reason when status is `malformed`. */
	problem?: string;
}

/**
 * Shipped bindings. F-keys on purpose: every terminal delivers them as a plain
 * escape sequence, so they survive layouts, Option-as-Meta settings and the
 * absence of the Kitty keyboard protocol. Modified letters do not — and
 * `ctrl+shift+p`, the obvious candidate, is already Pi's `app.model.cycleBackward`
 * and therefore reserved. `/keymap` replaces these with whatever the terminal
 * actually reports.
 */
export const DEFAULT_BINDINGS: readonly KeymapBinding[] = [
	{ key: "f2", command: "gentle:customize", description: "Customization" },
	{ key: "f3", command: "gentle:commands", description: "Command palette" },
];

/**
 * Actions Pi refuses to hand to an extension, with the keys Pi ships for them.
 * Mirrors RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS in Pi's extension
 * runner. A user binding in keybindings.json replaces the default, which is
 * exactly what Pi itself resolves against.
 */
export const RESERVED_ACTIONS: Readonly<Record<string, string | readonly string[]>> = {
	"app.interrupt": "escape",
	"app.clear": "ctrl+c",
	"app.exit": "ctrl+d",
	"app.suspend": "ctrl+z",
	"app.thinking.cycle": "shift+tab",
	"app.model.cycleForward": "ctrl+p",
	"app.model.cycleBackward": process.platform === "win32" ? "alt+p" : "shift+ctrl+p",
	"app.model.select": "ctrl+l",
	"app.tools.expand": "ctrl+o",
	"app.thinking.toggle": "ctrl+t",
	"app.editor.external": "ctrl+g",
	"app.message.copy": "ctrl+x",
	"app.message.followUp": process.platform === "win32" ? "ctrl+q" : "alt+enter",
	"tui.input.submit": "enter",
	"tui.select.confirm": "enter",
	"tui.select.cancel": ["escape", "ctrl+c"],
	"tui.input.copy": "ctrl+c",
	"tui.editor.deleteToLineEnd": "ctrl+k",
};

const MODIFIER_ALIASES: Record<string, string> = {
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	opt: "alt",
	option: "alt",
	shift: "shift",
	super: "super",
	cmd: "super",
	command: "super",
	meta: "super",
};

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "super"] as const;

const NAMED_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
	"insert", "clear", "home", "end", "pageup", "pagedown", "up", "down",
	"left", "right",
]);

const SYMBOL_KEYS = new Set([
	"`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$",
	"%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function keymapPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveAgentDir(env), "keymap.json");
}

/**
 * Canonicalise a key written by a human into the shape Pi matches against:
 * lowercase, modifiers deduplicated and ordered ctrl, alt, shift, super.
 * Returns undefined when the token is not a key Pi can match.
 */
export function normalizeKeyId(raw: string): string | undefined {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return undefined;

	// `ctrl++` names the literal plus key; everything else splits on `+`.
	const parts = trimmed.endsWith("++")
		? [...trimmed.slice(0, -1).split("+").filter(Boolean), "+"]
		: trimmed.split("+");
	const key = parts.pop();
	if (!key) return undefined;

	const modifiers = new Set<string>();
	for (const part of parts) {
		const modifier = MODIFIER_ALIASES[part];
		if (!modifier) return undefined;
		modifiers.add(modifier);
	}

	const normalizedKey = key === "esc" ? "escape" : key === "return" ? "enter" : key;
	const isLetter = /^[a-z]$/.test(normalizedKey);
	const isDigit = /^[0-9]$/.test(normalizedKey);
	const isFunction = /^f([1-9]|1[0-2])$/.test(normalizedKey);
	if (!isLetter && !isDigit && !isFunction && !NAMED_KEYS.has(normalizedKey) && !SYMBOL_KEYS.has(normalizedKey)) {
		return undefined;
	}

	return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), normalizedKey].join("+");
}

/** Every key currently claimed by an action Pi will not release to extensions. */
export function reservedKeysFrom(config: Record<string, unknown> = {}): Set<string> {
	const reserved = new Set<string>();
	for (const action of Object.keys(RESERVED_ACTIONS)) {
		const value = action in config ? config[action] : RESERVED_ACTIONS[action];
		const keys = Array.isArray(value) ? value : value === undefined ? [] : [value];
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const normalized = normalizeKeyId(key);
			if (normalized) reserved.add(normalized);
		}
	}
	return reserved;
}

/**
 * Reserved keys as Pi will resolve them in this agent directory: the shipped
 * defaults overlaid with `<agent-dir>/keybindings.json`. Unreadable files are
 * ignored here — Pi still owns the decision, this only predicts it.
 */
export function loadReservedKeys(agentDir: string): Set<string> {
	const path = join(agentDir, "keybindings.json");
	let override: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				override = parsed as Record<string, unknown>;
			}
		} catch {
			// Prediction only: a broken keybindings.json is Pi's problem to report.
		}
	}
	return reservedKeysFrom(override);
}

/**
 * Reject a candidate binding with a reason the user can act on.
 * `editing` is the index being replaced, so re-saving an unchanged key is fine.
 */
export function validateKey(
	key: string,
	options: {
		reserved: ReadonlySet<string>;
		bindings: readonly KeymapBinding[];
		editing?: number;
	},
): string | undefined {
	const normalized = normalizeKeyId(key);
	if (!normalized) return `No reconozco "${key}" como una tecla válida.`;

	if (options.reserved.has(normalized)) {
		return `${normalized} está reservada por Pi y una extensión no puede tomarla.`;
	}

	const hasModifier = normalized.includes("+");
	const bare = normalized.replace(/^.*\+/, "");
	if (!hasModifier && (bare.length === 1 || bare === "space" || bare === "tab")) {
		return `${normalized} es una tecla de escritura: sin modificador rompería el editor.`;
	}

	const duplicate = options.bindings.findIndex(
		(binding, index) => index !== options.editing && normalizeKeyId(binding.key) === normalized,
	);
	if (duplicate !== -1) {
		return `${normalized} ya está asignada a /${options.bindings[duplicate]!.command}.`;
	}

	return undefined;
}

export function parseKeymap(raw: unknown): { bindings: KeymapBinding[] } | { problem: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { problem: "el archivo debe ser un objeto JSON" };
	}
	const candidate = raw as { version?: unknown; bindings?: unknown };
	if (candidate.version !== 1) {
		return { problem: "version debe ser 1" };
	}
	if (!Array.isArray(candidate.bindings)) {
		return { problem: "bindings debe ser una lista" };
	}

	const bindings: KeymapBinding[] = [];
	for (const [index, entry] of candidate.bindings.entries()) {
		if (typeof entry !== "object" || entry === null) {
			return { problem: `bindings[${index}] no es un objeto` };
		}
		const item = entry as Record<string, unknown>;
		if (typeof item.key !== "string" || typeof item.command !== "string") {
			return { problem: `bindings[${index}] necesita key y command como texto` };
		}
		const key = normalizeKeyId(item.key);
		if (!key) {
			return { problem: `bindings[${index}].key = "${item.key}" no es una tecla válida` };
		}
		const command = item.command.trim().replace(/^\//, "");
		if (!command) {
			return { problem: `bindings[${index}].command está vacío` };
		}
		bindings.push({
			key,
			command,
			...(typeof item.description === "string" && item.description.trim()
				? { description: item.description.trim() }
				: {}),
		});
	}

	return { bindings };
}

/** Deduplicate by key, first occurrence wins; the map must be unambiguous. */
export function dedupeBindings(bindings: readonly KeymapBinding[]): KeymapBinding[] {
	const seen = new Set<string>();
	const out: KeymapBinding[] = [];
	for (const binding of bindings) {
		const key = normalizeKeyId(binding.key);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ ...binding, key });
	}
	return out;
}

export function readKeymap(path: string): LoadedKeymap {
	if (!existsSync(path)) {
		return { status: "defaults", bindings: dedupeBindings(DEFAULT_BINDINGS) };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			status: "malformed",
			bindings: [],
			problem: `no se pudo leer el archivo (${(error as Error).message})`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			status: "malformed",
			bindings: [],
			problem: `JSON inválido (${(error as Error).message})`,
		};
	}
	const parsed = parseKeymap(raw);
	if ("problem" in parsed) {
		return { status: "malformed", bindings: [], problem: parsed.problem };
	}
	return { status: "file", bindings: dedupeBindings(parsed.bindings) };
}

export function serializeKeymap(bindings: readonly KeymapBinding[]): string {
	const file: KeymapFile = { version: 1, bindings: dedupeBindings(bindings) };
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/** Write through a temp file so a crash never leaves a half-written map. */
export function writeKeymap(path: string, bindings: readonly KeymapBinding[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, serializeKeymap(bindings), "utf8");
	renameSync(temporary, path);
}
