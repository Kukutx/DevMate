import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveProject, resolveProjectChild } from './godot-project.mjs';

export const QA_BRIDGE_SCRIPT_PATH = 'addons/devmate_qa/devmate_qa.gd';
export const QA_BRIDGE_AUTOLOAD_NAME = 'DevMateQA';
export const QA_BRIDGE_VERSION = 3;

const QA_BRIDGE_SCRIPT = `extends Node

const BRIDGE_VERSION := ${QA_BRIDGE_VERSION}
const GLOBAL_STATE_KEY := "__DEVMATE_QA_STATE__"
const PUBLISH_INTERVAL_MS := 100
const REPORT_ENV := "DEVMATE_QA_REPORT"
const PLAN_ENV := "DEVMATE_QA_PLAN"
const AUTO_FINISH_ENV := "DEVMATE_QA_AUTO_FINISH_MS"
const AUTO_FINISH_FRAMES_ENV := "DEVMATE_QA_AUTO_FINISH_FRAMES"
const QUIT_CHECKPOINT_ENV := "DEVMATE_QA_QUIT_ON_CHECKPOINT"

var _state: Dictionary = {}
var _checkpoints: Array[Dictionary] = []
var _input_actions: Array = []
var _input_index := 0
var _last_publish_ms := 0
var _started_ms := 0
var _started_frame := 0
var _report_path := ""
var _plan_path := ""
var _auto_finish_ms := 0
var _auto_finish_frames := 0
var _quit_checkpoint := ""
var _finished := false
var _performance_enabled := false
var _performance_interval_ms := 250
var _performance_max_samples := 600
var _performance_last_ms := 0
var _performance_last_frame := -1
var _performance_samples: Array[Dictionary] = []

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    _started_ms = Time.get_ticks_msec()
    _started_frame = Engine.get_process_frames()
    _report_path = OS.get_environment(REPORT_ENV)
    _plan_path = OS.get_environment(PLAN_ENV)
    _auto_finish_ms = int(OS.get_environment(AUTO_FINISH_ENV))
    _auto_finish_frames = int(OS.get_environment(AUTO_FINISH_FRAMES_ENV))
    _quit_checkpoint = OS.get_environment(QUIT_CHECKPOINT_ENV)
    set_value("runtime.bridge_ready", true)
    set_value("runtime.bridge_version", BRIDGE_VERSION)
    set_value("runtime.debug_build", OS.is_debug_build())
    set_value("runtime.native_report", not _report_path.is_empty())
    set_value("runtime.executed_actions", 0)
    _load_plan()
    _sample_performance(_started_ms, true)
    _publish_now()

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
        "elapsed_ms": Time.get_ticks_msec() - _started_ms,
        "data": data.duplicate(true)
    })
    if _checkpoints.size() > 200:
        _checkpoints.pop_front()
    _publish_now()
    if not _finished and not _quit_checkpoint.is_empty() and name == _quit_checkpoint:
        finish(true, "checkpoint:%s" % name, data)

func finish(success: bool = true, message: String = "", data: Dictionary = {}) -> void:
    if _finished:
        return
    _finished = true
    set_value("runtime.completed", true)
    set_value("runtime.ok", success)
    set_value("runtime.message", message)
    set_value("runtime.result", data.duplicate(true))
    _checkpoints.append({
        "name": "devmate_finish",
        "time_ms": Time.get_ticks_msec(),
        "elapsed_ms": Time.get_ticks_msec() - _started_ms,
        "data": {"ok": success, "message": message}
    })
    _sample_performance(Time.get_ticks_msec(), true)
    _publish_now()
    call_deferred("_quit", 0 if success else 1)

func fail(message: String, data: Dictionary = {}) -> void:
    finish(false, message, data)

func clear() -> void:
    _state.clear()
    _checkpoints.clear()
    _performance_samples.clear()
    _performance_last_frame = -1
    set_value("runtime.bridge_ready", true)
    set_value("runtime.bridge_version", BRIDGE_VERSION)

func snapshot() -> Dictionary:
    var output := _state.duplicate(true)
    output["runtime"] = output.get("runtime", {})
    output["runtime"]["scene"] = get_tree().current_scene.scene_file_path if get_tree().current_scene else ""
    output["runtime"]["fps"] = Engine.get_frames_per_second()
    output["runtime"]["time_ms"] = Time.get_ticks_msec()
    output["runtime"]["elapsed_ms"] = Time.get_ticks_msec() - _started_ms
    output["runtime"]["elapsed_frames"] = Engine.get_process_frames() - _started_frame
    output["runtime"]["finished"] = _finished
    output["checkpoints"] = _checkpoints.duplicate(true)
    output["performance"] = {
        "enabled": _performance_enabled,
        "sample_interval_ms": _performance_interval_ms,
        "max_samples": _performance_max_samples,
        "sample_count": _performance_samples.size(),
        "samples": _performance_samples.duplicate(true)
    }
    return output

func _process(_delta: float) -> void:
    var now := Time.get_ticks_msec()
    _run_input_actions(now - _started_ms)
    _sample_performance(now)
    if not _finished and _auto_finish_frames > 0 and Engine.get_process_frames() - _started_frame >= _auto_finish_frames:
        finish(true, "auto_finish_frames")
        return
    if not _finished and _auto_finish_ms > 0 and now - _started_ms >= _auto_finish_ms:
        finish(true, "auto_finish")
        return
    if now - _last_publish_ms < PUBLISH_INTERVAL_MS:
        return
    _last_publish_ms = now
    _publish_now()

func _load_plan() -> void:
    if _plan_path.is_empty() or not FileAccess.file_exists(_plan_path):
        return
    var parsed = JSON.parse_string(FileAccess.get_file_as_string(_plan_path))
    if typeof(parsed) != TYPE_DICTIONARY:
        return
    if typeof(parsed.get("actions", [])) == TYPE_ARRAY:
        _input_actions = parsed.get("actions", [])
        set_value("runtime.planned_actions", _input_actions.size())
    var performance = parsed.get("performance", {})
    if typeof(performance) == TYPE_DICTIONARY:
        _performance_enabled = bool(performance.get("enabled", false))
        _performance_interval_ms = clampi(int(performance.get("sample_interval_ms", 250)), 50, 5000)
        _performance_max_samples = clampi(int(performance.get("max_samples", 600)), 1, 5000)
        set_value("runtime.performance_enabled", _performance_enabled)

func _run_input_actions(elapsed_ms: int) -> void:
    while _input_index < _input_actions.size():
        var item = _input_actions[_input_index]
        if typeof(item) != TYPE_DICTIONARY:
            _input_index += 1
            continue
        if int(item.get("at_ms", 0)) > elapsed_ms:
            break
        var action := String(item.get("action", ""))
        var event_type := String(item.get("type", "press"))
        var strength := float(item.get("strength", 1.0))
        if InputMap.has_action(action):
            if event_type == "release":
                Input.action_release(action)
            else:
                Input.action_press(action, strength)
        _input_index += 1
        set_value("runtime.executed_actions", _input_index)

func _sample_performance(now_ms: int, force: bool = false) -> void:
    if not _performance_enabled:
        return
    if _performance_samples.size() >= _performance_max_samples:
        return
    var current_frame := Engine.get_process_frames() - _started_frame
    if _auto_finish_frames > 0:
        var frame_interval := maxi(1, int(ceil(float(_auto_finish_frames) / float(_performance_max_samples))))
        if not force and _performance_last_frame >= 0 and current_frame - _performance_last_frame < frame_interval:
            return
        _performance_last_frame = current_frame
    else:
        if not force and now_ms - _performance_last_ms < _performance_interval_ms:
            return
        _performance_last_ms = now_ms
    _performance_samples.append({
        "elapsed_ms": now_ms - _started_ms,
        "frame": current_frame,
        "fps": Performance.get_monitor(Performance.TIME_FPS),
        "process_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
        "physics_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
        "memory_static_bytes": Performance.get_monitor(Performance.MEMORY_STATIC),
        "object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
        "resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
        "node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
        "orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
        "draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
        "video_memory_bytes": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED),
        "physics_2d_active": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
        "physics_2d_pairs": Performance.get_monitor(Performance.PHYSICS_2D_COLLISION_PAIRS),
        "physics_3d_active": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
        "physics_3d_pairs": Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS)
    })
    set_value("runtime.performance_samples", _performance_samples.size())

func _publish_now() -> void:
    var state_json := JSON.stringify(snapshot())
    if OS.has_feature("web") and (OS.is_debug_build() or bool(ProjectSettings.get_setting("devmate_qa/allow_release", false))):
        var encoded_json := JSON.stringify(state_json)
        JavaScriptBridge.eval("globalThis.%s = %s;" % [GLOBAL_STATE_KEY, encoded_json], true)
    _write_report(state_json)

func _write_report(state_json: String = "") -> void:
    if _report_path.is_empty():
        return
    DirAccess.make_dir_recursive_absolute(_report_path.get_base_dir())
    var file := FileAccess.open(_report_path, FileAccess.WRITE)
    if file:
        file.store_string(state_json if not state_json.is_empty() else JSON.stringify(snapshot()))
        file.close()

func _quit(code: int) -> void:
    get_tree().quit(code)

func _exit_tree() -> void:
    _publish_now()
`;

function expectedAutoloadLine() {
  return `${QA_BRIDGE_AUTOLOAD_NAME}="*res://${QA_BRIDGE_SCRIPT_PATH}"`;
}

function autoloadPattern() {
  const escapedPath = QA_BRIDGE_SCRIPT_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=\\s*"\\*res://${escapedPath}"\\s*$`, 'm');
}

function upsertAutoload(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => /^\s*\[autoload\]\s*$/.test(line));
  const keyPattern = new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=`);
  if (sectionIndex < 0) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push('', '[autoload]', expectedAutoloadLine(), '');
    return lines.join('\n');
  }
  let end = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) { end = index; break; }
  }
  const existing = lines.findIndex((line, index) => index > sectionIndex && index < end && keyPattern.test(line));
  if (existing >= 0) lines[existing] = expectedAutoloadLine();
  else lines.splice(end, 0, expectedAutoloadLine());
  return lines.join('\n');
}

function removeAutoload(text) {
  return String(text || '').split(/\r?\n/).filter(line => !new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=`).test(line)).join('\n');
}

async function atomicWrite(file, content) {
  const temporary = `${file}.devmate-${process.pid}-${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temporary, content, 'utf8');
  await fsp.rename(temporary, file);
}

async function backupFiles(project, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const canonicalProjectRoot = fs.realpathSync.native(project.root);
  const root = resolveProjectChild(canonicalProjectRoot, path.join('.godot', 'devmate-backups', stamp));
  const copied = [];
  for (const file of files) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const relative = path.relative(canonicalProjectRoot, file);
    const target = resolveProjectChild(canonicalProjectRoot, path.relative(canonicalProjectRoot, path.join(root, relative)));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(file, target);
    copied.push(path.relative(project.workspace.root, target).replace(/\\/g, '/'));
  }
  return copied;
}

export function qaBridgeTemplate() {
  return {
    version: QA_BRIDGE_VERSION,
    files: [{ path: QA_BRIDGE_SCRIPT_PATH, content: QA_BRIDGE_SCRIPT }],
    projectConfig: { section: 'autoload', line: expectedAutoloadLine() },
    usage: [
      'DevMateQA.set_value("player.health", health)',
      'DevMateQA.checkpoint("boss_phase_changed", {"phase": phase})',
      'DevMateQA.finish(true, "scenario_complete")',
      'DevMateQA.fail("player_died")'
    ],
    nativeAutomation: 'When launched by DevMate, the bridge writes a JSON report, replays bounded Input actions, samples bounded performance monitors, and exits on time, frame count, finish/fail, or a selected checkpoint.',
    performance: 'QA Bridge v3 samples fixed Godot Performance monitors only when a DevMate run plan explicitly enables performance collection. Frame-bound captures use process-frame sampling rather than wall-clock intervals.',
    productionSafety: 'Browser state is published only for debug Web exports unless devmate_qa/allow_release is explicitly enabled. Native reporting and performance sampling activate only when DevMate injects a report plan.'
  };
}

export async function inspectQaBridge(projectRoot) {
  const projectFile = resolveProjectChild(projectRoot, 'project.godot', { mustExist: true });
  const scriptFile = resolveProjectChild(projectRoot, QA_BRIDGE_SCRIPT_PATH);
  const projectText = await fsp.readFile(projectFile, 'utf8');
  const scriptStat = fs.statSync(scriptFile, { throwIfNoEntry: false });
  let scriptVersion = null;
  if (scriptStat?.isFile()) {
    const scriptText = await fsp.readFile(scriptFile, 'utf8').catch(() => '');
    const match = scriptText.match(/const\s+BRIDGE_VERSION\s*:=\s*(\d+)/);
    scriptVersion = match ? Number(match[1]) : 1;
  }
  return {
    installed: !!scriptStat?.isFile() && autoloadPattern().test(projectText),
    current: scriptVersion === QA_BRIDGE_VERSION && autoloadPattern().test(projectText),
    version: scriptVersion,
    expectedVersion: QA_BRIDGE_VERSION,
    script: { path: QA_BRIDGE_SCRIPT_PATH, exists: !!scriptStat?.isFile(), size: scriptStat?.size || 0 },
    autoload: { name: QA_BRIDGE_AUTOLOAD_NAME, configured: autoloadPattern().test(projectText), expectedLine: expectedAutoloadLine() }
  };
}

export async function installQaBridge(context, { workspaceId, projectSubpath, force = false } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const before = await inspectQaBridge(project.root);
  if (before.current && !force) return { changed: false, before, after: before, backups: [] };
  const scriptFile = resolveProjectChild(project.root, QA_BRIDGE_SCRIPT_PATH);
  const backups = await backupFiles(project, [project.projectFile, scriptFile]);
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  await atomicWrite(scriptFile, QA_BRIDGE_SCRIPT);
  await atomicWrite(project.projectFile, `${upsertAutoload(projectText).replace(/\s*$/, '')}\n`);
  const after = await inspectQaBridge(project.root);
  return {
    changed: true,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    before,
    after,
    backups
  };
}

export async function removeQaBridge(context, { workspaceId, projectSubpath, removeScript = true } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const before = await inspectQaBridge(project.root);
  const scriptFile = resolveProjectChild(project.root, QA_BRIDGE_SCRIPT_PATH);
  const backups = await backupFiles(project, [project.projectFile, scriptFile]);
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  await atomicWrite(project.projectFile, `${removeAutoload(projectText).replace(/\s*$/, '')}\n`);
  if (removeScript) await fsp.rm(scriptFile, { force: true });
  const after = await inspectQaBridge(project.root);
  return {
    changed: before.installed || before.script.exists,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    before,
    after,
    backups
  };
}

export const __test = {
  QA_BRIDGE_SCRIPT,
  QA_BRIDGE_AUTOLOAD_NAME,
  QA_BRIDGE_SCRIPT_PATH,
  QA_BRIDGE_VERSION,
  autoloadPattern,
  removeAutoload,
  upsertAutoload
};
