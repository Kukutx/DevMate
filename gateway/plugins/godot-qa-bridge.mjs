import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveProject } from './godot-project.mjs';

export const QA_BRIDGE_SCRIPT_PATH = 'addons/devmate_qa/devmate_qa.gd';
export const QA_BRIDGE_AUTOLOAD_NAME = 'DevMateQA';
export const QA_BRIDGE_VERSION = 2;

const QA_BRIDGE_SCRIPT = `extends Node

const BRIDGE_VERSION := ${QA_BRIDGE_VERSION}
const GLOBAL_STATE_KEY := "__DEVMATE_QA_STATE__"
const PUBLISH_INTERVAL_MS := 100
const REPORT_ENV := "DEVMATE_QA_REPORT"
const PLAN_ENV := "DEVMATE_QA_PLAN"
const AUTO_FINISH_ENV := "DEVMATE_QA_AUTO_FINISH_MS"
const QUIT_CHECKPOINT_ENV := "DEVMATE_QA_QUIT_ON_CHECKPOINT"

var _state: Dictionary = {}
var _checkpoints: Array[Dictionary] = []
var _input_actions: Array = []
var _input_index := 0
var _last_publish_ms := 0
var _started_ms := 0
var _report_path := ""
var _plan_path := ""
var _auto_finish_ms := 0
var _quit_checkpoint := ""
var _finished := false

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    _started_ms = Time.get_ticks_msec()
    _report_path = OS.get_environment(REPORT_ENV)
    _plan_path = OS.get_environment(PLAN_ENV)
    _auto_finish_ms = int(OS.get_environment(AUTO_FINISH_ENV))
    _quit_checkpoint = OS.get_environment(QUIT_CHECKPOINT_ENV)
    set_value("runtime.bridge_ready", true)
    set_value("runtime.bridge_version", BRIDGE_VERSION)
    set_value("runtime.debug_build", OS.is_debug_build())
    set_value("runtime.native_report", not _report_path.is_empty())
    set_value("runtime.executed_actions", 0)
    _load_plan()
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
    _publish_now()
    call_deferred("_quit", 0 if success else 1)

func fail(message: String, data: Dictionary = {}) -> void:
    finish(false, message, data)

func clear() -> void:
    _state.clear()
    _checkpoints.clear()
    set_value("runtime.bridge_ready", true)
    set_value("runtime.bridge_version", BRIDGE_VERSION)

func snapshot() -> Dictionary:
    var output := _state.duplicate(true)
    output["runtime"] = output.get("runtime", {})
    output["runtime"]["scene"] = get_tree().current_scene.scene_file_path if get_tree().current_scene else ""
    output["runtime"]["fps"] = Engine.get_frames_per_second()
    output["runtime"]["time_ms"] = Time.get_ticks_msec()
    output["runtime"]["elapsed_ms"] = Time.get_ticks_msec() - _started_ms
    output["runtime"]["finished"] = _finished
    output["checkpoints"] = _checkpoints.duplicate(true)
    return output

func _process(_delta: float) -> void:
    var now := Time.get_ticks_msec()
    _run_input_actions(now - _started_ms)
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
    if typeof(parsed) == TYPE_DICTIONARY and typeof(parsed.get("actions", [])) == TYPE_ARRAY:
        _input_actions = parsed.get("actions", [])
        set_value("runtime.planned_actions", _input_actions.size())

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
  const root = path.join(project.root, '.godot', 'devmate-backups', stamp);
  const copied = [];
  for (const file of files) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const relative = path.relative(project.root, file);
    const target = path.join(root, relative);
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
    nativeAutomation: 'When launched by godot_native_test, the bridge writes a JSON report, replays bounded Input actions, and exits on auto-finish, finish/fail, or a selected checkpoint.',
    productionSafety: 'Browser state is published only for debug Web exports unless devmate_qa/allow_release is explicitly enabled. Native reporting activates only when DevMate injects a report path.'
  };
}

export async function inspectQaBridge(projectRoot) {
  const projectFile = path.join(projectRoot, 'project.godot');
  const scriptFile = path.join(projectRoot, QA_BRIDGE_SCRIPT_PATH);
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
  const scriptFile = path.join(project.root, QA_BRIDGE_SCRIPT_PATH);
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
  const scriptFile = path.join(project.root, QA_BRIDGE_SCRIPT_PATH);
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
