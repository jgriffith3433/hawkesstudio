@tool
extends EditorPlugin
## Adds the HawkesPlaytest autoload while the plugin is enabled.

const AUTOLOAD := "HawkesPlaytest"


func _enter_tree() -> void:
	add_autoload_singleton(AUTOLOAD, "res://addons/hawkes_playtest/hawkes_playtest.gd")


func _exit_tree() -> void:
	remove_autoload_singleton(AUTOLOAD)
