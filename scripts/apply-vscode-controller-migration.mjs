#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function replaceOnce(relativePath, from, to, label) {
  const file = path.join(root, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Could not locate ${label} in ${relativePath}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`Found multiple ${label} matches in ${relativePath}`);
  fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
}

replaceOnce(
  'host/runtime/config-store.js',
`function quarantineConfig(file, reason = 'corrupt') {
  if (!fs.existsSync(file)) return null;
  const quarantined = \`${'${file}'}.${'${reason}'}-${'${Date.now()}'}-${'${crypto.randomBytes(4).toString(\'hex\')}'}\`;
`,
`function quarantineConfig(file, reason = 'corrupt') {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const quarantined = \`${'${file}'}.${'${reason}'}-${'${Date.now()}'}-${'${crypto.randomBytes(4).toString(\'hex\')}'}\`;
`,
  'file-only config quarantine'
);

replaceOnce(
  'host/runtime/config-store.js',
`  cleanupReplacementCandidates(candidates);
  if (mainError) {
`,
`  if (!mainError && !main?.exists && candidates.length) {
    const error = configError('DevMate config is missing and interrupted replacement files are not valid', 'config_recovery_failed', file);
    error.replacementCandidates = candidates.map(candidate => candidate.file);
    throw error;
  }

  cleanupReplacementCandidates(candidates);
  if (mainError) {
`,
  'invalid replacement recovery refusal'
);

replaceOnce(
  'host/runtime/config-store.js',
`    hostContexts: {},
    activeHostId: null,
`,
`    hostRuntime: { workspaceRoot: normalizedWorkspaceRoot(root) },
    hostContexts: {},
    activeHostId: null,
`,
  'new config workspace binding'
);

replaceOnce(
  'host/runtime/config-store.js',
`    config.instanceId ||= \`host-${'${Date.now().toString(36)}'}-${'${crypto.randomBytes(4).toString(\'hex\')}'}\`;
    config.server ||= {};
`,
`    config.instanceId ||= \`host-${'${Date.now().toString(36)}'}-${'${crypto.randomBytes(4).toString(\'hex\')}'}\`;
    config.hostRuntime ||= {};
    const boundWorkspace = String(config.hostRuntime.workspaceRoot || '');
    if (boundWorkspace && boundWorkspace !== rootKey) {
      const error = configError('DevMate state directory is bound to a different workspace', 'config_workspace_mismatch', file);
      error.boundWorkspaceRoot = boundWorkspace;
      error.requestedWorkspaceRoot = rootKey;
      throw error;
    }
    config.hostRuntime.workspaceRoot = rootKey;
    config.server ||= {};
`,
  'existing config workspace binding'
);

replaceOnce(
  'host/runtime/process-controller.js',
`  async status() {
    const config = this.ensureConfig();
`,
`  async status() {
    if (this.disposed) return { state: 'disposed', phase: 'disposed', attached: false, owned: false };
    const config = this.ensureConfig();
`,
  'disposed runtime status'
);

replaceOnce(
  'host/runtime/process-controller.js',
`  async stopInternal() {
    const child = this.activeOwnedChild();
`,
`  async stopInternal() {
    if (this.disposed) return { stopped: false, reason: 'disposed' };
    const child = this.activeOwnedChild();
`,
  'disposed runtime stop'
);

replaceOnce(
  'extension.js',
`const { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');
`,
`const { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');
const { RuntimeController } = require('./host/runtime-controller.js');
`,
  'VS Code RuntimeController import'
);

replaceOnce(
  'extension.js',
`let gatewayProcess = null;
let ngrokProcess = null;
`,
`let gatewayProcess = null;
let gatewayController = null;
let gatewayControllerKey = '';
let ngrokProcess = null;
`,
  'VS Code controller state'
);

replaceOnce(
  'extension.js',
`function spawnNode(script, env){
  const child = spawn(process.execPath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',...env}, windowsHide:true});
  child.stdout.on('data',d=>log(\`[gateway] \${String(d).trimEnd()}\`));
  child.stderr.on('data',d=>log(\`[gateway:err] \${String(d).trimEnd()}\`));
  child.on('error',e=>log(\`Gateway process error: \${e.message}\`));
  child.on('exit',(code,signal)=>{log(\`Gateway exited code=\${code} signal=\${signal}\`); if(gatewayProcess === child) gatewayProcess=null; setStatus('DevMate: stopped'); refreshPanel();});
  return child;
}
function waitForProcessExit(child, timeoutMs=8000){
`,
`function waitForProcessExit(child, timeoutMs=8000){
`,
  'remove direct Gateway spawner'
);

replaceOnce(
  'extension.js',
`async function stopGatewayProcess(){
  const child = gatewayProcess;
  if(!child) return {stopped:false,reason:'not-running'};
  try{ if(child.exitCode == null && !child.killed && !child.terminating) child.kill(); }catch(e){ return {stopped:false,reason:e.message || String(e)}; }
  let exited = await waitForProcessExit(child, 8000);
  if(!exited && typeof child.forceTerminate === 'function'){
    try{ child.forceTerminate(); }catch{}
    exited = await waitForProcessExit(child, 2500);
  }
  if(exited && gatewayProcess === child) gatewayProcess = null;
  return {stopped:exited,forced:!!child.forceTerminated,reason:exited ? '' : 'process-exit-timeout'};
}
`,
`async function ensureGatewayController(ctx){
  const root = currentRoot();
  if(!root) throw new Error('Open a VS Code project folder first.');
  const stateDirectory = path.resolve(ctx.globalStorageUri.fsPath);
  const key = \`${'${pathKey(root)}'}|${'${pathKey(stateDirectory)}'}\`;
  if(gatewayController && gatewayControllerKey === key){
    gatewayController.preferredPort = configuredPort();
    gatewayController.gatewayEntry = gatewayPath(ctx);
    return gatewayController;
  }
  if(gatewayController){
    const disposed = await gatewayController.dispose({stopOwned:true});
    if(disposed?.disposed === false) throw new Error(\`Previous Gateway controller could not be disposed: \${disposed.reason || 'unknown error'}\`);
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
  if(!child || child.__devMateLegacyTracked) return;
  child.__devMateLegacyTracked = true;
  child.once('exit',(code,signal)=>{
    if(gatewayProcess !== child) return;
    gatewayProcess = null;
    log(\`Gateway exited code=\${code} signal=\${signal}\`);
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
`,
  'RuntimeController-backed Gateway lifecycle'
);

replaceOnce(
  'extension.js',
`function stopStartCommand(){
  try{ if(startCommandProcess) startCommandProcess.kill(); }catch{}
  startCommandProcess = null;
}
`,
`async function stopStartCommand(){
  const child = startCommandProcess;
  if(!child) return {stopped:false,reason:'not-running'};
  try{ if(child.exitCode == null && !child.killed) child.kill(); }catch(e){ return {stopped:false,reason:e.message || String(e)}; }
  const exited = await waitForProcessExit(child, 4000);
  if(exited && startCommandProcess === child) startCommandProcess = null;
  return {stopped:exited,reason:exited ? '' : 'process-exit-timeout'};
}
`,
  'awaited default command stop'
);

replaceOnce(
  'extension.js',
`  startCommandProcess = spawn(command, [], { cwd, shell: true, windowsHide: true });
  startCommandProcess.stdout?.on('data',d=>log(\`[start] \${String(d).trimEnd()}\`));
  startCommandProcess.stderr?.on('data',d=>log(\`[start:err] \${String(d).trimEnd()}\`));
  startCommandProcess.on('error',e=>log(\`Default start command error: \${e.message}\`));
  startCommandProcess.on('exit',(code,signal)=>{log(\`Default start command exited code=\${code} signal=\${signal}\`); startCommandProcess=null; refreshPanel();});
`,
`  const child = spawn(command, [], { cwd, shell: true, windowsHide: true });
  startCommandProcess = child;
  child.stdout?.on('data',d=>log(\`[start] \${String(d).trimEnd()}\`));
  child.stderr?.on('data',d=>log(\`[start:err] \${String(d).trimEnd()}\`));
  child.on('error',e=>log(\`Default start command error: \${e.message}\`));
  child.on('exit',(code,signal)=>{
    log(\`Default start command exited code=\${code} signal=\${signal}\`);
    if(startCommandProcess === child) startCommandProcess=null;
    refreshPanel();
  });
`,
  'default command identity guard'
);

replaceOnce(
  'extension.js',
`async function startGateway(ctx){
  if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
  if(await isCurrentGatewayUp(ctx)){
    const data = ensureConfig(ctx,false);
    log('Current gateway already listening.');
    setStatus('DevMate: on');
    runDefaultStartCommand();
    return {started:false,attached:!gatewayProcess,port:Number(data.server.port || selectedPort)};
  }
  const p = await choosePort(ctx);
  ensureConfig(ctx,true,p);
  if(gatewayProcess){
    const previous = await stopGatewayProcess();
    if(!previous.stopped && previous.reason !== 'not-running') throw new Error(\`Previous Gateway did not stop: \${previous.reason}\`);
  }
  gatewayProcess = spawnNode(gatewayPath(ctx), { DEVMATE_CONFIG: configPath(ctx), DEVMATE_PUBLIC_HEALTH_DETAILS: cfg().get('publicHealthDetails') ? '1' : '0' });
  for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,250));
    const r = await healthAt(p);
    if(healthMatches(r, ctx)){
      setStatus(\`DevMate: on :\${p}\`);
      log(\`Gateway ready on port \${p}.\`);
      runDefaultStartCommand();
      return {started:true,attached:false,port:p,health:r.json};
    }
    if(gatewayProcess?.exitCode != null) break;
  }
  const stopped = await stopGatewayProcess();
  throw new Error(\`Gateway did not become ready.\${stopped.reason ? \` Cleanup: \${stopped.reason}.\` : ''} Open Show Logs for details.\`);
}
`,
`async function startGateway(ctx){
  const controller = await ensureGatewayController(ctx);
  ensureConfig(ctx,true);
  const result = await controller.start({timeoutMs:20000});
  gatewayProcess = controller.child;
  trackGatewayProcess(gatewayProcess);
  setStatus(\`DevMate: on :\${result.port}\`);
  log(result.attached
    ? \`Attached to shared DevMate Gateway on port \${result.port}.\`
    : \`Gateway ready on port \${result.port}.\`);
  runDefaultStartCommand();
  return result;
}
`,
  'actual VS Code RuntimeController startup'
);

replaceOnce(
  'extension.js',
`async function stopNgrokTunnels(tunnels=[]){
  try{ if(ngrokProcess) ngrokProcess.kill(); }catch{}
  ngrokProcess=null; lastPublicUrl='';
  for(const t of tunnels){
    const ok = await deleteNgrokTunnel(t);
    log(ok ? \`Stopped ngrok tunnel \${t.public_url || t.name}.\` : \`Could not stop ngrok tunnel \${t.public_url || t.name}; it may be owned by another process.\`);
  }
}
`,
`async function stopNgrokTunnels(tunnels=[]){
  const child = ngrokProcess;
  if(!child){
    if(tunnels.length) log('Leaving existing tunnel running because this VS Code host does not own its process.');
    return {stopped:false,reason:'managed-by-another-host'};
  }
  try{ if(child.exitCode == null && !child.killed) child.kill(); }catch{}
  const exited = await waitForProcessExit(child, 5000);
  if(ngrokProcess === child) ngrokProcess=null;
  lastPublicUrl='';
  for(const t of tunnels){
    const ok = await deleteNgrokTunnel(t);
    log(ok ? \`Stopped owned tunnel \${t.public_url || t.name}.\` : \`Could not stop owned tunnel \${t.public_url || t.name}.\`);
  }
  return {stopped:exited,reason:exited ? '' : 'process-exit-timeout'};
}
`,
  'owned tunnel shutdown'
);

replaceOnce(
  'extension.js',
`  if(ngrokProcess && !ngrokProcess.killed){
    try{ ngrokProcess.kill(); log('Stopped previous DevMate ngrok process before starting current port.'); }catch{}
    ngrokProcess = null;
    lastPublicUrl = '';
  }
`,
`  if(ngrokProcess && ngrokProcess.exitCode == null){
    const previous = ngrokProcess;
    try{ if(!previous.killed) previous.kill(); }catch{}
    await waitForProcessExit(previous, 5000);
    if(ngrokProcess === previous) ngrokProcess = null;
    lastPublicUrl = '';
    log('Stopped previous owned tunnel process before starting the current port.');
  }
`,
  'awaited previous tunnel shutdown'
);

replaceOnce(
  'extension.js',
`  ngrokProcess = spawn(exe,['http',String(p)],{windowsHide:true});
  ngrokProcess.stdout.on('data',d=>log(\`[ngrok] \${String(d).trimEnd()}\`));
  ngrokProcess.stderr.on('data',d=>log(\`[ngrok:err] \${String(d).trimEnd()}\`));
  ngrokProcess.on('exit',(code,signal)=>{log(\`ngrok exited code=\${code} signal=\${signal}\`); ngrokProcess=null; lastPublicUrl=''; refreshPanel();});
`,
`  const child = spawn(exe,['http',String(p)],{windowsHide:true});
  ngrokProcess = child;
  child.stdout.on('data',d=>log(\`[ngrok] \${String(d).trimEnd()}\`));
  child.stderr.on('data',d=>log(\`[ngrok:err] \${String(d).trimEnd()}\`));
  child.on('exit',(code,signal)=>{
    log(\`ngrok exited code=\${code} signal=\${signal}\`);
    if(ngrokProcess === child){ ngrokProcess=null; lastPublicUrl=''; }
    refreshPanel();
  });
`,
  'tunnel process identity guard'
);

replaceOnce(
  'extension.js',
`      const tunnels = (await getNgrokTunnels()).filter(t => tunnelPort(t) === port);
      if(tunnels.length) await stopNgrokTunnels(tunnels);
`,
`      const tunnels = (await getNgrokTunnels()).filter(t => tunnelPort(t) === port);
      if(tunnels.length || ngrokProcess) await stopNgrokTunnels(tunnels);
`,
  'owned tunnel stop invocation'
);

replaceOnce(
  'extension.js',
`  try{ if(ngrokProcess) ngrokProcess.kill(); }catch{}
  stopStartCommand();
  ngrokProcess=null; lastPublicUrl=''; setStatus('DevMate: stopped'); refreshPanel();
`,
`  await stopStartCommand();
  lastPublicUrl=''; setStatus('DevMate: stopped'); refreshPanel();
`,
  'awaited auxiliary process cleanup'
);

replaceOnce(
  'extension.js',
`function deactivate(){ if(contextWriteTimer) clearTimeout(contextWriteTimer); contextWriteTimer=null; return lifecycleOperations.run('deactivate',()=>stopAll()); }
`,
`function deactivate(){
  if(contextWriteTimer) clearTimeout(contextWriteTimer);
  contextWriteTimer=null;
  return lifecycleOperations.run('deactivate',async()=>{
    const stopped = await stopAll();
    await gatewayController?.dispose({stopOwned:true});
    gatewayController = null;
    gatewayControllerKey = '';
    gatewayProcess = null;
    return stopped;
  });
}
`,
  'VS Code controller disposal'
);

console.log('Applied asserted VS Code RuntimeController migration.');
