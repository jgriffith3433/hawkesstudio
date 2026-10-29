extends Logger
## Forwards the engine's log lines to the playtest runner (Godot 4.5+, where Logger and OS.add_logger exist).
## hawkes_playtest.gd loads this only when the Logger class exists, so older Godot never parses it.
## Called from any thread: sink queues the line under a mutex.

var sink := Callable()


func _log_message(message: String, error: bool) -> void:
	if sink.is_valid():
		sink.call("error" if error else "info", message.strip_edges(false, true))


func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
	if not sink.is_valid():
		return
	var text := rationale if rationale != "" else code
	var level := "warning" if error_type == 1 else "error" # ERROR_TYPE_WARNING
	sink.call(level, "%s (%s:%d %s)" % [text, file, line, function])
