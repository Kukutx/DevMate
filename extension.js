const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const childProcess = require('./vscode-host/runtime-io.js');
const { readExtensionConfig, writeExtensionConfig } = require('./vscode-host/config-sync.js');
const { requestRaw: boundedHttpRequestRaw } = require('./vscode-host/bounded-http-client.js');
const { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');
const { preflightPublicMcp } = require('./host/public-mcp.js');
const { RuntimeController, SUPPORTED_CONFIG_VERSION } = require('./host/runtime-controller.js');
const { updateConfig } = require('./shared/config-store.cjs');
const {
  recordGeneration,
  successfulVerificationPatch,
  verifiedForCurrentRecord
} = require('./shared/public-ingress-verification.cjs');
const { deploymentProvider, publicUiState, statusLabel } = require('./vscode-host/public-ui-state.js');
const { startTunnel, stopTunnel, tunnelStatus } = require('./vscode-host/tunnel-runtime.js');
const { classifyTunnelStop } = require('./vscode-host/tunnel-stop-policy.js');

function spawn(...args){ return childProcess.spawn(...args); }
function spawnSync(...args){ return childProcess.spawnSync(...args); }

const { version: VERSION } = require('./package.json');
const BASE_PORT = 8787;
const MCP_PATH = '/mcp';
let gatewayProcess = null;
let gatewayController = null;
let gatewayControllerKey = '';
let output = null;
let statusBar = null;
let panel = null;
let lastPublicUrl = '';
let selectedPort = BASE_PORT;
let globalContext = null;
let startCommandProcess = null;
let contextWriteTimer = null;
const lifecycleOperations = new OperationCoordinator({ name: 'vscode-lifecycle' });

function cfg(){ return vscode.workspace.getConfiguration('devMate'); }
function configuredPort(){ return Number(cfg().get('port') || BASE_PORT); }
function log(s){ if(output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function configPath(ctx){ return path.join(ctx.globalStorageUri.fsPath,'config.json'); }
function gatewayPath(ctx){
  const bundled = path.join(ctx.extensionPath,'gateway','server.bundle.mjs');
  return fs.existsSync(bundled) ? bundled : path.join(ctx.extensionPath,'gateway','server.mjs');
}
function esc(v){ return String(v ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function currentRoot(){ return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; }
function readJson(p){ return readExtensionConfig(p); }
function writeJson(p,data){ return writeExtensionConfig(p,data); }
function makeId(root){ return path.basename(root).replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase() || 'workspace'; }
function pathKey(p){ const resolved = path.resolve(p); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function samePath(a,b){ return !!a && !!b && pathKey(a) === pathKey(b); }
function uniqueWorkspaceId(workspaces, base, currentId=''){
  const cleanBase = String(base || 'workspace').replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase() || 'workspace';
  if(currentId && !workspaces.some(w => w.id === currentId)) return currentId;
  let id = cleanBase;
  let n = 2;
  while(workspaces.some(w => w.id === id && id !== currentId)) id = `${cleanBase}-${n++}`;
  return id;
}
function normalizeWorkspaceRoles(data){
  data.workspaces ||= [];
  for(const w of data.workspaces){
    if(w.reference){
      w.mode = 'readonly';
      w.role = 'reference';
    } else if(w.id === data.activeWorkspaceId){
      w.mode = 'workspace-write';
      w.role = 'active';
    } else {
      w.mode ||= 'workspace-write';
      w.role = 'workspace';
      w.reference = false;
    }
  }
}
function syncCurrentWorkspace(data, root){
  const references = (data.workspaces || []).filter(w => w.reference && !samePath(w.root, root));
  const existing = (data.workspaces || []).find(w => !w.reference && samePath(w.root, root));
  let id = existing?.id || makeId(root);
  if(references.some(w => w.id === id)) id = uniqueWorkspaceId(references, makeId(root));
  data.activeWorkspaceId = id;
  data.workspaces = [
    { id, name:path.basename(root), root, mode:'workspace-write', reference:false, role:'active' },
    ...references
  ];
}
function newAuthToken(){ return crypto.randomBytes(32).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function nonce(){ return crypto.randomBytes(16).toString('base64'); }
function authRequired(){ return cfg().get('requireAuthToken') !== false; }
function permissionProfile(){ const v = cfg().get('permissionProfile'); return ['readOnly','balanced','fullAccess'].includes(v) ? v : 'fullAccess'; }
function maintenanceConfig(){
  return {
    backupRetentionDays: Number(cfg().get('backupRetentionDays') || 30),
    auditRetentionDays: Number(cfg().get('auditRetentionDays') || 30),
    maxBackupBytes: Number(cfg().get('maxBackupBytes') || 268435456),
    maxAuditBytes: Number(cfg().get('maxAuditBytes') || 5242880)
  };
}
function relToRoot(fsPath){
  const root = currentRoot();
  if(!root || !fsPath) return '';
  const rel = path.relative(root, fsPath);
  if(rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.replace(/\\/g,'/');
}
function isProtectedName(filePath){
  const base = path.basename(filePath || '').toLowerCase();
  const parts = String(filePath || '').split(/[\\/]+/).map(x=>x.toLowerCase());
  if(parts.some(x=>['.git','node_modules','secrets','secret','credentials','credential','private-key','private_keys','service-account','service_accounts'].includes(x))) return true;
  if(base === '.env' || base.startsWith('.env.') || base === 'env.local' || base.endsWith('.env')) return !(base.endsWith('.env.example') || base.endsWith('.env.sample'));
  return ['.pem','.key','.pfx','.p12','.db','.sqlite','.sqlite3','.log'].includes(path.extname(base));
}
function rangePublic(range){
  return {
    start: { line: range.start.line + 1, character: range.start.character + 1 },
    end: { line: range.end.line + 1, character: range.end.character + 1 }
  };
}
function collectVsCodeContext(){
  const root = currentRoot();
  const editor = vscode.window.activeTextEditor;
  let active = null;
  if(editor){
    const rel = relToRoot(editor.document.uri.fsPath);
    active = {
      path: rel || editor.document.uri.toString(),
      languageId: editor.document.languageId,
      lineCount: editor.document.lineCount,
      isDirty: editor.document.isDirty,
      selection: rangePublic(editor.selection),
      selectedText: (rel && !isProtectedName(editor.document.uri.fsPath) && !editor.selection.isEmpty) ? editor.document.getText(editor.selection).slice(0,20000) : ''
    };
  }
  const visibleEditors = vscode.window.visibleTextEditors.map(e=>({
    path: relToRoot(e.document.uri.fsPath) || e.document.uri.toString(),
    languageId: e.document.languageId,
    isDirty: e.document.isDirty,
    selection: rangePublic(e.selection)
  })).slice(0,20);
  const diagnostics = [];
  if(root){
    for(const [uri, items] of vscode.languages.getDiagnostics()){
      const rel = relToRoot(uri.fsPath);
      if(!rel || isProtectedName(uri.fsPath)) continue;
      for(const d of items.slice(0,50)){
        diagnostics.push({
          path: rel,
          severity: ['error','warning','information','hint'][d.severity] || String(d.severity),
          message: String(d.message || '').slice(0,1000),
          source: d.source || '',
          code: d.code == null ? '' : String(typeof d.code === 'object' ? d.code.value : d.code),
          range: rangePublic(d.range)
        });
        if(diagnostics.length >= 300) break;
      }
      if(diagnostics.length >= 300) break;
    }
  }
  return {
    capturedAt: new Date().toISOString(),
    workspaceRoot: root,
    activeEditor: active,
    visibleEditors,
    diagnostics
  };
}
function redactUrl(url){
  try {
    const value = new URL(url);
    value.username = '';
    value.password = '';
    value.search = '';
    value.hash = '';
    return value.toString();
  } catch {
    return '';
  }
}
function updateConnectionSnapshot(ctx, patch){
  if(!ctx) return null;
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const updated = updateConfig(configPath(ctx), data => {
    data.connection = { ...(data.connection || {}), ...cleanPatch };
    return data;
  });
  refreshPanel();
  return updated;
}
function mcpUrlFor(baseUrl){
  return new URL(`${String(baseUrl).replace(/\/$/,'')}${MCP_PATH}`).toString();
}
function mcpToken(ctx=globalContext){
  const data = ctx ? ensureConfig(ctx,false) : null;
  return data?.auth?.required === false ? '' : String(data?.auth?.token || '');
}

function defaultConfig(ctx){
  const root = currentRoot();
  return {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion: VERSION,
    instanceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
    server: { port: configuredPort(), mcpPath: MCP_PATH },
    runtime: { defaultCommandTimeoutMs: Number(cfg().get('defaultCommandTimeoutMs') || 180000), maxOutputChars: Number(cfg().get('maxOutputChars') || 120000) },
    connection: {},
    vscodeContext: collectVsCodeContext(),
    auth: { required: authRequired(), token: newAuthToken() },
    permissions: {
      profile: permissionProfile(),
      readOnly: permissionProfile() === 'readOnly',
      blockDangerousOperations: permissionProfile() !== 'fullAccess' && cfg().get('blockDangerousOperations') !== false,
      confirmBeforePush: !!cfg().get('confirmBeforePush'),
      allowDirectoryMutations: !!cfg().get('allowDirectoryMutations')
    },
    activeWorkspaceId: root ? makeId(root) : '',
    workspaces: root ? [{ id: makeId(root), name: path.basename(root), root, mode:'workspace-write', reference:false, role:'active' }] : [],
    commands: [
      { key: 'pnpm-lint', label: 'pnpm lint', command: 'pnpm lint', readOnly: true },
      { key: 'pnpm-test', label: 'pnpm test', command: 'pnpm test', readOnly: true },
      { key: 'dotnet-build-api', label: 'dotnet build backend/api', command: 'cd backend/api && dotnet build', readOnly: true },
      { key: 'flutter-analyze', label: 'flutter analyze app', command: 'cd frontend/app && flutter analyze', readOnly: true }
    ]
  };
}
function ensureConfig(ctx, forceCurrent=false, portOverride=null){
  const p = configPath(ctx);
  let data = readJson(p) || defaultConfig(ctx);
  data.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(data.version) || 0);
  data.appVersion = VERSION;
  data.instanceId ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  data.server ||= {};
  data.server.port = Number(portOverride || data.server.port || configuredPort() || BASE_PORT);
  data.server.mcpPath = MCP_PATH;
  data.runtime ||= {};
  data.runtime.defaultCommandTimeoutMs = Number(cfg().get('defaultCommandTimeoutMs') || 180000);
  data.runtime.maxOutputChars = Number(cfg().get('maxOutputChars') || 120000);
  data.maintenance = maintenanceConfig();
  data.connection ||= {};
  data.vscodeContext = collectVsCodeContext();
  data.auth ||= {};
  data.auth.required = authRequired();
  data.auth.token ||= newAuthToken();
  data.permissions ||= {};
  data.permissions.profile = permissionProfile();
  data.permissions.readOnly = permissionProfile() === 'readOnly';
  data.permissions.blockDangerousOperations = permissionProfile() !== 'fullAccess' && cfg().get('blockDangerousOperations') !== false;
  data.permissions.confirmBeforePush = !!cfg().get('confirmBeforePush');
  data.permissions.allowDirectoryMutations = cfg().get('allowDirectoryMutations') === true;
  data.workspaces ||= [];
  data.commands ||= [];
  const root = currentRoot();
  if(root && (forceCurrent || cfg().get('autoUseCurrentWorkspace'))){
    syncCurrentWorkspace(data, root);
  }
  normalizeWorkspaceRoles(data);
  writeJson(p,data);
  selectedPort = Number(data.server.port || configuredPort() || BASE_PORT);
  return data;
}
function scheduleContextRefresh(ctx){
  if(contextWriteTimer) clearTimeout(contextWriteTimer);
  contextWriteTimer = setTimeout(()=>{
    contextWriteTimer = null;
    try { ensureConfig(ctx,false); refreshPanel(); } catch(e) { log(`VS Code context refresh failed: ${e.message || e}`); }
  }, 400);
}
function setStatus(text){ if(statusBar){ statusBar.text = text; statusBar.show(); } }
function shortText(text, max=12000){
  text = String(text ?? '');
  return text.length > max ? `${text.slice(0,max)}\n...[truncated ${text.length - max} chars]` : text;
}
function gitSync(root, args, max=12000){
  if(!root) return '';
  const r = spawnSync('git', args, {cwd:root, encoding:'utf8', windowsHide:true});
  if(r.error || r.status !== 0) return shortText((r.stderr || r.stdout || r.error?.message || '').trim(), max);
  return shortText((r.stdout || '').trim(), max);
}
function packageScripts(root){
  const pkg = readJson(path.join(root,'package.json'));
  if(!pkg?.scripts) return [];
  return Object.entries(pkg.scripts).slice(0,80).map(([name, command]) => `${name}: ${command}`);
}
function safeRootFiles(root, depth=3, max=260){
  const out = [];
  const skip = new Set(['.git','node_modules','.next','.dart_tool','dist','build','coverage','.cache','tmp','.vscode','.idea']);
  function walk(dir, level){
    if(out.length >= max || level > depth) return;
    let entries = [];
    try{ entries = fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)); }catch{ return; }
    for(const e of entries){
      if(out.length >= max) break;
      const full = path.join(dir,e.name);
      const rel = path.relative(root, full).replace(/\\/g,'/');
      if(!rel || isProtectedName(full) || skip.has(e.name)) continue;
      out.push(`${e.isDirectory() ? 'd' : 'f'} ${rel}`);
      if(e.isDirectory()) walk(full, level + 1);
    }
  }
  walk(root, 1);
  return out;
}
function readInstructionFile(root, name){
  const full = path.join(root, name);
  if(!fs.existsSync(full) || isProtectedName(full)) return '';
  try{
    const st = fs.statSync(full);
    if(!st.isFile() || st.size > 200000) return '';
    return shortText(fs.readFileSync(full,'utf8'), 30000);
  }catch{ return ''; }
}
function contextBundle(ctx){
  const root = currentRoot();
  if(!root) throw new Error('Open a VS Code project folder first.');
  const data = ensureConfig(ctx,false);
  const vscodeContext = collectVsCodeContext();
  const activeEditor = vscodeContext.activeEditor ? {...vscodeContext.activeEditor} : null;
  if(activeEditor && (String(activeEditor.path || '').includes('://') || path.isAbsolute(String(activeEditor.path || '')))){
    activeEditor.selectedText = '';
  } else if(activeEditor?.selectedText) {
    activeEditor.selectedText = shortText(activeEditor.selectedText, 4000);
  }
  const refs = (data.workspaces || []).filter(w => w.reference).map(w => `${w.name || w.id}: ${w.root}`);
  const diagnostics = (vscodeContext.diagnostics || []).slice(0,80).map(d => `${d.severity} ${d.path}:${d.range?.start?.line || 1} ${d.message}`);
  const instructions = ['AGENTS.md','CLAUDE.md'].map(name => ({name, text:readInstructionFile(root,name)})).filter(x => x.text);
  const sections = [
    `# DevMate Context Bundle`,
    `Generated: ${new Date().toISOString()}`,
    `Purpose: paste this into a ChatGPT model/session that cannot call the DevMate MCP tools. Use it for planning, review, and guidance. If live file edits are needed, reconnect DevMate and use MCP tools.`,
    `## Workspace\nRoot: ${root}\nDevMate: ${VERSION}\nPermission profile: ${data.permissions?.profile || 'fullAccess'}\nReferences:\n${refs.length ? refs.map(x=>`- ${x}`).join('\n') : '- none'}`,
    `## Git Status\n\`\`\`text\n${gitSync(root,['status','--short','--branch'],12000) || '(no git status)'}\n\`\`\``,
    `## Git Diff Stat\n\`\`\`text\n${gitSync(root,['diff','--stat'],12000) || '(no diff stat)'}\n\`\`\``,
    `## Package Scripts\n\`\`\`text\n${packageScripts(root).join('\n') || '(no package scripts found)'}\n\`\`\``,
    `## File Tree\n\`\`\`text\n${safeRootFiles(root).join('\n') || '(no files listed)'}\n\`\`\``,
    `## VS Code Context\n\`\`\`json\n${JSON.stringify({activeEditor, visibleEditors:vscodeContext.visibleEditors, diagnostics}, null, 2)}\n\`\`\``,
    ...instructions.map(x => `## ${x.name}\n\`\`\`markdown\n${x.text}\n\`\`\``),
    `## Suggested Instruction\nAct as my development planning assistant from this context. Keep recommendations concrete and scoped. If you need live file reads, edits, commands, tests, or Git operations, tell me to reconnect DevMate and use MCP tools.`
  ];
  return sections.join('\n\n');
}
async function copyContextBundle(ctx){
  try{
    const text = contextBundle(ctx);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`DevMate context copied (${text.length} chars). Paste it into ChatGPT when MCP tools are unavailable.`);
  }catch(e){
    vscode.window.showErrorMessage(`Context copy failed: ${e.message || e}`);
  }
}

function httpRequestRaw(url, options={}, body=null, timeoutMs=4000){
  return boundedHttpRequestRaw(url, options, body, timeoutMs);
}
function httpGet(url, timeoutMs=1500){ return httpRequestRaw(url, {method:'GET'}, null, timeoutMs); }
async function healthAt(port){ return httpGet(`http://127.0.0.1:${port}/control/health`,1200); }
function healthMatches(r, ctx){
  const cfgData = readJson(configPath(ctx));
  return !!(r.ok && r.json && r.json.name === 'devmate' && r.json.version === VERSION && (!cfgData?.instanceId || r.json.instanceId === cfgData.instanceId));
}
function isPortFree(port){
  return new Promise(resolve=>{
    const srv = net.createServer();
    srv.once('error',()=>resolve(false));
    srv.once('listening',()=>srv.close(()=>resolve(true)));
    srv.listen(port,'127.0.0.1');
  });
}
async function choosePort(ctx){
  const base = configuredPort() || BASE_PORT;
  for(let p=base; p<base+20; p++){
    const health = await healthAt(p);
    if(healthMatches(health, ctx)) return p;
    if(!health.ok && await isPortFree(p)) return p;
    log(`Port ${p} is busy or occupied by a different service; trying next port.`);
  }
  throw new Error(`No free port found from ${base} to ${base+19}. Close old gateway/tunnel/node processes and try again.`);
}
async function isCurrentGatewayUp(ctx){
  const data = ensureConfig(ctx,false);
  const r = await healthAt(Number(data.server.port || selectedPort));
  return healthMatches(r, ctx);
}
function waitForProcessExit(child, timeoutMs=8000){
  if(!child || child.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve=>child.once('exit',()=>resolve(true))),
    new Promise(resolve=>setTimeout(()=>resolve(false), Math.max(250, Number(timeoutMs) || 8000)))
  ]);
}
async function ensureGatewayController(ctx){
  const root = currentRoot();
  if(!root) throw new Error('Open a VS Code project folder first.');
  const stateDirectory = path.resolve(ctx.globalStorageUri.fsPath);
  const key = `${pathKey(root)}|${pathKey(stateDirectory)}`;
  if(gatewayController && gatewayControllerKey === key){
    gatewayController.preferredPort = configuredPort();
    gatewayController.gatewayEntry = gatewayPath(ctx);
    return gatewayController;
  }
  if(gatewayController){
    const disposed = await gatewayController.dispose({stopOwned:true});
    if(disposed?.disposed === false) throw new Error(`Previous Gateway controller could not be disposed: ${disposed.reason || 'unknown error'}`);
  }
  gatewayController = new RuntimeController({
    workspaceRoot: root,
    stateDirectory,
    gatewayEntry: gatewayPath(ctx),
    preferredPort: configuredPort(),
    appVersion: VERSION,
    hostId: 'vscode',
    nodeExecutable: process.execPath,
    spawnImpl: spawn,
    logger: message => log(message)
  });
  gatewayControllerKey = key;
  return gatewayController;
}
function trackGatewayProcess(child){
  if(!child || child.__devMateTracked) return;
  child.__devMateTracked = true;
  child.once('exit',(code,signal)=>{
    if(gatewayProcess !== child) return;
    gatewayProcess = null;
    log(`Gateway exited code=${code} signal=${signal}`);
    setStatus('DevMate: stopped');
    refreshPanel();
  });
}
async function stopGatewayProcess(){
  if(!gatewayController) return {stopped:false,reason:'not-running'};
  const result = await gatewayController.stop();
  gatewayProcess = gatewayController.child;
  return result;
}
async function stopStartCommand(){
  const child = startCommandProcess;
  if(!child) return {stopped:false,reason:'not-running'};
  try{ if(child.exitCode == null && !child.killed) child.kill(); }catch(e){ return {stopped:false,reason:e.message || String(e)}; }
  const exited = await waitForProcessExit(child, 4000);
  if(exited && startCommandProcess === child) startCommandProcess = null;
  return {stopped:exited,reason:exited ? '' : 'process-exit-timeout'};
}
function runDefaultStartCommand(){
  const command = String(cfg().get('defaultStartCommand') || '').trim();
  if(!command) return;
  if(startCommandProcess && !startCommandProcess.killed){
    log('Default start command is already running.');
    return;
  }
  const cwd = currentRoot();
  if(!cwd) return;
  log(`Starting default command: ${command}`);
  const child = spawn(command, [], { cwd, shell: true, windowsHide: true });
  startCommandProcess = child;
  child.stdout?.on('data',d=>log(`[start] ${String(d).trimEnd()}`));
  child.stderr?.on('data',d=>log(`[start:err] ${String(d).trimEnd()}`));
  child.on('error',e=>log(`Default start command error: ${e.message}`));
  child.on('exit',(code,signal)=>{
    log(`Default start command exited code=${code} signal=${signal}`);
    if(startCommandProcess === child) startCommandProcess=null;
    refreshPanel();
  });
}
async function startGateway(ctx){
  const controller = await ensureGatewayController(ctx);
  ensureConfig(ctx,true);
  const result = await controller.start({timeoutMs:20000});
  gatewayProcess = controller.child;
  trackGatewayProcess(gatewayProcess);
  setStatus(`DevMate: on :${result.port}`);
  log(result.attached
    ? `Attached to shared DevMate Gateway on port ${result.port}.`
    : `Gateway ready on port ${result.port}.`);
  runDefaultStartCommand();
  return result;
}
function currentTunnelStatus(ctx=globalContext){
  const data = ensureConfig(ctx,false);
  return tunnelStatus(Number(data.server.port || selectedPort));
}
function currentTunnelRecord(port){
  try { return tunnelStatus(Number(port || selectedPort))?.record || null; }
  catch { return null; }
}
function staleTunnelGenerationError(){
  const error = new Error('Public MCP verification became stale because the connection generation changed');
  error.code = 'DEVMATE_PUBLIC_MCP_STALE_GENERATION';
  return error;
}
function currentPublicUiState(data){
  let tunnel = null;
  let runtimeError = '';
  try {
    tunnel = tunnelStatus(Number(data.server?.port || selectedPort));
  } catch(e) {
    runtimeError = String(e.message || e);
  }
  return publicUiState(data, tunnel, { runtimeError });
}
async function syncPublicUiState(ctx=globalContext){
  if(!ctx) return null;
  const data = ensureConfig(ctx,false);
  const state = currentPublicUiState(data);
  let gateway = null;
  if(state.state === 'absent' || state.state === 'unavailable'){
    try { gateway = await gatewayController?.status(); } catch {}
  }
  lastPublicUrl = state.verified ? state.publicUrl : '';
  setStatus(statusLabel(state, gateway));
  refreshPanel();
  return state;
}
async function startPublicTunnel(ctx){
  const data = ensureConfig(ctx,false);
  const port = Number(data.server.port || selectedPort);
  const result = await startTunnel(port);
  const publicUrl = result?.publicUrl || result?.record?.publicUrl || '';
  const provider = result?.record?.provider || deploymentProvider(data);
  if(!publicUrl) throw new Error(`Tunnel provider ${provider} did not publish a public URL.`);
  lastPublicUrl = publicUrl;
  log(result.attached
    ? `Attached to shared ${provider} tunnel for port ${port}: ${publicUrl}`
    : `${provider} tunnel ready for port ${port}: ${publicUrl}`);
  return {...result, publicUrl, provider};
}
async function stopPublicTunnel(){
  try{
    return await stopTunnel();
  } finally {
    lastPublicUrl = '';
  }
}
async function verifyPublicMcp(baseUrl, ctx=globalContext){
  const data = ctx ? ensureConfig(ctx,false) : null;
  return preflightPublicMcp({
    publicUrl: baseUrl,
    token: data?.auth?.required === false ? '' : String(data?.auth?.token || ''),
    clientName: 'devmate-vscode-preflight',
    clientVersion: VERSION
  });
}
async function verifyCurrentTunnel(publicUrl, expectedRecord, ctx=globalContext){
  const generation = recordGeneration(expectedRecord);
  if(!generation){
    const error = new Error('The public connection is not a current ready tunnel generation');
    error.code = 'DEVMATE_PUBLIC_MCP_GENERATION_UNAVAILABLE';
    throw error;
  }
  const test = await verifyPublicMcp(publicUrl, ctx);
  let currentRecord = currentTunnelRecord(expectedRecord.port);
  if(recordGeneration(currentRecord) !== generation) throw staleTunnelGenerationError();
  const stamp = new Date().toISOString();
  updateConnectionSnapshot(ctx, successfulVerificationPatch(test, publicUrl, stamp, expectedRecord));
  const persisted = readJson(configPath(ctx));
  currentRecord = currentTunnelRecord(expectedRecord.port);
  if(recordGeneration(currentRecord) !== generation || !verifiedForCurrentRecord(persisted, currentRecord)){
    throw staleTunnelGenerationError();
  }
  return {test,stamp,generation,record:currentRecord};
}
function recordConnectionFailure(ctx, error, expectedRecord=null){
  if(!ctx) return;
  if(expectedRecord){
    const generation = recordGeneration(expectedRecord);
    if(generation && recordGeneration(currentTunnelRecord(expectedRecord.port)) !== generation) return;
  }
  try{
    updateConnectionSnapshot(ctx,{lastError:String(error.message || error),lastErrorAt:new Date().toISOString()});
  }catch(writeError){
    log(`Could not persist DevMate connection failure: ${writeError.message || writeError}`);
  }
}
async function rollbackFailedStart({gateway,tunnel,tunnelWasRunning,startCommandWasRunning}){
  if(tunnel?.owned && !tunnelWasRunning){
    try { await stopPublicTunnel(); }
    catch(error){ log(`Could not roll back owned public tunnel after failed Start: ${error.message || error}`); }
  }
  let sharedTunnelActive = tunnel?.attached === true;
  if(!sharedTunnelActive && gateway?.port){
    try{
      const active = tunnelStatus(gateway.port);
      sharedTunnelActive = active?.running === true && active?.owned !== true;
    }catch(error){
      if(error?.code === 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT') sharedTunnelActive = true;
    }
  }
  if(gateway?.started && gateway?.owned && !sharedTunnelActive){
    try { await stopGatewayProcess(); }
    catch(error){ log(`Could not roll back owned Gateway after failed Start: ${error.message || error}`); }
  }
  if(!startCommandWasRunning && startCommandProcess){
    const stopped = await stopStartCommand();
    if(!stopped.stopped && stopped.reason !== 'not-running') log(`Could not roll back default start command: ${stopped.reason}`);
  }
}
async function quickStart(ctx){
  let gateway = null;
  let tunnel = null;
  let tunnelWasRunning = false;
  const startCommandWasRunning = !!startCommandProcess && startCommandProcess.exitCode == null;
  try{
    output.show(true);
    if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
    gateway = await startGateway(ctx);
    try { tunnelWasRunning = currentTunnelStatus(ctx)?.running === true; } catch {}
    tunnel = await startPublicTunnel(ctx);
    const publicUrl = tunnel.publicUrl;
    log(`Running public MCP preflight through ${tunnel.provider} before reporting Ready...`);
    const verified = await verifyCurrentTunnel(publicUrl, tunnel.record, ctx);
    const test = verified.test;
    await syncPublicUiState(ctx);

    let copied = false;
    let copyError = '';
    if(cfg().get('autoCopyUrl')){
      try{
        await vscode.env.clipboard.writeText(test.mcpUrl);
        copied = true;
        updateConnectionSnapshot(ctx,{lastCopiedAt:new Date().toISOString()});
      }catch(error){
        copyError = String(error.message || error);
        log(`DevMate reached Ready but automatic MCP URL copy failed: ${copyError}`);
      }
    }

    log(`Public MCP preflight OK: ${redactUrl(test.mcpUrl)}, tools=${test.toolCount}`);
    if(copied) vscode.window.showInformationMessage(`Ready. ChatGPT MCP URL copied and verified: ${redactUrl(test.mcpUrl)}`);
    else if(cfg().get('autoCopyUrl') && copyError) vscode.window.showWarningMessage('DevMate is Ready, but automatic MCP URL copy failed. Use DevMate: Copy MCP URL if needed.');
    else vscode.window.showInformationMessage(`Ready. Verified MCP URL: ${redactUrl(test.mcpUrl)}`);
    return {ok:true,gateway,tunnel,publicUrl,mcpUrl:test.mcpUrl,toolCount:test.toolCount,server:test.server,copied,copyError};
  }catch(e){
    await rollbackFailedStart({gateway,tunnel,tunnelWasRunning,startCommandWasRunning});
    recordConnectionFailure(ctx,e,tunnel?.record || null);
    await syncPublicUiState(ctx);
    const message = String(e.message || e);
    log(`ERROR: ${e.stack || e.message || e}`);
    vscode.window.showErrorMessage(`DevMate failed: ${message}`);
    return {ok:false,error:message,code:e.code || 'DEVMATE_START_FAILED'};
  }
}
async function stopAll(){
  let tunnel = {stopped:false,reason:'not-running'};
  try{
    tunnel = await stopPublicTunnel();
  }catch(e){
    log(`Could not stop public tunnel cleanly: ${e.message || e}`);
    tunnel = {stopped:false,reason:e.message || String(e),error:e};
  }
  const tunnelState = classifyTunnelStop(tunnel);
  const startCommand = await stopStartCommand();
  if(!tunnelState.safe){
    setStatus('DevMate: stop failed');
    refreshPanel();
    return {ok:false,sharedStillActive:true,gateway:{stopped:false,reason:'preserved-after-tunnel-stop-failure'},tunnel,startCommand};
  }

  let gateway;
  if(tunnelState.remoteOwner){
    gateway = {stopped:false,reason:'preserved-for-shared-connection'};
  }else{
    try { gateway = await stopGatewayProcess(); }
    catch(e){ gateway = {stopped:false,reason:e.message || String(e),error:e}; }
  }
  const gatewaySafe = gateway.stopped === true || ['not-running','preserved-for-shared-connection'].includes(String(gateway.reason || '')) || gateway.attached === true;
  const startCommandSafe = startCommand.stopped === true || startCommand.reason === 'not-running';
  const sharedStillActive = tunnelState.remoteOwner || gateway.reason === 'preserved-for-shared-connection' || gateway.attached === true;
  lastPublicUrl='';
  if(globalContext) await syncPublicUiState(globalContext);
  else refreshPanel();
  if(!gatewaySafe || !startCommandSafe) setStatus('DevMate: stop failed');
  return {ok:tunnelState.safe && gatewaySafe && startCommandSafe,sharedStillActive,gateway,tunnel,startCommand};
}
async function copyUrl(){
  let status;
  try{
    status = currentTunnelStatus(globalContext);
  }catch(e){
    return vscode.window.showWarningMessage(`Public tunnel is unavailable: ${e.message || e}`);
  }
  const url = status.publicUrl || '';
  if(!url) return vscode.window.showWarningMessage('No public tunnel URL for the current gateway port. Run DevMate: Start first.');
  let verified;
  try{
    verified = await verifyCurrentTunnel(url, status.record, globalContext);
    await syncPublicUiState(globalContext);
  }catch(e){
    recordConnectionFailure(globalContext,e,status.record || null);
    await syncPublicUiState(globalContext);
    log(`MCP URL verification failed: ${e.stack || e.message || e}`);
    vscode.window.showErrorMessage(`MCP URL is not healthy: ${e.message || e}`);
    return;
  }
  try{
    await vscode.env.clipboard.writeText(verified.test.mcpUrl);
    updateConnectionSnapshot(globalContext,{lastCopiedAt:new Date().toISOString()});
    vscode.window.showInformationMessage(`Copied verified MCP URL: ${redactUrl(verified.test.mcpUrl)}`);
  }catch(e){
    log(`Verified MCP URL could not be copied: ${e.message || e}`);
    vscode.window.showErrorMessage(`DevMate is Ready, but the MCP URL could not be copied: ${e.message || e}`);
  }
}
async function copyConnectionToken(ctx=globalContext){
  try{
    const token = mcpToken(ctx);
    if(!token) return vscode.window.showWarningMessage('DevMate authentication is disabled or no owner token is configured.');
    await vscode.env.clipboard.writeText(token);
    vscode.window.showInformationMessage('DevMate Bearer token copied. Keep it private and send it in the Authorization header.');
  }catch(e){
    vscode.window.showErrorMessage(`Bearer token copy failed: ${e.message || e}`);
  }
}

async function copyStarterPrompt(){
  const text = '使用 DevMate，完成这个开发任务。复杂任务先用 work_session_start 建立工作会话；需要时读取、搜索、修改文件、运行命令和使用 Git；完成前用 show_changes 检查改动，再用 work_session_finish 结束会话。';
  await vscode.env.clipboard.writeText(text); vscode.window.showInformationMessage('Starter prompt copied.');
}
function parseGithubRepo(input){
  const text = String(input || '').trim();
  let match = text.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+?)(?:\.git)?(?:[\/#?].*)?$/i);
  if(!match) match = text.match(/^git@github\.com:([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/i);
  if(!match) return null;
  const owner = match[1].replace(/[^a-zA-Z0-9_.-]/g,'');
  const repo = match[2].replace(/[^a-zA-Z0-9_.-]/g,'');
  if(!owner || !repo) return null;
  return {
    owner,
    repo,
    name: `${owner}/${repo}`,
    idBase: `github-${owner}-${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    dirName: `${owner}__${repo}`.replace(/[^a-zA-Z0-9_.-]/g,'-')
  };
}
function runGit(args, cwd, timeoutMs=180000){
  return new Promise(resolve=>{
    const child = spawn('git', args, { cwd, windowsHide:true });
    let stdout='', stderr='', done=false;
    const timer = setTimeout(()=>{
      if(done) return;
      done = true;
      try{ child.kill(); }catch{}
      resolve({exitCode:null,timedOut:true,stdout,stderr});
    }, timeoutMs);
    child.stdout?.on('data', d=>{ stdout += d.toString(); });
    child.stderr?.on('data', d=>{ stderr += d.toString(); });
    child.on('error', e=>{
      if(done) return;
      done = true;
      clearTimeout(timer);
      resolve({exitCode:null,error:e.message,stdout,stderr});
    });
    child.on('close', code=>{
      if(done) return;
      done = true;
      clearTimeout(timer);
      resolve({exitCode:code,timedOut:false,stdout,stderr});
    });
  });
}
function addReferenceWorkspace(ctx, root, name, idBase){
  const data = ensureConfig(ctx,false);
  const resolved = path.resolve(root);
  if(!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Reference path is not a directory: ${resolved}`);
  if(data.workspaces.some(w => !w.reference && samePath(w.root, resolved))) throw new Error(`Reference path is already a writable workspace: ${resolved}`);
  const existing = data.workspaces.find(w => w.reference && samePath(w.root, resolved));
  if(existing){
    existing.name = name || path.basename(resolved);
    existing.root = resolved;
    existing.mode = 'readonly';
    existing.reference = true;
    existing.role = 'reference';
  } else {
    const id = uniqueWorkspaceId(data.workspaces, idBase || makeId(resolved));
    data.workspaces.push({id,name:name || path.basename(resolved),root:resolved,mode:'readonly',reference:true,role:'reference'});
  }
  normalizeWorkspaceRoles(data);
  writeJson(configPath(ctx), data);
  refreshPanel();
  return resolved;
}
async function addGithubReference(ctx, github){
  const baseDir = path.join(ctx.globalStorageUri.fsPath, 'references', 'github');
  ensureDir(baseDir);
  const target = path.join(baseDir, github.dirName);
  let result;
  if(fs.existsSync(path.join(target,'.git'))){
    log(`Updating GitHub reference ${github.name} in ${target}`);
    result = await runGit(['pull','--ff-only'], target);
  } else {
    if(fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`GitHub reference target exists but is not a Git repository: ${target}`);
    log(`Cloning GitHub reference ${github.name} into ${target}`);
    result = await runGit(['clone','--depth','1',github.cloneUrl,target], baseDir);
  }
  if(result.exitCode !== 0) throw new Error(`git ${result.timedOut ? 'timed out' : 'failed'}: ${(result.stderr || result.error || result.stdout || '').trim()}`);
  addReferenceWorkspace(ctx, target, github.name, github.idBase);
  return target;
}
async function addReferenceInput(ctx, value){
  const input = String(value || '').trim().replace(/^["']|["']$/g,'');
  if(!input) return vscode.window.showWarningMessage('Enter a folder path or GitHub repository URL.');
  const github = parseGithubRepo(input);
  if(github){
    output.show(true);
    try{
      const target = await addGithubReference(ctx, github);
      vscode.window.showInformationMessage(`GitHub reference ready: ${github.name}`);
      log(`GitHub reference ready: ${target}`);
    }catch(e){
      log(`GitHub reference failed: ${e.stack || e.message || e}`);
      vscode.window.showErrorMessage(`GitHub reference failed: ${e.message || e}`);
    }
    return;
  }
  try{
    const root = path.isAbsolute(input) ? input : path.resolve(currentRoot() || process.cwd(), input);
    const resolved = addReferenceWorkspace(ctx, root, path.basename(root), makeId(root));
    vscode.window.showInformationMessage(`Reference added: ${resolved}`);
  }catch(e){
    vscode.window.showErrorMessage(`Reference add failed: ${e.message || e}`);
  }
}
async function addReferenceFromClipboard(ctx){
  const text = await vscode.env.clipboard.readText();
  await addReferenceInput(ctx, text);
}
async function addOpenFolderReferences(ctx){
  const folders = vscode.workspace.workspaceFolders || [];
  const activeRoot = currentRoot();
  const roots = folders.map(f => f.uri.fsPath).filter(root => root && !samePath(root, activeRoot));
  if(!roots.length) return vscode.window.showInformationMessage('No extra VS Code workspace folders to add as references.');
  let added = 0;
  const failed = [];
  for(const root of roots){
    try{
      addReferenceWorkspace(ctx, root, path.basename(root), makeId(root));
      added++;
    }catch(e){
      failed.push(`${root}: ${e.message || e}`);
    }
  }
  if(failed.length){
    output.show(true);
    failed.forEach(item => log(`Open folder reference skipped: ${item}`));
    vscode.window.showWarningMessage(`Added ${added} reference(s), skipped ${failed.length}. See DevMate logs.`);
  } else {
    vscode.window.showInformationMessage(`Added ${added} open folder reference(s).`);
  }
}
async function addReference(ctx){
  const uris = await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Add readonly reference project'});
  if(!uris?.[0]) return;
  try{
    const root = uris[0].fsPath;
    const resolved = addReferenceWorkspace(ctx, root, path.basename(root), makeId(root));
    vscode.window.showInformationMessage(`Reference added: ${resolved}`);
  }catch(e){
    vscode.window.showErrorMessage(`Reference add failed: ${e.message || e}`);
  }
}
async function removeReference(ctx, id){
  const data = ensureConfig(ctx,false);
  const target = (data.workspaces || []).find(w => w.reference && w.id === id);
  if(!target){
    vscode.window.showWarningMessage('Reference not found.');
    refreshPanel();
    return;
  }
  data.workspaces = (data.workspaces || []).filter(w => !(w.reference && w.id === id));
  normalizeWorkspaceRoles(data);
  writeJson(configPath(ctx), data);
  refreshPanel();
  vscode.window.showInformationMessage(`Reference removed: ${target.name || target.root || id}`);
}
async function saveReferencesJson(ctx, value){
  try{
    const text = String(value || '').trim();
    let parsed = text ? JSON.parse(text) : [];
    if(parsed && !Array.isArray(parsed) && Array.isArray(parsed.references)) parsed = parsed.references;
    if(!Array.isArray(parsed)) throw new Error('References JSON must be an array, or an object with a references array.');

    const data = ensureConfig(ctx,false);
    const nonReferences = (data.workspaces || []).filter(w => !w.reference);
    const usedIds = new Set(nonReferences.map(w => w.id).filter(Boolean));
    const existingRoots = new Set(nonReferences.map(w => w.root || '').filter(Boolean).map(pathKey));
    const nextReferences = [];
    const seenRoots = new Set();

    for(let i=0; i<parsed.length; i++){
      const item = parsed[i] || {};
      if(typeof item !== 'object' || Array.isArray(item)) throw new Error(`Reference ${i + 1} must be an object.`);
      const rawRoot = String(item.root || '').trim();
      if(!rawRoot) throw new Error(`Reference ${i + 1} is missing root.`);
      const root = path.resolve(path.isAbsolute(rawRoot) ? rawRoot : path.join(currentRoot() || process.cwd(), rawRoot));
      if(!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Reference path is not a directory: ${root}`);
      const rootKey = pathKey(root);
      if(existingRoots.has(rootKey)) throw new Error(`Reference path is already a writable workspace: ${root}`);
      if(seenRoots.has(rootKey)) throw new Error(`Duplicate reference path: ${root}`);
      seenRoots.add(rootKey);

      const baseId = String(item.id || makeId(root)).replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase() || makeId(root);
      let id = baseId;
      let n = 2;
      while(usedIds.has(id)) id = `${baseId}-${n++}`;
      usedIds.add(id);
      const name = String(item.name || path.basename(root)).trim() || path.basename(root);
      nextReferences.push({id,name,root,mode:'readonly',reference:true,role:'reference'});
    }

    data.workspaces = [...nonReferences, ...nextReferences];
    normalizeWorkspaceRoles(data);
    writeJson(configPath(ctx), data);
    refreshPanel();
    vscode.window.showInformationMessage(`References saved: ${nextReferences.length}`);
  }catch(e){
    vscode.window.showErrorMessage(`References JSON invalid: ${e.message || e}`);
  }
}
async function doctor(ctx){
  const checks=[];
  const data=ensureConfig(ctx,false);
  const provider=deploymentProvider(data);
  checks.push(`Version: ${VERSION}`);
  checks.push(`VS Code workspace: ${currentRoot() || 'NONE'}`);
  checks.push(`Extension path: ${ctx.extensionPath}`);
  checks.push(`Config path: ${configPath(ctx)}`);
  checks.push(`Configured/current port: ${data.server.port}`);
  checks.push(`Connection provider: ${provider}`);
  checks.push(`Node: ${process.execPath}`);
  const git=spawnSync('git',['--version'],{encoding:'utf8',windowsHide:true}); checks.push(`git: ${git.error ? 'MISSING' : git.stdout.trim()}`);
  if(provider === 'ngrok'){
    const command=String(cfg().get('ngrokCommandPath') || 'ngrok');
    const result=spawnSync(command,['version'],{encoding:'utf8',windowsHide:true});
    checks.push(`ngrok: ${result.error ? 'MISSING' : String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0]}`);
  } else if(provider.startsWith('cloudflare')){
    const command=String(cfg().get('cloudflareCommandPath') || 'cloudflared');
    const result=spawnSync(command,['--version'],{encoding:'utf8',windowsHide:true});
    checks.push(`cloudflared: ${result.error ? 'MISSING' : String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0]}`);
  } else {
    checks.push('tunnel executable: external ingress');
  }
  const h=await healthAt(Number(data.server.port||selectedPort)); checks.push(`Gateway health: ${healthMatches(h,ctx) ? 'OK' : `not current/failed (${h.status||h.error||'no response'})`}`);
  try{
    const tunnel=currentTunnelStatus(ctx);
    checks.push(`Tunnel: ${tunnel.running ? `${tunnel.provider} ${tunnel.publicUrl || 'starting'}` : `${provider} not running`}`);
    if(tunnel.publicUrl){ try{ const test=await verifyPublicMcp(tunnel.publicUrl,ctx); checks.push(`public MCP preflight: OK tools=${test.toolCount}`); }catch(e){ checks.push(`public MCP preflight: FAILED ${e.message}`); } }
  }catch(e){ checks.push(`Tunnel: unavailable (${e.message || e})`); }
  output.show(true); checks.forEach(x=>log(`[doctor] ${x}`)); vscode.window.showInformationMessage('Doctor finished. See DevMate output.');
}

async function openSettings(){
  await vscode.commands.executeCommand('workbench.action.openSettings', 'DevMate');
}
async function setup(ctx){
  output.show(true);
  await doctor(ctx);
  const actions=[];
  if(!currentRoot()) actions.push('Open a project folder in VS Code.');
  const data=ensureConfig(ctx,false);
  const provider=deploymentProvider(data);
  if(provider === 'ngrok'){
    const command=String(cfg().get('ngrokCommandPath') || 'ngrok');
    const result=spawnSync(command,['version'],{encoding:'utf8',windowsHide:true});
    if(result.error) actions.push('Install ngrok, then configure its DevMate account and run DevMate: Start.');
  } else if(provider.startsWith('cloudflare')){
    const command=String(cfg().get('cloudflareCommandPath') || 'cloudflared');
    const result=spawnSync(command,['--version'],{encoding:'utf8',windowsHide:true});
    if(result.error) actions.push('Install cloudflared, then run DevMate: Start.');
  } else if(provider === 'external' && !String(data.connection?.publicUrl || '').trim()) {
    actions.push('Configure a stable publicUrl for the shared external connection.');
  }
  if(actions.length) vscode.window.showWarningMessage(`DevMate setup needs: ${actions.join(' ')}`);
  else vscode.window.showInformationMessage('DevMate setup looks ready. Run DevMate: Start.');
}

function panelHtml(ctx, webview){
  const data=ensureConfig(ctx,false); const root=currentRoot();
  const n = nonce();
  const publicState = currentPublicUiState(data);
  const mcpDisplay = publicState.verified
    ? redactUrl(mcpUrlFor(publicState.publicUrl))
    : publicState.state === 'failed'
      ? 'verification failed'
      : publicState.state === 'unverified'
        ? 'verification pending'
        : publicState.state === 'pending'
          ? 'tunnel starting'
          : 'not available';
  const ingressDisplay = publicState.publicUrl
    ? `${publicState.provider} ${redactUrl(publicState.publicUrl)} (${publicState.state})`
    : `${publicState.provider} (${publicState.state})`;
  const references = (data.workspaces || []).filter(w => w.reference);
  const activeWorkspace = (data.workspaces || []).find(w => w.id === data.activeWorkspaceId) || (data.workspaces || []).find(w => !w.reference);
  const workspaceState = {
    active: activeWorkspace ? {id:activeWorkspace.id,name:activeWorkspace.name,root:activeWorkspace.root,mode:activeWorkspace.mode} : null,
    references: references.length
  };
  const referenceJson = JSON.stringify(references.map(w => ({id:w.id,name:w.name,root:w.root})), null, 2);
  const referenceList = references.length
    ? references.map(w => `<div class="ref-row"><div class="ref-main"><strong>${esc(w.name || w.id)}</strong><code>${esc(w.root || '')}</code></div><button class="secondary danger" data-cmd="removeReference" data-id="${esc(w.id)}">Remove</button></div>`).join('')
    : '<p class="muted">No readonly reference projects yet.</p>';
  return `<!doctype html><html><head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
  <style>
    body{font-family:var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); padding:20px; line-height:1.45;}
    h2{margin:0 0 12px; font-size:24px;}
    h3{margin:22px 0 8px; font-size:16px;}
    code{font-family:var(--vscode-editor-font-family); background:var(--vscode-textCodeBlock-background); padding:2px 4px; border-radius:4px;}
    button{border:1px solid var(--vscode-button-border, transparent); background:var(--vscode-button-background); color:var(--vscode-button-foreground); padding:5px 10px; border-radius:4px; cursor:pointer;}
    button:hover{background:var(--vscode-button-hoverBackground);}
    button.secondary{background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);}
    button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground);}
    button.danger{border-color:var(--vscode-inputValidation-errorBorder);}
    input,textarea{box-sizing:border-box; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border-radius:4px; padding:6px 8px;}
    textarea{width:100%; font-family:var(--vscode-editor-font-family); resize:vertical;}
    details{margin-top:14px; border-top:1px solid var(--vscode-panel-border); padding-top:12px;}
    summary{cursor:pointer; font-weight:600;}
    .muted{color:var(--vscode-descriptionForeground);}
    .section{border-top:1px solid var(--vscode-panel-border); padding-top:14px; margin-top:16px;}
    .toolbar{display:flex; flex-wrap:wrap; gap:8px; margin:10px 0;}
    .status-grid{display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 12px; max-width:980px;}
    .input-row{display:flex; gap:8px; align-items:center; max-width:980px;}
    .input-row input{flex:1; min-width:220px;}
    .ref-list{max-width:980px; margin-top:10px;}
    .ref-row{display:flex; align-items:center; justify-content:space-between; gap:12px; border-top:1px solid var(--vscode-panel-border); padding:9px 0;}
    .ref-main{min-width:0; display:flex; flex-direction:column; gap:4px;}
    .ref-main code{display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
    .flow{margin-top:18px;}
  </style>
  </head><body>
  <h2>DevMate ${VERSION}</h2>
  <div class="status-grid">
    <b>Active project</b><code>${esc(root || 'Open a VS Code folder first')}</code>
    <b>MCP</b><code>${esc(mcpDisplay)}</code>
    <b>Public ingress</b><code>${esc(ingressDisplay)}</code>
    <b>Local</b><code>127.0.0.1:${esc(data.server.port)}/mcp · internal only</code>
    <b>Auth</b><code>${esc(data.auth?.required ? 'token required' : 'disabled')}</code>
    <b>Permissions</b><code>${esc(data.permissions?.profile || 'fullAccess')}</code>
    <b>Last preflight</b><code>${esc(data.connection?.lastPreflightAt ? `${data.connection.lastPreflightAt} ${data.connection.lastPublicHost || ''}` : 'not recorded')}</code>
    <b>Start command</b><code>${esc(startCommandProcess ? 'running' : (String(cfg().get('defaultStartCommand') || '').trim() || 'not configured'))}</code>
  </div>
  <div class="toolbar">
    <button data-cmd="quickStart">Start</button>
    <button data-cmd="copyUrl">Copy URL</button>
    <button class="secondary" data-cmd="stop">Stop</button>
    <button class="secondary" data-cmd="doctor">Doctor</button>
    <button class="secondary" data-cmd="starter">Copy Prompt</button>
    <button class="secondary" data-cmd="copyContext">Copy Context</button>
    <button class="secondary" data-cmd="settings">Settings</button>
    <button class="secondary" data-cmd="logs">Logs</button>
  </div>
  <div class="section">
    <h3>References</h3>
    <div class="input-row">
      <input id="referenceInput" placeholder="Folder path or https://github.com/owner/repo">
      <button data-cmd="addReferenceInput">Add</button>
      <button class="secondary" data-cmd="addReferenceClipboard">From Clipboard</button>
      <button class="secondary" data-cmd="addReference">Browse</button>
      <button class="secondary" data-cmd="addOpenFolders">Open Folders</button>
    </div>
    <div class="ref-list">${referenceList}</div>
    <details>
      <summary>Advanced reference editing</summary>
      <p class="muted">Edit references as JSON only when bulk changes are faster than the buttons above.</p>
      <textarea id="referencesJson" rows="9">${esc(referenceJson)}</textarea>
      <div class="toolbar">
        <button data-cmd="saveReferencesJson">Save JSON</button>
        <button class="secondary danger" data-cmd="clearReferences">Clear All References</button>
      </div>
    </details>
  </div>
  <details>
    <summary>Workspace state</summary>
    <p class="muted">DevMate keeps one writable active workspace. Add other projects as readonly references.</p>
    <pre>${esc(JSON.stringify(workspaceState,null,2))}</pre>
  </details>
  <p class="flow muted">Daily flow: open project -> <b>Start</b> -> paste URL into ChatGPT App -> say “使用 DevMate，完成这个开发任务”。</p>
  <script nonce="${n}">
  const vscode=acquireVsCodeApi();
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-cmd]');
    if(!button) return;
    const message = {cmd: button.dataset.cmd};
    if(message.cmd === 'addReferenceInput') message.value = document.getElementById('referenceInput')?.value || '';
    if(message.cmd === 'saveReferencesJson') message.value = document.getElementById('referencesJson')?.value || '';
    if(message.cmd === 'removeReference') message.id = button.dataset.id || '';
    vscode.postMessage(message);
  });
  document.getElementById('referenceInput')?.addEventListener('keydown', event => {
    if(event.key === 'Enter') vscode.postMessage({cmd:'addReferenceInput', value:event.currentTarget.value || ''});
  });
  </script></body></html>`;
}
function refreshPanel(){ if(panel && globalContext) panel.webview.html=panelHtml(globalContext, panel.webview); }
function openPanel(ctx){
  if(panel){ panel.reveal(); refreshPanel(); return; }
  panel = vscode.window.createWebviewPanel('devMate','DevMate',vscode.ViewColumn.One,{enableScripts:true});
  panel.onDidDispose(()=>panel=null);
  panel.webview.onDidReceiveMessage(async m=>{
    if(m.cmd==='quickStart') await lifecycleOperations.run('start',()=>quickStart(ctx));
    if(m.cmd==='copyUrl') await copyUrl();
    if(m.cmd==='stop') await lifecycleOperations.run('stop',()=>stopAll());
    if(m.cmd==='doctor') await doctor(ctx);
    if(m.cmd==='addReference') await addReference(ctx);
    if(m.cmd==='addReferenceInput') await addReferenceInput(ctx, m.value);
    if(m.cmd==='addReferenceClipboard') await addReferenceFromClipboard(ctx);
    if(m.cmd==='addOpenFolders') await addOpenFolderReferences(ctx);
    if(m.cmd==='removeReference') await removeReference(ctx, m.id);
    if(m.cmd==='saveReferencesJson') await saveReferencesJson(ctx, m.value);
    if(m.cmd==='clearReferences') await clearReferences(ctx);
    if(m.cmd==='starter') await copyStarterPrompt();
    if(m.cmd==='copyContext') await copyContextBundle(ctx);
    if(m.cmd==='logs') output.show(true);
    if(m.cmd==='settings') await openSettings();
  });
  refreshPanel();
}

async function clearReferences(ctx){
  const confirm = await vscode.window.showWarningMessage('Clear all reference projects from DevMate config?', {modal:true}, 'Clear References');
  if(confirm !== 'Clear References') return;
  const data = ensureConfig(ctx,false);
  data.workspaces = (data.workspaces || []).filter(w => !w.reference);
  normalizeWorkspaceRoles(data);
  writeJson(configPath(ctx), data);
  refreshPanel();
  vscode.window.showInformationMessage('Reference projects cleared.');
}
async function exportSource(ctx){
  const target = await vscode.window.showOpenDialog({canSelectFolders:true, canSelectFiles:false, canSelectMany:false, openLabel:'Export source here'});
  if(!target?.[0]) return;
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const outDir = path.join(target[0].fsPath, `devmate-source-${stamp}`);
  fs.mkdirSync(outDir, {recursive:true});
  const skipDirs = new Set(['.git','node_modules','tmp','.vscode']);
  function shouldSkip(src){ const name=path.basename(src); return skipDirs.has(name) || /\.(vsix|tgz|log)$/i.test(name) || /^npm-debug\.log/i.test(name) || /^yarn-(debug|error)\.log/i.test(name); }
  function cp(src,dst){ if(shouldSkip(src)) return; const st=fs.statSync(src); if(st.isDirectory()){ fs.mkdirSync(dst,{recursive:true}); for(const e of fs.readdirSync(src)) cp(path.join(src,e), path.join(dst,e)); } else fs.copyFileSync(src,dst); }
  cp(ctx.extensionPath, outDir);
  vscode.window.showInformationMessage(`Source exported: ${outDir}`);
}

function register(ctx, id, fn){ ctx.subscriptions.push(vscode.commands.registerCommand(id, fn)); }
function activate(context){
  globalContext=context;
  output = vscode.window.createOutputChannel('DevMate'); context.subscriptions.push(output);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100); statusBar.command='devMate.open'; context.subscriptions.push(statusBar); setStatus('DevMate');
  ensureConfig(context,false);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(()=>scheduleContextRefresh(context)));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(()=>scheduleContextRefresh(context)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(()=>scheduleContextRefresh(context)));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(()=>scheduleContextRefresh(context)));
  register(context,'devMate.start',()=>lifecycleOperations.run('start',()=>quickStart(context)));
  register(context,'devMate.open',()=>openPanel(context));
  register(context,'devMate.stop',()=>lifecycleOperations.run('stop',()=>stopAll()));
  register(context,'devMate.restart',()=>lifecycleOperations.run('restart',async()=>{const stopped=await stopAll(); if(!stopped.ok) return stopped; return quickStart(context);}));
  register(context,'devMate.copyUrl',()=>copyUrl());
  register(context,'devMate.copyToken',()=>copyConnectionToken(context));
  register(context,'devMate.addReference',()=>addReference(context));
  register(context,'devMate.clearReferences',()=>clearReferences(context));
  register(context,'devMate.doctor',()=>doctor(context));
  register(context,'devMate.logs',()=>output.show(true));
  register(context,'devMate.exportSource',()=>exportSource(context));
  register(context,'devMate.setup',()=>setup(context));
  register(context,'devMate.copyPrompt',()=>copyStarterPrompt());
  register(context,'devMate.copyContextBundle',()=>copyContextBundle(context));
  register(context,'devMate.openSettings',()=>openSettings());
  register(context,'devMate.syncPublicState',()=>syncPublicUiState(context));

  log(`Activated DevMate ${VERSION}`);
}
function deactivate(){
  if(contextWriteTimer) clearTimeout(contextWriteTimer);
  contextWriteTimer=null;
  return lifecycleOperations.run('deactivate',async()=>{
    const stopped = await stopAll();
    if(!stopped.sharedStillActive) await gatewayController?.dispose({stopOwned:true});
    gatewayController = null;
    gatewayControllerKey = '';
    gatewayProcess = null;
    return stopped;
  });
}
module.exports = { activate, deactivate };
