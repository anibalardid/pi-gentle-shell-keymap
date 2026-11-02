# pi-keymap

User-editable keybindings for [Pi](https://pi.dev) and Gentle Shell, kept in one
JSON file instead of scattered environment variables.

```
/keymap        edit the map   (aliases: /keybindings, /shortcuts)
f2             the default binding it ships (Customization)
```

## Why

Pi owns its keymap. A fixed set of actions is **reserved**, and any extension
shortcut that collides with one is dropped at load time:

```js
// pi/dist/core/extensions/runner.js
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
  "app.interrupt", "app.clear", /* ... */ "tui.editor.deleteToLineEnd",
];
```

`tui.editor.deleteToLineEnd` is `ctrl+k`. So is every obvious palette key: Pi
already ships `ctrl+shift+p` as `app.model.cycleBackward`. Hardcoding a shortcut
in an extension means it works on someone's machine and silently vanishes on
the next one — and it cannot be changed without editing code.

This extension makes the map a file:

- one binding per line, human-editable
- `/keymap` edits it interactively, including a capture screen that shows what
  your terminal actually sends
- saving reloads the session, so new bindings apply immediately
- a binding dispatches a slash command, so anything registered as a command can
  get a key — not just a fixed list of actions

## Install

```sh
node scripts/install.mjs                                      # ~/.pi/agent
PI_CODING_AGENT_DIR=~/.gentle-shell/agent node scripts/install.mjs
```

It links the repository into `<agent-dir>/extensions/pi-keymap`. Gentle Shell
runs with an isolated home, so it needs the second form (the launcher exports
`PI_CODING_AGENT_DIR=~/.gentle-shell/agent`).

Restart Pi or run `/reload`.

## The file

`<agent-dir>/keymap.json` — `~/.pi/agent/keymap.json` for Pi,
`~/.gentle-shell/agent/keymap.json` for Gentle Shell. `GENTLE_PI_AGENT_HOME` and
`PI_CODING_AGENT_DIR` are honoured, in that order.

```json
{
  "version": 1,
  "bindings": [
    { "key": "f2", "command": "gentle:customize", "description": "Customization" },
    { "key": "f3", "command": "gentle:commands",  "description": "Command palette" }
  ]
}
```

- `key` — a Pi key id: `ctrl+…`, `alt+…`, `shift+…`, `super+…`, `f1`–`f12`,
  named keys (`escape`, `enter`, `tab`, `space`, `up`, …) and symbols.
  Modifier order and aliases are normalised (`cmd` → `super`, `option` → `alt`).
- `command` — a slash command **without** the leading slash.
- `description` — optional label shown in `/keymap`.

A malformed file is reported, never overwritten: `/keymap reset` recreates it.

## `/keymap`

Also reachable as `/keybindings` and `/shortcuts`. Pi has no command aliases,
so each spelling is a separate registration of the same handler; `/keybinding`
(singular) autocompletes to `keybindings` because the slash menu matches names
as prefixes. The description also names the other spellings, which is what
Gentle Shell's command palette searches.

```
› f2  /gentle:customize  Customization
  f3  /gentle:commands   Command palette

↑/↓ mover · a agregar · e cambiar tecla · d borrar · r resetear · Esc cerrar
```

- **a** asks for a command, then captures the key you press
- **e** / **Enter** re-captures the highlighted binding's key
- **d** deletes it
- **r** restores the defaults
- **Esc** closes; if anything changed, the file is written and the session reloads

The capture screen validates before accepting a key:

| Rejected | Why |
| --- | --- |
| a key Pi reserves | The extension would never receive it |
| a key already in the map | The map must stay unambiguous |
| a bare letter, `space`, or `tab` | It would swallow ordinary typing |

## What the terminal actually sends

This is the part no extension can fix, only expose. A shortcut only works if
your terminal transmits the combination:

| Sent | Pi sees | When |
| --- | --- | --- |
| `0x10` | `ctrl+p` | `ctrl+shift+p` without the Kitty keyboard protocol |
| `ESC [ 80 ; 6 u` | `ctrl+shift+p` | with the protocol (Ghostty, kitty, or iTerm2's CSI u) |
| `ESC O Q` | `f2` | always |

That is why the defaults are F-keys. `ctrl+shift+…` needs a terminal that
reports modified keys, and `alt+…` needs Option to send Meta — on a Spanish ISO
layout, turning Option into Meta costs you `@`. The capture screen tells you
which one you are actually pressing before it saves anything: press the
combination you want, and if Pi reads something else, the error says so.

## Develop

```sh
node --experimental-strip-types --test test/*.test.ts
node scripts/smoke.mjs        # loads the extension through Pi's real loader
```

`keymap-core.ts` is pure — file format, key canonicalisation, validation — and
carries no Pi imports, so it is testable with plain Node. `index.ts` is only the
extension surface: the two overlays, shortcut registration and the reload.
