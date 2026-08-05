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
  'extension.js',
  "const { spawn, spawnSync } = require('child_process');\n",
  "const { spawn, spawnSync } = require('child_process');\nconst { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');\n",
  'operation coordinator import'
);

replaceOnce(
  'extension.js',
  "let contextWriteTimer = null;\n",
  "let contextWriteTimer = null;\nconst lifecycleOperations = new OperationCoordinator({ name: 'vscode-legacy-lifecycle' });\n",
  'legacy lifecycle coordinator declaration'
);

replaceOnce(
  'extension.js',
`function spawnNode(script, env){
  const child = spawn(process.execPath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',...env}, windowsHide:true});
  child.stdout.on('data',d=>log(\`[gateway] \${String(d).trimEnd()}\`));
  child.stderr.on('data',d=>log(\`[gateway:err] \${String(d).trimEnd()}\`));
  child.on('error',e=>log(\`Gateway process error: \${e.message}\`));
  child.on('exit',(code,signal)=>{log(\`Gateway exited code=\${code} signal=\${signal}\`); gatewayProcess=null; setStatus('DevMate: stopped'); refreshPanel();});
  return child;
}
`,
`function spawnNode(script, env){
  const child = spawn(process.execPath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',...env}, windowsHide:true});
  child.stdout.on('data',d=>log(\`[gateway] \${String(d).trimEnd()}\`));
  child.stderr.on('data',d=>log(\`[gateway:err] \${String(d).trimEnd()}\`));
  child.on('error',e=>log(\`Gateway process error: \${e.message}\`));
  child.on('exit',(code,signal)=>{log(\`Gateway exited code=\${code} signal=\${signal}\`); if(gatewayProcess === child) gatewayProcess=null; setStatus('DevMate: stopped'); refreshPanel();});
  return child;
}
function waitForProcessExit(child, timeoutMs=8000){
  if(!child || child.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve=>child.once('exit',()=>resolve(true))),
    new Promise(resolve=>setTimeout(()=>resolve(false), Math.max(250, Number(timeoutMs) || 8000)))
  ]);
}
async function stopGatewayProcess(){
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
  'Gateway process helpers'
);

replaceOnce(
  'extension.js',
`async function startGateway(ctx){
  if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
  // If our exact current gateway is already up, reuse it.
  if(await isCurrentGatewayUp(ctx)){ log('Current gateway already listening.'); setStatus('DevMate: on'); runDefaultStartCommand(); return; }
  const p = await choosePort(ctx);
  ensureConfig(ctx,true,p);
  if(gatewayProcess){ try{ gatewayProcess.kill(); }catch{} gatewayProcess=null; }
  gatewayProcess = spawnNode(gatewayPath(ctx), { DEVMATE_CONFIG: configPath(ctx), DEVMATE_PUBLIC_HEALTH_DETAILS: cfg().get('publicHealthDetails') ? '1' : '0' });
  for(let i=0;i<40;i++){
    await new Promise(r=>setTimeout(r,250));
    const r = await healthAt(p);
    if(healthMatches(r, ctx)){ setStatus(\`DevMate: on :\${p}\`); log(\`Gateway ready on port \${p}.\`); runDefaultStartCommand(); return; }
  }
  try{ if(gatewayProcess) gatewayProcess.kill(); }catch{}
  gatewayProcess = null;
  throw new Error('Gateway did not become ready. Open Show Logs for details.');
}
`,
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
  'serialized Gateway startup'
);

replaceOnce(
  'extension.js',
`async function quickStart(ctx){
  try{
    output.show(true);
    if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
    await startGateway(ctx);
    const publicUrl = await startNgrok(ctx);
    log('Running public MCP preflight through ngrok before copying URL...');
    const test = await mcpHandshakeTest(publicUrl, ctx);
    const stamp = new Date().toISOString();
    if(cfg().get('autoCopyUrl')) await vscode.env.clipboard.writeText(test.mcp);
    updateConnectionSnapshot(ctx, {
      lastPreflightAt: stamp,
      lastCopiedAt: cfg().get('autoCopyUrl') ? stamp : undefined,
      lastPublicHost: publicHost(publicUrl),
      lastMcpPath: MCP_PATH,
      lastToolCount: test.toolCount,
      lastServerName: test.server?.name || 'devmate',
      lastError: '',
      lastErrorAt: null
    });
    setStatus('DevMate: ready');
    log(\`Public MCP preflight OK: \${redactUrl(test.mcp)}, tools=\${test.toolCount}\`);
    vscode.window.showInformationMessage(cfg().get('autoCopyUrl') ? \`Ready. ChatGPT MCP URL copied and verified: \${redactUrl(test.mcp)}\` : \`Ready. Verified MCP URL: \${redactUrl(test.mcp)}\`);
    refreshPanel();
  }catch(e){ updateConnectionSnapshot(ctx,{lastError:String(e.message || e),lastErrorAt:new Date().toISOString()}); log(\`ERROR: \${e.stack || e.message || e}\`); vscode.window.showErrorMessage(\`DevMate failed: \${e.message || e}\`); }
}
`,
`async function quickStart(ctx){
  try{
    output.show(true);
    if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
    const gateway = await startGateway(ctx);
    const publicUrl = await startNgrok(ctx);
    log('Running public MCP preflight through ngrok before copying URL...');
    const test = await mcpHandshakeTest(publicUrl, ctx);
    const stamp = new Date().toISOString();
    if(cfg().get('autoCopyUrl')) await vscode.env.clipboard.writeText(test.mcp);
    updateConnectionSnapshot(ctx, {
      lastPreflightAt: stamp,
      lastCopiedAt: cfg().get('autoCopyUrl') ? stamp : undefined,
      lastPublicHost: publicHost(publicUrl),
      lastMcpPath: MCP_PATH,
      lastToolCount: test.toolCount,
      lastServerName: test.server?.name || 'devmate',
      lastError: '',
      lastErrorAt: null
    });
    setStatus('DevMate: ready');
    log(\`Public MCP preflight OK: \${redactUrl(test.mcp)}, tools=\${test.toolCount}\`);
    vscode.window.showInformationMessage(cfg().get('autoCopyUrl') ? \`Ready. ChatGPT MCP URL copied and verified: \${redactUrl(test.mcp)}\` : \`Ready. Verified MCP URL: \${redactUrl(test.mcp)}\`);
    refreshPanel();
    return {ok:true,gateway,publicUrl,toolCount:test.toolCount,server:test.server};
  }catch(e){
    const message = String(e.message || e);
    updateConnectionSnapshot(ctx,{lastError:message,lastErrorAt:new Date().toISOString()});
    log(\`ERROR: \${e.stack || e.message || e}\`);
    vscode.window.showErrorMessage(\`DevMate failed: \${message}\`);
    return {ok:false,error:message,code:e.code || 'DEVMATE_START_FAILED'};
  }
}
`,
  'structured quickStart result'
);

replaceOnce(
  'extension.js',
`async function stopAll(){
  if(globalContext){
    try{
      const data = ensureConfig(globalContext,false);
      const port = Number(data.server.port || selectedPort);
      const tunnels = (await getNgrokTunnels()).filter(t => tunnelPort(t) === port);
      if(tunnels.length) await stopNgrokTunnels(tunnels);
    }catch(e){ log(\`Could not stop ngrok tunnel cleanly: \${e.message || e}\`); }
  }
  try{ if(gatewayProcess) gatewayProcess.kill(); }catch{}
  try{ if(ngrokProcess) ngrokProcess.kill(); }catch{}
  stopStartCommand();
  gatewayProcess=null; ngrokProcess=null; lastPublicUrl=''; setStatus('DevMate: stopped'); refreshPanel();
}
`,
`async function stopAll(){
  if(globalContext){
    try{
      const data = ensureConfig(globalContext,false);
      const port = Number(data.server.port || selectedPort);
      const tunnels = (await getNgrokTunnels()).filter(t => tunnelPort(t) === port);
      if(tunnels.length) await stopNgrokTunnels(tunnels);
    }catch(e){ log(\`Could not stop ngrok tunnel cleanly: \${e.message || e}\`); }
  }
  const gateway = await stopGatewayProcess();
  try{ if(ngrokProcess) ngrokProcess.kill(); }catch{}
  stopStartCommand();
  ngrokProcess=null; lastPublicUrl=''; setStatus('DevMate: stopped'); refreshPanel();
  return {ok:gateway.stopped || gateway.reason === 'not-running',gateway};
}
`,
  'awaited Gateway stop'
);

replaceOnce(
  'extension.js',
`    if(m.cmd==='quickStart') await quickStart(ctx);
    if(m.cmd==='copyUrl') await copyUrl();
    if(m.cmd==='stop') await stopAll();
`,
`    if(m.cmd==='quickStart') await lifecycleOperations.run('start',()=>quickStart(ctx));
    if(m.cmd==='copyUrl') await copyUrl();
    if(m.cmd==='stop') await lifecycleOperations.run('stop',()=>stopAll());
`,
  'Webview lifecycle serialization'
);

replaceOnce(
  'extension.js',
`  register(context,'devMate.start',()=>quickStart(context));
  register(context,'devMate.open',()=>openPanel(context));
  register(context,'devMate.stop',()=>stopAll());
  register(context,'devMate.restart',async()=>{await stopAll(); await quickStart(context);});
`,
`  register(context,'devMate.start',()=>lifecycleOperations.run('start',()=>quickStart(context)));
  register(context,'devMate.open',()=>openPanel(context));
  register(context,'devMate.stop',()=>lifecycleOperations.run('stop',()=>stopAll()));
  register(context,'devMate.restart',()=>lifecycleOperations.run('restart',async()=>{await stopAll(); return quickStart(context);}));
`,
  'command lifecycle serialization'
);

replaceOnce(
  'extension.js',
  "function deactivate(){ if(contextWriteTimer) clearTimeout(contextWriteTimer); contextWriteTimer=null; return stopAll(); }\n",
  "function deactivate(){ if(contextWriteTimer) clearTimeout(contextWriteTimer); contextWriteTimer=null; return lifecycleOperations.run('deactivate',()=>stopAll()); }\n",
  'serialized deactivation'
);

replaceOnce(
  'host/runtime/process-controller.js',
  "const { ensurePersonalConfig, readJson, updateConfig } = require('./config-store.js');\n",
  "const { ensurePersonalConfig, readJson, updateConfig } = require('./config-store.js');\nconst { cleanupOwnedGatewayInstanceLock } = require('./instance-lock-cleanup.js');\n",
  'owned Gateway lock cleanup import'
);

replaceOnce(
  'host/runtime/process-controller.js',
`        launch.forcedTermination = !!child.forceTerminated;
        this.logger(\`Gateway exited code=\${code} signal=\${signal}\`);
        if (this.child === child) {
`,
`        launch.forcedTermination = !!child.forceTerminated;
        const cleanup = cleanupOwnedGatewayInstanceLock({
          stateDirectory: this.stateDirectory,
          runtimeOwnerId: launch.ownerId,
          pid: launch.pid || child.pid || process.pid
        });
        if (cleanup.removed) this.logger(\`Removed exited Gateway lock for \${launch.ownerId}.\`);
        this.logger(\`Gateway exited code=\${code} signal=\${signal}\`);
        if (this.child === child) {
`,
  'RuntimeController exited lock cleanup'
);

console.log('Applied asserted DevMate runtime concurrency patch.');
