import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const QA_BRIDGE_SCRIPT_PATH = 'addons/devmate_qa/devmate_qa.gd';
export const QA_BRIDGE_AUTOLOAD_NAME = 'DevMateQA';

const QA_BRIDGE_SCRIPT = `extends Node

const GLOBAL_STATE_KEY := "__DEVMATE_QA_STATE__"
const PUBLISH_INTERVAL_MS := 100

var _state: Dictionary = {}
var _checkpoints: Array[Dictionary] = []
var _last_publish_ms := 0

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    set_value("runtime.bridge_ready", true)
    set_value("runtime.debug_build", OS.is_debug_build())

func set_value(state_path: String, value: Variant) -> void:
    var parts := state_path.split(".", false)
    if parts.is_empty():
        return
    var cursor: Dictionary = _state
    for index in range(parts.size() - 1):
        var key := String(parts[index])
        if not cursor.has(key) or typeof(cursor[key]) != TYPE_DICTIONARY:
            cursor[key] = {}
        cursor = cursor[key]
    cursor[String(parts[parts.size() - 1])] = value

func merge_state(values: Dictionary) -> void:
    for key in values:
        _state[key] = values[key]

func checkpoint(name: String, data: Dictionary = {}) -> void:
    _checkpoints.append({
        "name": name,
        "time_ms": Time.get_ticks_msec(),
        "data": data.duplicate(true)
    })
    if _checkpoints.size() > 100:
        _checkpoints.pop_front()

func clear() -> void:
    _state.clear()
    _checkpoints.clear()

func snapshot() -> Dictionary:
    var output := _state.duplicate(true)
    output["runtime"] = output.get("runtime", {})
    output["runtime"]["scene"] = get_tree().current_scene.scene_file_path if get_tree().current_scene else ""
    output["runtime"]["fps"] = Engine.get_frames_per_second()
    output["runtime"]["time_ms"] = Time.get_ticks_msec()
    output["checkpoints"] = _checkpoints.duplicate(true)
    return output

func _process(_delta: float) -> void:
    if not OS.has_feature("web"):
        return
    if not OS.is_debug_build() and not bool(ProjectSettings.get_setting("devmate_qa/allow_release", false)):
        return
    var now := Time.get_ticks_msec()
    if now - _last_publish_ms < PUBLISH_INTERVAL_MS:
        return
    _last_publish_ms = now
    var state_json := JSON.stringify(snapshot())
    var encoded_json := JSON.stringify(state_json)
    JavaScriptBridge.eval("globalThis.%s = %s;" % [GLOBAL_STATE_KEY, encoded_json], true)
`;

export function qaBridgeTemplate() {
  return {
    files: [{ path: QA_BRIDGE_SCRIPT_PATH, content: QA_BRIDGE_SCRIPT }],
    projectConfig: {
      section: 'autoload',
      line: `${QA_BRIDGE_AUTOLOAD_NAME}="*res://${QA_BRIDGE_SCRIPT_PATH}"`
    },
    usage: [
      'DevMateQA.set_value("player.health", health)',
      'DevMateQA.set_value("boss.phase", phase)',
      'DevMateQA.checkpoint("boss_phase_changed", {"phase": phase})'
    ],
    productionSafety: 'The bridge publishes browser state only for debug Web exports unless devmate_qa/allow_release is explicitly enabled.'
  };
}

export async function inspectQaBridge(projectRoot) {
  const projectFile = path.join(projectRoot, 'project.godot');
  const scriptFile = path.join(projectRoot, QA_BRIDGE_SCRIPT_PATH);
  const projectText = await fsp.readFile(projectFile, 'utf8');
  const scriptStat = fs.statSync(scriptFile, { throwIfNoEntry: false });
  const autoloadPattern = new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=\\s*"\\*res://${QA_BRIDGE_SCRIPT_PATH.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"\\s*$`, 'm');
  return {
    installed: !!scriptStat?.isFile() && autoloadPattern.test(projectText),
    script: {
      path: QA_BRIDGE_SCRIPT_PATH,
      exists: !!scriptStat?.isFile(),
      size: scriptStat?.size || 0
    },
    autoload: {
      name: QA_BRIDGE_AUTOLOAD_NAME,
      configured: autoloadPattern.test(projectText),
      expectedLine: `${QA_BRIDGE_AUTOLOAD_NAME}="*res://${QA_BRIDGE_SCRIPT_PATH}"`
    }
  };
}

export const __test = { QA_BRIDGE_SCRIPT, QA_BRIDGE_AUTOLOAD_NAME, QA_BRIDGE_SCRIPT_PATH };
