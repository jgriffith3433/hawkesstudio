# Hawkes Playtest for Godot 4

The Hawkes playtest contract (v2) for Godot 4.2 and later. Your game registers its scenarios and a bot that plays
through real input. A Hawkes runner launches a desktop build, connects, starts a scenario, watches it and takes the
report. The spec is `hawkesstudio/docs/playtest.md` ("The native transport").

On a normal launch it does nothing: no socket, and `_process` stays off. Ship it in release builds.

## Install

1. Copy `addons/hawkes_playtest/` into your project's `addons/`.
2. Enable it in **Project > Project Settings > Plugins**. That adds the autoload `HawkesPlaytest`.

## Register a bot

```gdscript
func _ready() -> void:
	HawkesPlaytest.register({
		"product": "mygame",                       # your Hawkes Gen project id
		"scenarios": [
			{"id": "smoke", "title": "Boot, menu, first level", "seconds": 45, "tags": ["smoke"]},
			{"id": "story", "title": "The story", "seconds": 300, "starts": ["chapter-2"]},
		],
		"start": _bot,                             # func(id, options, t); may await
		"is_ready": func(): return loaded,         # optional: false while loading
		"stop": func(): pass,                      # optional: release held inputs
		"input": func(action, down): pass,         # optional: the runner's input requests
		"stall_seconds": 60,                       # optional: no progress for this long ends the run as "stuck"
	})

func _bot(id: String, options: Dictionary, t) -> void:
	if t.at != "":
		await load_chapter(t.at)                   # a named start point (options.at)
	t.scene("Main Menu")
	Input.action_press("ui_accept")                # real input, like a player
	if not await t.wait(300): return               # false: the run was stopped
	Input.action_release("ui_accept")
	t.event("level-start", "1")
	if not await t.until(func(): return player.on_floor, 10000, "landing"): return
	t.add("coins")                                 # a counter (counts as progress)
	t.metric("hp", player.hp)                      # a reading (doesn't count as progress)
	t.progress(0.5)
	t.finish("won")                                # or "lost" | "done" | "stuck" | "error"
```

`t` is the `HawkesPlaytest` autoload. It has the same calls as the web helper (`clients/web/hawkes-playtest.js`):
`scene`, `progress`, `note`, `metric`, `add`, `event`, `problem(severity, message)`, `finish`, `wait`, `until` and
`at`. These differ, for GDScript's sake:
- `log_line` instead of `log`, and `run_seed` / `run_speed` instead of `seed` / `speed`, because GDScript has global
  `log()` and `seed()`.
- `wait` and `until` return `false` when the run was stopped (or `until` timed out), instead of throwing. Return from
  the bot when they do.
- A script error in the bot can't be caught. In a debug build Godot stops at it; in a release build the bot just
  ends. If the bot ends without calling `finish`, the run is `done`. If the game hangs, the stall check ends it as
  `stuck`.

Without a runner, you can start a scenario yourself, from the editor or a test, with
`HawkesPlaytest.start_scenario("smoke", {"seed": 1})`. Then read `HawkesPlaytest.state()` and `HawkesPlaytest.report()`,
or wait for the `finished(report)` signal.

## How a runner drives it

The runner starts the game with `HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token>` in the environment, or with the
argument `--hawkes-playtest=<url>`. The argument also works after `--`, where Godot keeps user arguments. `register()`
then connects out to that address with `WebSocketPeer` and speaks the messages in the spec:
- `hello`, `state` (every 500 ms), `event`, `report`, `log`
- `ack` for `start`, `stop`, `input` and `quit`

It keeps processing while the game is paused (`PROCESS_MODE_ALWAYS`). If the runner disconnects, the bot is stopped.

**Log lines** (`print`, `push_error`, script errors) go to the runner on Godot 4.5 and later, through
`log_forwarder.gd` (`OS.add_logger`). Errors during a run are also recorded as problems. Earlier versions send no
log lines. The runner still reads stdout and `godot.log`.

To try a build by hand, run it with the reference runner:

```bash
node hawkesstudio/clients/native/test-runner.mjs --scenario smoke -- ./MyGame.x86_64
```

## Not yet

- **Web exports** (`window.hawkesPlaytest` through `JavaScriptBridge`): use native builds for now.
- **This addon hasn't been run in Godot yet.** It was written without a Godot install on the machine. The protocol
  is tested against the reference runner's fake game; the GDScript is unverified.
