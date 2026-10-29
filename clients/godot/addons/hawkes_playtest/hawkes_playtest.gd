extends Node
## The Hawkes playtest contract v2 for Godot 4 (spec: hawkesstudio/docs/playtest.md).
##
## Added as the autoload "HawkesPlaytest" by the plugin. At startup, register the scenarios and a bot that plays
## through real input (Input.parse_input_event / Input.action_press, like a player):
##
##   func _ready() -> void:
##       HawkesPlaytest.register({
##           "product": "mygame",
##           "scenarios": [
##               {"id": "smoke", "title": "Boot, menu, first level", "seconds": 45, "tags": ["smoke"]},
##               {"id": "story", "title": "The story", "seconds": 300, "starts": ["chapter-2"]},
##           ],
##           "start": _bot,                         # func(id, options, t) -> void; may await
##           "is_ready": func(): return loaded,     # optional
##           "stop": func(): bot_stop(),            # optional
##           "input": func(action, down): ...,      # optional: the runner's input requests
##       })
##
##   func _bot(id: String, options: Dictionary, t) -> void:
##       if t.at: await load_chapter(t.at)    # a named start point (options.at); none: from the start
##       t.scene("Main Menu")
##       Input.action_press("ui_accept")
##       if not await t.wait(500): return     # false: the run was stopped
##       t.event("level-start", "1")
##       t.add("coins")                        # counters; t.metric("hp", 80) sets a reading
##       t.progress(0.5)
##       t.finish("won")                       # or "lost" | "done" | "stuck" | "error"
##
## A native runner launches the game with HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token> (or the argument
## --hawkes-playtest=<url>, also after `--`); register() then connects out to it with WebSocketPeer. Without either,
## nothing connects and _process stays off. start_scenario() runs one directly (the editor, tests).

const CONTRACT_VERSION := 2
const SDK := "hawkes_playtest@0.1.0"
const ADDRESS_VARIABLE := "HAWKES_PLAYTEST"
const ADDRESS_ARGUMENT := "--hawkes-playtest"
const MAX_MESSAGE := 1024 * 1024
const LOGS_PER_SECOND := 200
const OUTCOMES := ["won", "lost", "done", "stuck", "error"]

## Emitted when a run finishes (any outcome), with its report.
signal finished(report: Dictionary)

var product := ""
var stall_seconds := 60.0

var _scenarios: Array = []
var _start := Callable()
var _is_ready := Callable()
var _stop := Callable()
var _input := Callable()
var _run = null # Dictionary while a run exists (finished ones stay until the next start, for report())
var _serial := 0

var _socket: WebSocketPeer = null
var _address := ""
var _connect_deadline := 0.0
var _retry_at := 0.0
var _was_open := false
var _hello_sent := false
var _next_state := 0.0
var _last_status := ""

var _fps_frames := 0
var _fps_time := 0.0
var _fps := 0.0
var _fps_samples: Array = []

var _log_mutex := Mutex.new()
var _log_queue: Array = []
var _log_second := 0
var _log_count := 0
var _log_dropped := 0
var _logger = null


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS # keeps talking to the runner while the game is paused
	set_process(false) # nothing per frame until a run starts or a runner is connected


# ---- registering and the runner's address ---------------------------------------------------------------------

## Registers the game's scenarios and bot. Call once at startup (calling again replaces them).
func register(options: Dictionary) -> void:
	if not options.has("product") or not options.has("scenarios") or not options.has("start"):
		push_error("HawkesPlaytest.register needs product, scenarios and start")
		return
	product = str(options.product)
	_scenarios = options.scenarios
	_start = options.start
	_is_ready = options.get("is_ready", Callable())
	_stop = options.get("stop", Callable())
	_input = options.get("input", Callable())
	stall_seconds = float(options.get("stall_seconds", 60.0))
	if _socket != null:
		if _socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
			_send(_hello()) # registered again: new scenarios
		return
	_address = native_address()
	if _address == "":
		return
	if not (_address.begins_with("ws://") or _address.begins_with("wss://")):
		push_warning("[HawkesPlaytest] %s is not a ws:// address; playing without the runner" % ADDRESS_VARIABLE)
		_address = ""
		return
	_connect_deadline = _now() + 10.0
	_open_socket()
	_install_logger()
	set_process(true)


## The runner's address from the command line (the argument wins) or the environment; "" for a normal launch.
static func native_address() -> String:
	var args := Array(OS.get_cmdline_args()) + Array(OS.get_cmdline_user_args())
	for i in args.size():
		var a: String = args[i]
		if a.begins_with(ADDRESS_ARGUMENT + "="):
			var v := a.substr(ADDRESS_ARGUMENT.length() + 1)
			if v != "":
				return v
		elif a == ADDRESS_ARGUMENT and i + 1 < args.size() and str(args[i + 1]) != "":
			return str(args[i + 1])
	return OS.get_environment(ADDRESS_VARIABLE)


## True while a native runner is connected.
func native_connected() -> bool:
	return _socket != null and _socket.get_ready_state() == WebSocketPeer.STATE_OPEN


# ---- the API a runner drives (the same as the page's window.hawkesPlaytest) ------------------------------------

func scenarios() -> Array:
	return _scenarios.duplicate(true)


## Starts a scenario now (from the runner, the editor or a test). Stops any run in progress. Returns false for an
## unknown scenario (the run then finishes at once as "error", as in a page).
func start_scenario(id: String, options: Dictionary = {}) -> bool:
	if not _start.is_valid():
		push_error("HawkesPlaytest.register was not called")
		return false
	if _run != null and not _run.done:
		stop()
	var opts := {"seed": 1, "speed": 1}
	opts.merge(options, true)
	_serial += 1
	_run = {
		"serial": _serial, "id": id, "options": opts, "t0": _now(), "moved": _now(), "done": false, "seconds": -1.0,
		"state": {"ready": true, "status": "running", "progress": 0.0},
		"metrics": {}, "events": [], "problems": [], "log": [],
	}
	_fps_samples.clear()
	set_process(true)
	if not _has_scenario(id):
		problem("bug", "no playtest scenario \"%s\"" % id)
		finish("error")
		return false
	event("start", id)
	var a = opts.get("at")
	if a != null and str(a) != "":
		event("start-at", str(a))
	_play(_serial, id, opts)
	return true


func stop() -> void:
	if _run != null and not _run.done:
		finish("done")
	if _stop.is_valid():
		_stop.call()


func state() -> Dictionary:
	var ready := true
	if _is_ready.is_valid():
		ready = bool(_is_ready.call())
	if _run == null:
		var idle := {"ready": ready, "status": "idle"}
		if _fps > 0:
			idle.fps = roundf(_fps)
		return idle
	var s: Dictionary = _run.state.duplicate()
	s.ready = ready
	if _fps > 0:
		s.fps = roundf(_fps)
	s.metrics = _run.metrics.duplicate()
	return s


func report():
	if _run == null:
		return null
	var metrics: Dictionary = _run.metrics.duplicate()
	if not _fps_samples.is_empty():
		var total := 0.0
		var worst: float = _fps_samples[0]
		for f in _fps_samples:
			total += f
			worst = minf(worst, f)
		metrics.fpsAverage = roundf(total / _fps_samples.size())
		metrics.fpsWorst = worst
	return {
		"scenario": _run.id,
		"outcome": _run.state.status if _run.done else "stuck",
		"seconds": _round1(_run.seconds if _run.done else _t()),
		"metrics": metrics,
		"events": _run.events.duplicate(true),
		"problems": _run.problems.duplicate(true),
		"log": _run.log.duplicate(),
	}


# ---- the tracker the bot reports through (passed as `t`; the same names as the web helper) ---------------------

func scene(name: String) -> void:
	if _run != null and _run.state.get("scene") != name:
		_run.state.scene = name
		event("scene", name)


func progress(p: float) -> void:
	if _run != null:
		_run.state.progress = clampf(p, 0.0, 1.0)
		_run.moved = _now()


func note(text: String) -> void:
	if _run != null:
		_run.state.note = text


## A reading (hp, size): unlike progress, add and event it doesn't count as progress for the softlock check.
func metric(name: String, value: float) -> void:
	if _run != null:
		_run.metrics[name] = value


func add(name: String, n: float = 1.0) -> void:
	if _run != null:
		_run.metrics[name] = float(_run.metrics.get(name, 0.0)) + n
		_run.moved = _now()


func event(type: String, detail = null) -> void:
	if _run == null or _run.done:
		return
	var e := {"t": _round1(_t()), "type": type}
	if detail != null:
		e.detail = str(detail)
	_run.events.append(e)
	if _run.events.size() > 2000:
		_run.events = _run.events.slice(_run.events.size() - 2000)
	_run.moved = _now()
	_send({"type": "event", "event": e})


func problem(severity: String, message: String) -> void:
	if _run == null:
		return
	for p in _run.problems:
		if p.message == message:
			return
	_run.problems.append({"severity": severity, "message": message})
	event("problem", "%s: %s" % [severity, message])


## A line for the report's log (log_line, not log: GDScript has a global log()).
func log_line(line: String) -> void:
	if _run != null:
		_run.log.append("%.1fs %s" % [_t(), line])
		if _run.log.size() > 200:
			_run.log.pop_front()


func finish(outcome: String = "done") -> void:
	if _run == null or _run.done:
		return
	if not OUTCOMES.has(outcome):
		outcome = "done"
	event("finish", outcome)
	_run.done = true
	_run.state.status = outcome
	_run.seconds = _t()
	var r = report()
	if native_connected():
		_send_state(null)
		_send({"type": "report", "report": r})
	finished.emit(r)


## options.seed (run_seed, not seed: GDScript has a global seed()).
var run_seed: int:
	get:
		return int(_run.options.get("seed", 0)) if _run != null else 0

var run_speed: float:
	get:
		return float(_run.options.get("speed", 1)) if _run != null else 1.0

## options.at, the named start point, or "" (play from the start).
var at: String:
	get:
		if _run == null or _run.options.get("at") == null:
			return ""
		return str(_run.options.at)

var running: bool:
	get:
		return _run != null and not _run.done


## Waits ms of real time. Returns false if the run was stopped meanwhile: return from the bot then.
func wait(ms: float) -> bool:
	var serial := _serial
	await get_tree().create_timer(ms / 1000.0, true, false, true).timeout
	return _run != null and _run.serial == serial and not _run.done


## Waits until test.call() is true (checked every frame). On timeout: a problem, the run finishes "stuck", false.
func until(test: Callable, timeout_ms: float = 30000.0, what: String = "condition") -> bool:
	var serial := _serial
	var end := _now() + timeout_ms / 1000.0
	while _run != null and _run.serial == serial and not _run.done:
		if bool(test.call()):
			return true
		if _now() > end:
			problem("bug", "timed out waiting for %s" % what)
			finish("stuck")
			return false
		await get_tree().process_frame
	return false


# ---- the frame loop ---------------------------------------------------------------------------------------------

func _process(delta: float) -> void:
	_fps_frames += 1
	_fps_time += delta
	if _fps_time >= 1.0:
		_fps = Engine.get_frames_per_second()
		if running:
			_fps_samples.append(_fps)
			if _fps_samples.size() > 600:
				_fps_samples.pop_front()
		_fps_frames = 0
		_fps_time = 0.0
	if running and _now() - _run.moved > stall_seconds:
		problem("bug", "no progress for %d s (softlock?)" % int(stall_seconds))
		finish("stuck")
	_pump_logs()
	_pump_socket()
	if _socket == null and not running:
		set_process(false)


func _pump_socket() -> void:
	if _socket == null:
		return
	_socket.poll()
	var ready_state := _socket.get_ready_state()
	if ready_state == WebSocketPeer.STATE_CONNECTING:
		return
	if ready_state == WebSocketPeer.STATE_CLOSED:
		if _was_open:
			_socket = null
			if running:
				stop() # the runner went away: stop the bot (the game keeps running)
		elif _now() < _connect_deadline:
			if _retry_at == 0.0:
				_retry_at = _now() + 0.25
			elif _now() >= _retry_at:
				_retry_at = 0.0
				_open_socket()
		else:
			push_warning("[HawkesPlaytest] could not reach the playtest runner; playing without it")
			_socket = null
		return
	if ready_state != WebSocketPeer.STATE_OPEN:
		return
	if not _was_open:
		_was_open = true
		_send(_hello()) # the first message on the socket
	var handled := 0
	while _socket != null and _socket.get_available_packet_count() > 0 and handled < 64:
		handled += 1
		var packet := _socket.get_packet()
		if not _socket.was_string_packet():
			continue
		_handle(packet.get_string_from_utf8())
	if _socket == null:
		return
	var status: String = "idle" if _run == null else str(_run.state.status)
	if status != _last_status or _now() >= _next_state:
		_send_state(null)


func _open_socket() -> void:
	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = MAX_MESSAGE
	_socket.outbound_buffer_size = MAX_MESSAGE
	var err := _socket.connect_to_url(_address)
	if err != OK and _now() >= _connect_deadline:
		push_warning("[HawkesPlaytest] could not reach the playtest runner (error %d); playing without it" % err)
		_socket = null


## One message from the runner. Exposed for tests.
func _handle(text: String) -> void:
	var m = JSON.parse_string(text)
	if typeof(m) != TYPE_DICTIONARY:
		return # not a JSON object: no id to answer
	var type := str(m.get("type", ""))
	var id = m.get("id")
	match type:
		"welcome":
			pass
		"start":
			var scenario := str(m.get("scenario", ""))
			if scenario == "":
				_ack(id, false, "start needs a scenario")
				return
			if not _start.is_valid():
				_ack(id, false, "HawkesPlaytest.register was not called")
				return
			var opts = m.get("options", {})
			if typeof(opts) != TYPE_DICTIONARY:
				opts = {}
			if start_scenario(scenario, opts):
				_ack(id, true)
			else:
				_ack(id, false, "no playtest scenario \"%s\"" % scenario)
		"stop":
			stop()
			_ack(id, true)
		"input":
			var action := str(m.get("action", ""))
			if not _input.is_valid():
				_ack(id, false, "the game takes no runner input")
			elif action == "":
				_ack(id, false, "input needs an action")
			else:
				_input.call(action, m.get("down") == true)
				_ack(id, true)
		"state?":
			if id != null:
				_send_state(id)
		"report?":
			if id != null:
				_send({"type": "report", "re": int(id), "report": report()})
		"quit":
			_ack(id, true)
			if running:
				stop()
			_socket.close(1000, "bye")
			get_tree().quit()
		_:
			if id != null and type.ends_with("?"):
				_ack(id, false, "unknown request " + type)


func _hello() -> Dictionary:
	var ready := true
	if _is_ready.is_valid():
		ready = bool(_is_ready.call())
	var v := Engine.get_version_info()
	return {
		"type": "hello", "version": CONTRACT_VERSION, "product": product, "scenarios": _scenarios,
		"engine": "godot", "engineVersion": str(v.string), "sdk": SDK, "platform": _platform(), "ready": ready,
	}


func _send_state(re) -> void:
	var s := state()
	_last_status = str(s.status)
	_next_state = _now() + 0.5
	var msg := {"type": "state", "state": s}
	if re != null:
		msg.re = int(re)
	_send(msg)


func _ack(id, ok: bool, error: String = "") -> void:
	if id == null:
		return
	var msg := {"type": "ack", "re": int(id), "ok": ok}
	if error != "":
		msg.error = error
	_send(msg)


func _send(msg: Dictionary) -> void:
	if _socket == null or _socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	var text := JSON.stringify(msg)
	if text.length() <= MAX_MESSAGE:
		_socket.send_text(text)


# ---- the game's log lines (Godot 4.5+: OS.add_logger; earlier versions send none) -------------------------------

func _install_logger() -> void:
	if _logger != null or not ClassDB.class_exists("Logger") or not OS.has_method("add_logger"):
		return
	var script = load("res://addons/hawkes_playtest/log_forwarder.gd")
	if script == null:
		return
	_logger = script.new()
	_logger.sink = _queue_log
	OS.call("add_logger", _logger)


## Any thread: queued here, sent from _process (WebSocketPeer is not thread-safe). Rate-limited.
func _queue_log(level: String, line: String) -> void:
	_log_mutex.lock()
	var second := Time.get_ticks_msec() / 1000
	if second != _log_second:
		if _log_dropped > 0:
			_log_queue.append(["warning", "%d log lines dropped (over %d a second)" % [_log_dropped, LOGS_PER_SECOND]])
		_log_second = second
		_log_count = 0
		_log_dropped = 0
	if _log_count >= LOGS_PER_SECOND:
		_log_dropped += 1
	else:
		_log_count += 1
		_log_queue.append([level, line])
	_log_mutex.unlock()


func _pump_logs() -> void:
	if _log_queue.is_empty():
		return
	_log_mutex.lock()
	var lines := _log_queue
	_log_queue = []
	_log_mutex.unlock()
	for l in lines:
		_send({"type": "log", "level": l[0], "line": l[1]})
		if l[0] == "error" and running:
			var first: String = str(l[1]).split("\n")[0]
			problem("bug", "error: " + first)
			log_line(first)


# ---- helpers ----------------------------------------------------------------------------------------------------

func _play(serial: int, id: String, opts: Dictionary) -> void:
	await _start.call(id, opts, self)
	if _run != null and _run.serial == serial and not _run.done:
		finish("done")


func _has_scenario(id: String) -> bool:
	for s in _scenarios:
		if str(s.get("id", "")) == id:
			return true
	return false


func _now() -> float:
	return Time.get_ticks_msec() / 1000.0


func _t() -> float:
	return _now() - float(_run.t0) if _run != null else 0.0


func _round1(x: float) -> float:
	return roundf(x * 10.0) / 10.0


func _platform() -> String:
	match OS.get_name():
		"Windows":
			return "windows"
		"macOS":
			return "macos"
		"Linux", "FreeBSD", "NetBSD", "OpenBSD", "BSD":
			return "linux"
		_:
			return OS.get_name().to_lower()
