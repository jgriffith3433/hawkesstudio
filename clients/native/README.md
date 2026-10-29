# The native playtest transport: reference runner

The playtest contract v2 lets a runner drive a **desktop build** (Windows, Linux, macOS, Proton) the way
`playtest.run` drives a page. The runner launches the game with `HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token>`; the
game's SDK connects out and the two speak JSON messages. The spec is `docs/playtest.md` ("The native transport").

These files have no dependencies (Node 24):

| File | What |
|---|---|
| `test-runner.mjs` | The reference runner. It launches a build, waits for `hello` and `ready`, plays one scenario and prints the result as JSON. Use it to try a build by hand and to test SDKs. |
| `protocol.mjs` | The runner's side of the protocol: parsing, requests and replies by `id`, what the game pushed, close codes. The production runners in Hawkes Gen can reuse it. |
| `ws-server.mjs` | A minimal WebSocket server (RFC 6455): one path, one client, text frames, ping and close. |
| `test/fake-game.mjs` | A pretend game: the game side of the protocol over Node's built-in WebSocket client. |
| `test/native.test.mjs` | The tests: `node --test clients/native/test/native.test.mjs` |

## Try a build

```bash
node clients/native/test-runner.mjs --scenario smoke -- C:/Builds/MyGame/MyGame.exe
```

Progress goes to stderr: the game's log lines, events and state changes. The result goes to stdout: `outcome`, the
game's `report`, `crashed`, `exitCode`, `events`, `logs` and the last lines of the process output. The exit code is 0
for `won` or `done`, 1 otherwise, and 2 when the game never spoke the protocol (no SDK, or no `Register` call).

Options:
- `--seed`, `--speed`, `--at`: the run's options.
- `--options '{"stage":"x"}'`: content options.
- `--via arg`: pass the address as `--hawkes-playtest=<url>` instead of the environment variable.
- `--timeout <s>`: the run's limit. The default is the scenario's `seconds` x 2, and at least 30 s.
- `--boot <s>`: how long to wait for the game to connect and be ready.
- `--list`: print the game's scenarios.

Arguments after the executable go to the game. For example, `-- MyGame.exe -screen-fullscreen 0` launches a Unity
game windowed.
