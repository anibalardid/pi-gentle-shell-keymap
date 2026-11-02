import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_BINDINGS,
	dedupeBindings,
	keymapPath,
	loadReservedKeys,
	normalizeKeyId,
	parseKeymap,
	readKeymap,
	reservedKeysFrom,
	resolveAgentDir,
	serializeKeymap,
	validateKey,
	writeKeymap,
} from "../keymap-core.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-keymap-"));
}

test("normalizeKeyId canonicalises modifier order and aliases", () => {
	assert.equal(normalizeKeyId("Ctrl+Shift+P"), "ctrl+shift+p");
	assert.equal(normalizeKeyId("shift+ctrl+p"), "ctrl+shift+p");
	assert.equal(normalizeKeyId("cmd+k"), "super+k");
	assert.equal(normalizeKeyId("option+enter"), "alt+enter");
	assert.equal(normalizeKeyId("esc"), "escape");
	assert.equal(normalizeKeyId("F2"), "f2");
	assert.equal(normalizeKeyId(" ctrl+\\ "), "ctrl+\\");
});

test("normalizeKeyId rejects tokens Pi cannot match", () => {
	assert.equal(normalizeKeyId(""), undefined);
	assert.equal(normalizeKeyId("ctrl+"), undefined);
	assert.equal(normalizeKeyId("hyper+k"), undefined);
	assert.equal(normalizeKeyId("f13"), undefined);
	assert.equal(normalizeKeyId("ctrl+nope"), undefined);
});

test("a literal plus stays a key after a modifier", () => {
	assert.equal(normalizeKeyId("ctrl++"), "ctrl++");
	assert.equal(normalizeKeyId("+"), undefined);
});

test("reservedKeysFrom uses Pi defaults and lets keybindings.json override them", () => {
	const defaults = reservedKeysFrom();
	assert.ok(defaults.has("ctrl+k"), "ctrl+k is reserved (delete to line end)");
	assert.ok(defaults.has("ctrl+p"));
	assert.equal(defaults.has("f2"), false);

	const overridden = reservedKeysFrom({ "tui.editor.deleteToLineEnd": [] });
	assert.equal(overridden.has("ctrl+k"), false);

	const moved = reservedKeysFrom({ "tui.editor.deleteToLineEnd": "ctrl+shift+k" });
	assert.equal(moved.has("ctrl+k"), false);
	assert.ok(moved.has("ctrl+shift+k"));
});

test("loadReservedKeys reads keybindings.json next to the agent dir", () => {
	const dir = tempDir();
	try {
		assert.ok(loadReservedKeys(dir).has("ctrl+k"));
		writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "tui.editor.deleteToLineEnd": [] }));
		assert.equal(loadReservedKeys(dir).has("ctrl+k"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("validateKey rejects reserved, duplicate, and bare typing keys", () => {
	const bindings = [{ key: "f2", command: "gentle:customize" }];
	const reserved = reservedKeysFrom();

	assert.match(validateKey("ctrl+k", { reserved, bindings }) ?? "", /reservada/);
	assert.match(validateKey("f2", { reserved, bindings }) ?? "", /ya está asignada/);
	assert.match(validateKey("a", { reserved, bindings }) ?? "", /tecla de escritura/);
	assert.match(validateKey("space", { reserved, bindings }) ?? "", /tecla de escritura/);
	// Pi ships ctrl+shift+p as app.model.cycleBackward, so the obvious candidate
	// for a palette key is reserved too.
	assert.match(validateKey("ctrl+shift+p", { reserved, bindings }) ?? "", /reservada/);
	assert.equal(validateKey("f3", { reserved, bindings }), undefined);
});

test("validateKey allows re-saving the key being edited", () => {
	const bindings = [{ key: "f2", command: "gentle:customize" }];
	assert.equal(validateKey("f2", { reserved: reservedKeysFrom(), bindings, editing: 0 }), undefined);
});

test("parseKeymap refuses anything that would make the map ambiguous", () => {
	assert.match((parseKeymap(null) as { problem: string }).problem, /objeto JSON/);
	assert.match((parseKeymap({ version: 2, bindings: [] }) as { problem: string }).problem, /version/);
	assert.match((parseKeymap({ version: 1 }) as { problem: string }).problem, /bindings/);
	assert.match(
		(parseKeymap({ version: 1, bindings: [{ key: "ctrl+" }] }) as { problem: string }).problem,
		/necesita key y command/,
	);
	assert.match(
		(parseKeymap({ version: 1, bindings: [{ key: "nope", command: "x" }] }) as { problem: string }).problem,
		/no es una tecla válida/,
	);
});

test("parseKeymap normalises keys and strips a leading slash from commands", () => {
	const parsed = parseKeymap({
		version: 1,
		bindings: [{ key: "Shift+Ctrl+P", command: "/gentle:customize", description: " Customization " }],
	});
	assert.deepEqual(parsed, {
		bindings: [{ key: "ctrl+shift+p", command: "gentle:customize", description: "Customization" }],
	});
});

test("dedupeBindings keeps the first binding for a key", () => {
	const deduped = dedupeBindings([
		{ key: "ctrl+shift+p", command: "a" },
		{ key: "shift+ctrl+p", command: "b" },
		{ key: "f2", command: "c" },
	]);
	assert.deepEqual(deduped, [
		{ key: "ctrl+shift+p", command: "a" },
		{ key: "f2", command: "c" },
	]);
});

test("readKeymap falls back to defaults when the file is missing", () => {
	const dir = tempDir();
	try {
		const loaded = readKeymap(join(dir, "keymap.json"));
		assert.equal(loaded.status, "defaults");
		assert.deepEqual(loaded.bindings, [...DEFAULT_BINDINGS]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readKeymap reports malformed files instead of inventing a map", () => {
	const dir = tempDir();
	const path = join(dir, "keymap.json");
	try {
		writeFileSync(path, "{ not json");
		const broken = readKeymap(path);
		assert.equal(broken.status, "malformed");
		assert.deepEqual(broken.bindings, []);
		assert.match(broken.problem ?? "", /JSON inválido/);

		writeFileSync(path, JSON.stringify({ version: 1, bindings: [{ key: "ctrl+k", command: "x" }] }));
		assert.equal(readKeymap(path).status, "file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeKeymap round-trips and leaves no temp file behind", () => {
	const dir = tempDir();
	const path = join(dir, "nested", "keymap.json");
	try {
		writeKeymap(path, [{ key: "f2", command: "gentle:customize" }]);
		const text = readFileSync(path, "utf8");
		assert.equal(text, serializeKeymap([{ key: "f2", command: "gentle:customize" }]));
		assert.deepEqual(readKeymap(path).bindings, [{ key: "f2", command: "gentle:customize" }]);
		assert.deepEqual(JSON.parse(text).version, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the agent dir follows the runtime, never a hardcoded home", () => {
	assert.equal(resolveAgentDir({ GENTLE_PI_AGENT_HOME: "/tmp/g" } as NodeJS.ProcessEnv), "/tmp/g");
	assert.equal(
		resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/p" } as NodeJS.ProcessEnv),
		"/tmp/p",
	);
	assert.match(keymapPath({ PI_CODING_AGENT_DIR: "/tmp/p" } as NodeJS.ProcessEnv), /\/tmp\/p\/keymap\.json$/);
});
