/**
 * pi-keymap — user-editable keybindings for Pi and Gentle Shell.
 *
 * Why this exists: Pi owns its keymap. A handful of actions are *reserved*, and
 * any extension shortcut that collides with one is dropped at load time, so a
 * key you cannot rebind is a key you cannot trust. This extension moves the
 * whole map into one JSON file next to Pi's agent directory: the file is the
 * source of truth, `/keymap` edits it, and saving reloads the session so the new
 * bindings take effect immediately.
 *
 * The file lives in `<agent-dir>/keymap.json` — `~/.pi/agent` for Pi and
 * `~/.gentle-shell/agent` for Gentle Shell, because the launcher exports
 * PI_CODING_AGENT_DIR. Nothing is hardcoded to one home.
 *
 * A binding dispatches a slash command exactly as if you had typed it, so the
 * map is not tied to a fixed action list: anything registered as a command can
 * get a key.
 */

import { parseKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_BINDINGS,
	dedupeBindings,
	keymapPath,
	loadReservedKeys,
	normalizeKeyId,
	readKeymap,
	reservedKeysFrom,
	resolveAgentDir,
	validateKey,
	writeKeymap,
	type KeymapBinding,
} from "./keymap-core.ts";

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

interface ListIntent {
	kind: "add" | "edit" | "delete" | "reset";
	index: number;
}

interface ThemeLike {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

interface KeybindingsLike {
	matches(data: string, keybinding: string): boolean;
	getEffectiveConfig(): Record<string, unknown>;
}

const LIST_HINT = "↑/↓ mover · a agregar · e cambiar tecla · d borrar · r resetear · Esc cerrar";

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

class KeymapList {
	private index = 0;

	constructor(
		private readonly bindings: readonly KeymapBinding[],
		private readonly path: string,
		private readonly note: string | undefined,
		private readonly theme: ThemeLike,
		private readonly done: (intent: ListIntent | null) => void,
	) {}

	render(width: number): string[] {
		const lines = [
			this.theme.fg("accent", this.theme.bold("✿ keymap")),
			truncate(this.theme.fg("muted", this.path), width),
		];
		if (this.note) lines.push(truncate(this.theme.fg("muted", this.note), width));
		lines.push("");

		if (this.bindings.length === 0) {
			lines.push(this.theme.fg("muted", "  (sin atajos)"));
		} else {
			const keyWidth = Math.max(...this.bindings.map((binding) => binding.key.length), 4);
			for (const [index, binding] of this.bindings.entries()) {
				const selected = index === this.index;
				const pointer = selected ? this.theme.fg("accent", "› ") : "  ";
				const key = this.theme.fg(selected ? "accent" : "text", binding.key.padEnd(keyWidth));
				const command = this.theme.fg(selected ? "accent" : "muted", `/${binding.command}`);
				const label = binding.description ? this.theme.fg("muted", `  ${binding.description}`) : "";
				lines.push(truncate(`${pointer}${key}  ${command}${label}`, width));
			}
		}

		lines.push("");
		lines.push(truncate(this.theme.fg("muted", LIST_HINT), width));
		return lines;
	}

	handleInput(data: string): void {
		const pressed = parseKey(data);
		if (!pressed) return;

		if (pressed === "up" || pressed === "k") {
			this.move(-1);
			return;
		}
		if (pressed === "down" || pressed === "j") {
			this.move(1);
			return;
		}
		if (pressed === "escape" || pressed === "q") {
			this.done(null);
			return;
		}
		if (pressed === "a") this.done({ kind: "add", index: this.index });
		else if (pressed === "e" || pressed === "enter") this.done({ kind: "edit", index: this.index });
		else if (pressed === "d") this.done({ kind: "delete", index: this.index });
		else if (pressed === "r") this.done({ kind: "reset", index: this.index });
	}

	invalidate(): void {}

	private move(delta: number): void {
		if (this.bindings.length === 0) return;
		this.index = (this.index + delta + this.bindings.length) % this.bindings.length;
	}
}

class KeyCapture {
	private error: string | undefined;
	private reserved: ReadonlySet<string> | undefined;

	constructor(
		private readonly label: string,
		private readonly theme: ThemeLike,
		private readonly keybindings: KeybindingsLike,
		private readonly validate: (key: string) => string | undefined,
		private readonly done: (key: string | null) => void,
	) {}

	render(width: number): string[] {
		const lines = [
			truncate(this.theme.fg("accent", this.theme.bold(`✿ nueva tecla para ${this.label}`)), width),
			"",
			truncate(this.theme.fg("muted", "Presioná la combinación. Esc cancela."), width),
		];
		if (this.error) {
			lines.push("");
			lines.push(truncate(this.theme.fg("error", this.error), width));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(null);
			return;
		}
		const key = parseKey(data);
		if (!key) {
			this.error = "Esa tecla no llega como un atajo reconocible.";
			return;
		}
		// The injected manager is Pi's live resolution, so this is exact even
		// when the user overrode a default in keybindings.json.
		this.reserved ??= reservedKeysFrom(this.keybindings.getEffectiveConfig());
		const problem = this.validate(key);
		if (problem) {
			this.error = problem;
			return;
		}
		this.done(normalizeKeyId(key) ?? key);
	}

	invalidate(): void {}
}

async function openList(
	ctx: ExtensionCommandContext,
	bindings: readonly KeymapBinding[],
	path: string,
	note: string | undefined,
): Promise<ListIntent | null> {
	return ctx.ui.custom<ListIntent | null>(
		(_tui, theme, _keybindings, done) =>
			new KeymapList(bindings, path, note, theme as unknown as ThemeLike, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "80%" } },
	);
}

async function captureKey(
	ctx: ExtensionCommandContext,
	label: string,
	validate: (key: string) => string | undefined,
): Promise<string | null> {
	return ctx.ui.custom<string | null>(
		(_tui, theme, keybindings, done) =>
			new KeyCapture(
				label,
				theme as unknown as ThemeLike,
				keybindings as unknown as KeybindingsLike,
				validate,
				done,
			),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 44 } },
	);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function keymapExtension(pi: ExtensionAPI): void {
	const env = process.env;
	const path = keymapPath(env);
	const loaded = readKeymap(path);

	// Predict Pi's reserved set once at load: shipped defaults plus the user's
	// keybindings.json. The capture UI re-reads the live manager, which is exact.
	const reserved = loadReservedKeys(resolveAgentDir(env));

	const active = dedupeBindings(loaded.bindings);
	const skipped = active.filter((binding) => reserved.has(binding.key));

	for (const binding of active) {
		// Registering a reserved key is useless: Pi filters it and warns. Skip it
		// here so the message below names the file the user can fix.
		if (reserved.has(binding.key)) continue;
		pi.registerShortcut(binding.key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: binding.description ?? `Run /${binding.command}`,
			handler: () => {
				pi.sendUserMessage(`/${binding.command}`, { expandPromptTemplates: true });
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (loaded.status === "malformed") {
			ctx.ui.notify(`keymap.json inválido: ${loaded.problem}. Usá /keymap reset para recrearlo.`, "warning");
			return;
		}
		if (skipped.length > 0) {
			const list = skipped.map((binding) => `${binding.key} (/${binding.command})`).join(", ");
			ctx.ui.notify(`keymap: Pi reserva ${list}; cambialo con /keymap.`, "warning");
		}
	});

	const openKeymap = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (args.trim() === "reset") {
			writeKeymap(path, DEFAULT_BINDINGS);
			ctx.ui.notify("keymap.json recreado con los atajos por defecto.", "info");
			await ctx.reload();
			return;
		}
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify(`keymap.json: ${path}`, "info");
			return;
		}
		if (loaded.status === "malformed") {
			ctx.ui.notify(`keymap.json inválido: ${loaded.problem}. Usá /keymap reset.`, "error");
			return;
		}

		let bindings = dedupeBindings(loaded.bindings);
		let dirty = false;
		let note = loaded.status === "defaults" ? "todavía sin archivo: se guarda al cambiar algo" : undefined;

		for (;;) {
			const intent = await openList(ctx, bindings, path, note);
			if (!intent) break;
			note = undefined;

			if (intent.kind === "reset") {
				bindings = dedupeBindings(DEFAULT_BINDINGS);
				dirty = true;
				note = "atajos por defecto restaurados";
				continue;
			}

			if (intent.kind === "delete") {
				const target = bindings[intent.index];
				if (!target) continue;
				bindings = bindings.filter((_, index) => index !== intent.index);
				dirty = true;
				note = `borrado ${target.key}`;
				continue;
			}

			if (intent.kind === "edit") {
				const target = bindings[intent.index];
				if (!target) continue;
				const key = await captureKey(ctx, `/${target.command}`, (candidate) =>
					validateKey(candidate, { reserved, bindings, editing: intent.index }),
				);
				if (!key) continue;
				bindings = bindings.map((binding, index) => (index === intent.index ? { ...binding, key } : binding));
				dirty = true;
				note = `${target.key} → ${key}`;
				continue;
			}

			const answer = await ctx.ui.input("Comando a vincular (sin la barra)", "gentle:customize");
			if (!answer || !answer.trim()) continue;
			const command = answer.trim().replace(/^\//, "");
			const known = pi.getCommands().some((entry) => entry.name === command);
			const key = await captureKey(ctx, `/${command}`, (candidate) =>
				validateKey(candidate, { reserved, bindings }),
			);
			if (!key) continue;
			bindings = [
				...bindings,
				{ key, command, ...(known ? {} : { description: "comando no registrado" }) },
			];
			dirty = true;
			note = `${key} → /${command}`;
		}

		if (!dirty) return;
		try {
			writeKeymap(path, bindings);
		} catch (error) {
			ctx.ui.notify(`No pude guardar keymap.json: ${(error as Error).message}`, "error");
			return;
		}
		ctx.ui.notify(`keymap.json guardado (${bindings.length} atajos).`, "info");
		await ctx.reload();
	};

	// Pi has no command aliases: every spelling is its own registration. The
	// slash menu autocompletes by name only, so `/keybinding` finds
	// `keybindings` as a prefix; the description carries the extra words for
	// hosts that do search it (Gentle Shell's palette does).
	const description = "Atajos de teclado (keymap · keybinding · shortcuts): editar keymap.json";
	for (const name of ["keymap", "keybindings", "shortcuts"]) {
		pi.registerCommand(name, { description, handler: openKeymap });
	}
}
