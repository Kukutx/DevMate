import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { automationPlugin } from './engines/automation.mjs';
import { browserControlPlugin } from './engines/browser-control.mjs';
import { browserQaPlugin } from './engines/browser-qa.mjs';
import { reversePlugin } from './engines/reverse.mjs';
import { createEngineState } from './engine-state.mjs';
import { finalGodotPlugin } from './engines/godot-final.mjs';
import { engineEnvironment, engineEnvironmentAllows, findExecutable } from './engines/engine-io.mjs';
import { executeCommand } from './platform/command-process.mjs';
import { resolveProjectPath } from './workspace.mjs';
import { DomainError } from './store.mjs';
import { VERSION } from './version.mjs';

const fail = (code, message, details) => new DomainError(code, message, details);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const methods = Object.freeze({
  'tools.call': 'callTool', 'resources.list': 'listResources',
  'resources.templates.list': 'listResourceTemplates', 'resources.read': 'readResource',
  'prompts.list': 'listPrompts', 'prompts.get': 'getPrompt', discover: 'discover'
});
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROLES = ['owner','write','read'];
// Vault tools are served by an attached host rather than an in-process engine.
const HOST_ENGINE = 'obsidian';
const MAX_ENGINE_PROCESSES = 8;
const LIST_HINT = 'Flags are shown only when true. capability_list {name} returns the input schema of one capability and {engine} the schemas of one engine. ' +
  'Invoke a readOnly capability with capability_query {capability, input} and every other one with capability_call. A longRunning capability can exceed a minute: start it with operations_call {operation:"job.start", input:{kind:"capability", input:{capability, input}}} and follow it with operations_query {operation:"job.read", input:{id}}. ' +
  'ownerOnly capabilities are refused for other callers. dryRun capabilities need write access only when their dryRun input is off.';
const issues = error => error.issues.slice(0, 8).map(issue => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; ');
function oneLine(text) {
  const first = String(text || '').split(/(?<=[.!?])\s+/)[0];
  return first.length > 160 ? first.slice(0, 159) + '…' : first;
}
const squash = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export function normalizeExternalServers(values = []) {
  if (!Array.isArray(values) || values.length > 32) throw fail('invalid_mcp_config', 'Configure at most 32 external MCP servers.');
  const ids = new Set();
  return values.map(value => {
    if (!object(value) || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id || '') || ids.has(value.id)) throw fail('invalid_mcp_config', 'External MCP server IDs must be unique.');
    ids.add(value.id);
    const allowed = value.transport === 'http'
      ? ['id', 'transport', 'url', 'bearerTokenEnv']
      : ['id', 'transport', 'command', 'args', 'environment'];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_mcp_config', 'External MCP configuration contains an unsupported setting.');
    if (value.transport === 'http') {
      const url = new URL(value.url);
      const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw fail('invalid_mcp_config', 'MCP HTTP requires HTTPS or explicit loopback HTTP, without URL credentials.');
      if (value.bearerTokenEnv && !ENV_NAME.test(value.bearerTokenEnv)) throw fail('invalid_mcp_config', 'bearerTokenEnv must name an environment variable.');
      return { id:value.id, transport:'http', url:url.href, ...(value.bearerTokenEnv ? {bearerTokenEnv:value.bearerTokenEnv} : {}) };
    }
    if (value.transport !== 'stdio' || !path.isAbsolute(value.command || '') || /\.(cmd|bat|ps1)$/i.test(value.command)) throw fail('invalid_mcp_config', 'Stdio MCP requires an absolute native executable; pass a Node entry point as an argument.');
    const args = value.args || [];
    const environment = value.environment || {};
    if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32000)) throw fail('invalid_mcp_config', 'Invalid MCP executable arguments.');
    if (!object(environment) || Object.entries(environment).some(([name,source]) => !ENV_NAME.test(name) || typeof source !== 'string' || !ENV_NAME.test(source))) throw fail('invalid_mcp_config', 'MCP environment values must reference environment variable names.');
    return {id:value.id,transport:'stdio',command:value.command,args:[...args],environment:{...environment}};
  });
}

function secretEnvironment(reference, env) {
  const value = env[reference];
  if (typeof value !== 'string' || !value) throw fail('missing_credential', 'Configured external MCP credential environment variable is unavailable.');
  return value;
}

function nativeEnvironment(extra = {}) {
  // The SDK's safe default list avoids forwarding the owner's credential environment.
  return { ...getDefaultEnvironment(), ...extra };
}

/**
 * Explicit project composition. Each project owns one context per enabled engine;
 * an engine that cannot activate is reported as unavailable while the others work.
 * Engine descriptors reuse their schemas/handlers; project identity is supplied here.
 */
export async function createCapabilities({
  service, instanceRoot, externalServers = [], engineSettings = {},
  engines = [automationPlugin, browserControlPlugin, browserQaPlugin, finalGodotPlugin, reversePlugin],
  onInputRequest, inputCapabilities = {}, hostRegistry, env = process.env,
  clientFactory = options => new Client({name:'devmate',version:VERSION}, options),
  transportFactory, executeImpl = executeCommand
} = {}) {
  if (!service?.project || !service?.store || !instanceRoot) throw new TypeError('Capabilities require an explicit service and private instance root.');
  const servers = normalizeExternalServers(externalServers);
  const idOf = engine => engine.manifest.id.replace(/^devmate\./,'');
  const catalog = new Map();
  for (const engine of engines) {
    const id = idOf(engine);
    if (catalog.has(id) || id === HOST_ENGINE) throw new Error('Duplicate engine: ' + id);
    catalog.set(id, engine);
  }
  const engineIds = () => [...catalog.keys(), HOST_ENGINE];
  const callContext = new AsyncLocalStorage();
  const projectStates = new Map();
  const connections = new Map();
  const pending = new Map();
  const projectControllers = new Map();
  const projectClosures = new Map();
  const closingProjects = new Set();
  const executionAbort = new AbortController();
  let closed = false;
  const assertOpen = () => { if (closed) throw fail('runtime_stopping', 'Capabilities are closing.'); };
  const role = () => callContext.getStore()?.callerRole;
  const checkedProject = (id, write = false) => {
    assertOpen(); callContext.getStore()?.signal?.throwIfAborted();
    if(write && !['owner','write'].includes(role()))throw fail('forbidden','Verified write access is required.');
    if(closingProjects.has(id))throw fail('project_closing','Project capability resources are closing.');
    const project=service.project(id,{write,caller:{role:role()}});
    if(!projectControllers.has(id))projectControllers.set(id,new AbortController());
    return project;
  };
  const assertRole = value => { if(!ROLES.includes(value))throw fail('forbidden','Unknown caller role.'); };
  const tracked = async (projectId, action) => {
    assertOpen();
    const promise = Promise.resolve().then(action); pending.set(promise,projectId);
    try { return await promise; } finally { pending.delete(promise); }
  };

  const requestSignal = (projectId, extra) => AbortSignal.any([
    executionAbort.signal, projectControllers.get(projectId).signal,
    ...(callContext.getStore()?.signal ? [callContext.getStore().signal] : []), ...(extra ? [extra] : [])
  ]);

  // Settings are layered: engine defaults, config.json engineSettings, the owner's
  // instance-wide capability.configure values, then values set for one project.
  // "enabled" is the one setting every engine has; engines never see it.
  const instanceKey = id => 'engine-settings.' + id;
  const projectKey = (projectId, id) => 'capability.' + projectId + '.' + id;
  const settingKeys = engine => Object.keys(engine.settingsSchema?.shape || engine.defaultSettings || {});
  function parseSettings(engine, values, where) {
    if (!engine.settingsSchema) return values;
    try { return engine.settingsSchema.parse(values); }
    catch (error) {
      if (error?.name !== 'ZodError') throw error;
      throw fail('invalid_settings', 'Invalid settings for the ' + idOf(engine) + ' engine (' + where + '): ' + issues(error) +
        '. Its settings are: ' + ['enabled', ...settingKeys(engine)].join(', ') + '.');
    }
  }
  function checkLayer(id, layer, where) {
    if (!object(layer)) throw fail('invalid_settings', where + ' must be an object of settings for the ' + id + ' engine.');
    const { enabled, ...values } = layer;
    if (enabled !== undefined && typeof enabled !== 'boolean') throw fail('invalid_settings', 'Invalid settings for the ' + id + ' engine (' + where + '): enabled must be true or false.');
    const engine = catalog.get(id);
    if (engine) return parseSettings(engine, { ...engine.defaultSettings, ...values }, where);
    if (Object.keys(values).length) throw fail('invalid_settings', 'Invalid settings for the ' + id + ' engine (' + where + '): its only setting is enabled.');
    return {};
  }
  if (!object(engineSettings)) throw fail('invalid_settings', 'engineSettings must be an object keyed by engine id.');
  for (const [id, layer] of Object.entries(engineSettings)) {
    if (!engineIds().includes(id)) throw fail('invalid_settings', 'engineSettings names an unknown engine "' + id + '". Engine ids are: ' + engineIds().join(', ') + '.');
    checkLayer(id, layer, 'engineSettings.' + id);
  }
  const layers = (id, projectId) => ({
    config: engineSettings[id] || {}, instance: service.store.setting(instanceKey(id)) || {},
    project: projectId ? service.store.setting(projectKey(projectId, id)) || {} : {}
  });
  function enabledFor(id, projectId) {
    const stored = layers(id, projectId);
    return ({ ...stored.config, ...stored.instance, ...stored.project }).enabled !== false;
  }
  function settingsFor(engine, projectId) {
    const stored = layers(idOf(engine), projectId);
    const { enabled, ...values } = { ...engine.defaultSettings, ...stored.config, ...stored.instance, ...stored.project };
    return parseSettings(engine, values, 'stored values; correct them with capability.configure');
  }
  const disabled = id => fail('capability_disabled', 'The ' + id + ' engine is switched off. The owner can switch it on with capability.configure {engine:"' + id + '", settings:{enabled:true}}.');

  function dropEngine(state, id) {
    for (const [name, tool] of state.tools) if (tool.engine === id) state.tools.delete(name);
    for (const [key, entry] of state.provided) if (entry.engine === id) state.provided.delete(key);
  }
  async function activateEngine(state, engine) {
    const { projectId } = state, id = idOf(engine);
    const runtime = { id, engine, status: 'ready', error: null, context: null };
    state.runtimes.set(id, runtime);
    const project = (write = false) => checkedProject(projectId, write);
    const audit = (action, data) => service.store.event('capability.' + id + '.' + action, {id:projectId,projectId}, data || {});
    const scope = workspaceId => {
      if (workspaceId && workspaceId !== projectId) throw fail('scope_mismatch', 'Capability request belongs to another project.');
      return project();
    };
    function resolve(workspace, relative = '.', options = {}) {
      scope(workspace.id);
      const current = project();
      const value = path.isAbsolute(relative) ? path.relative(current.root, relative) : relative;
      const full = resolveProjectPath(current, value || '.', {mustExist:!!options.mustExist});
      if (options.directory && fs.existsSync(full) && !fs.statSync(full).isDirectory()) throw fail('not_directory', 'A directory is required, but this is a file: ' + (value || '.'));
      return full;
    }
    const allowed = executable => {
      if (/\.(cmd|bat|ps1)$/i.test(executable)) throw fail('invalid_executable','Use a native executable, not a script shim: ' + path.basename(executable));
      const patterns = engine.manifest.permissions?.executablePatterns || [];
      if(patterns.length && !patterns.some(pattern=>new RegExp(pattern,'i').test(path.basename(executable)))) throw fail('invalid_executable','The ' + id + ' engine may not start ' + path.basename(executable) + '.');
      return executable;
    };
    const run = (file, args, options) => executeImpl(file, args, {...options, shell:false,
      signal:requestSignal(projectId, options.signal), environment:engineEnvironment(options.environment, env)});
    runtime.context = {
      get signal(){return requestSignal(projectId);}, assertActive:()=>project(),
      state:createEngineState(engine.manifest.id,path.join(instanceRoot,'capabilities',projectId,id)),
      get settings() { return settingsFor(engine, projectId); },
      // Project-specific values an engine sets on the owner's behalf (for example godot.quick_setup).
      updateSettings(patch) {
        if(role()!=='owner')throw fail('forbidden','Owner access is required to configure capabilities.');
        // The same rule as capability.configure: an engine is set up at the owner's computer, or by the owner's client with full access.
        if(!callContext.getStore()?.ownerDecides)throw fail('forbidden','Capability engines are set up by the owner on their own computer (local workbench or the devmate command), or by their connected client when they chose the full access profile.');
        project(true);
        const next = { ...(service.store.setting(projectKey(projectId, id)) || {}), ...patch };
        checkLayer(id, { ...layers(id).config, ...layers(id).instance, ...next }, 'project settings');
        service.store.setting(projectKey(projectId, id), next); audit('configured',{keys:Object.keys(patch)});
        return settingsFor(engine, projectId);
      },
      caller:()=>role(),
      assertOwner(action) { if(role()!=='owner')throw fail('forbidden',action + ' is available only to the owner of this DevMate runtime.'); },
      assertCanMutate:()=>project(true),
      audit,
      toolText:value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}),
      workspace:{
        get:(workspaceId,{writable=false}={})=>{scope(workspaceId);return project(writable);},
        list:()=>[project()],
        resolve
      },
      services:{
        provide:(key,value)=>{if(state.provided.has(key))throw new Error('Duplicate capability service: '+key);state.provided.set(key,{engine:id,value});return value;},
        get:key=>{
          if(!state.provided.has(key))throw fail('capability_unavailable','This capability needs the ' + key.replace(/^devmate\./,'') + ' engine, which is switched off or unavailable. The owner can switch it on with capability.configure.');
          return state.provided.get(key).value;
        }
      },
      executables:{
        find:findExecutable, assertAllowed:allowed,
        // A fixed read-only probe: it takes no project input and needs no write access.
        version:async(file,{timeoutMs=15000}={})=>{
          project();allowed(file);
          return run(file,['--version'],{cwd:os.tmpdir(),timeoutMs:Math.min(60000,Math.max(1000,Number(timeoutMs)||15000)),maxOutputChars:20000});
        },
        run:async(file,args,options={})=>{
          const current=project(true);allowed(file);
          const cwd=resolve(current,options.cwd||'.',{mustExist:true,directory:true});
          return run(file,args,{...options,cwd,timeoutMs:options.timeoutMs||180000,maxOutputChars:options.maxOutputChars||120000});
        },
        // A persistent engine process is an ordinary owned project process: the
        // top-level process.list / process.read / process.stop operations work on it.
        start:async(file,args,{workspaceId,cwd='.',label='',environment={},autoStopAfterMs=3600000}={})=>{
          scope(workspaceId);const current=project(true);allowed(file);
          const processes=service.processes;
          if(!processes?.run)throw fail('capability_unavailable','This runtime has no process manager for engine processes.');
          const running=new Set(processes.list(projectId).items.filter(item=>item.status==='running').map(item=>item.id));
          for(const known of state.processIds)if(!running.has(known))state.processIds.delete(known);
          if(state.processIds.size>=MAX_ENGINE_PROCESSES)throw fail('capacity','This project already runs '+MAX_ENGINE_PROCESSES+' engine processes. Stop one with process_stop first.');
          const directory=resolve(current,cwd,{mustExist:true,directory:true});
          // The process manager starts commands in the owner's command environment;
          // an engine process keeps only the allow-listed part of it.
          const withheld=Object.fromEntries(Object.keys(env).filter(name=>!engineEnvironmentAllows(name)).map(name=>[name,undefined]));
          const started=await processes.run(current,{file,args,cwd:path.relative(current.root,directory).replace(/\\/g,'/')||'.',label:label||path.basename(file),
            timeoutMs:Math.min(86400000,Math.max(1000,Number(autoStopAfterMs)||3600000)),caller:callContext.getStore()?.callerId||null,
            waitMs:300,environment:{...withheld,...environment}},{signal:requestSignal(projectId)});
          if(started.status==='failed')throw fail('process_not_started',(label||path.basename(file))+' could not be started: '+String(started.output||'').trim().slice(-500));
          state.processIds.add(started.id);
          return{id:started.id,pid:started.pid,projectId,label:started.label,status:started.status,exitCode:started.exitCode,cursor:started.cursor};
        }
      },
      server:{registerTool(name,definition,handler){
        if(!/^[a-z][a-z0-9_]*$/.test(name))throw new Error('Invalid capability name for the '+id+' engine: '+name);
        const capability=id+'.'+name;
        if(state.tools.has(capability))throw new Error('Duplicate capability: '+capability);
        const {workspaceId,...shape}=definition.inputSchema||{};
        state.tools.set(capability,{name:capability,engine:id,description:String(definition.description||''),
          schema:z.object(shape).strict(),annotations:definition.annotations,handler,
          readOnly:definition.annotations?.readOnlyHint===true,readOnlyWhen:definition.readOnlyWhen||null,
          ownerOnly:engine.manifest.ownerOnly===true||definition.ownerOnly===true,longRunning:definition.longRunning===true});
      }}
    };
    try {
      await engine.activate(runtime.context);
      if (engine.diagnose) runtime.context.server.registerTool('diagnose', {
        description: 'Diagnose the ' + (engine.manifest.name || id) + ' engine for this project: effective settings and what its tools, executables and project files look like right now.',
        inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      }, async () => runtime.context.toolText({ engine: id, status: runtime.status,
        ...(role() === 'owner' ? { settings: settingsFor(engine, projectId) } : {}), diagnostics: await engine.diagnose(runtime.context) }));
    } catch (error) {
      dropEngine(state, id);
      runtime.status = 'unavailable'; runtime.error = error?.message || String(error);
      await Promise.resolve().then(() => engine.deactivate?.(runtime.context)).catch(() => {});
    }
  }
  async function deactivateEngine(state, runtime) {
    dropEngine(state, runtime.id);
    if (runtime.status !== 'unavailable' && runtime.engine.deactivate) await runtime.engine.deactivate(runtime.context);
    state.runtimes.delete(runtime.id);
  }
  // Bring the active engines of a project in line with their "enabled" setting.
  function reconcile(state) {
    const work = state.reconciling.then(async () => {
      for (const [id, engine] of catalog) {
        const wanted = enabledFor(id, state.projectId), runtime = state.runtimes.get(id);
        if (runtime && (!wanted || runtime.status === 'stopping')) {
          try { await deactivateEngine(state, runtime); }
          catch (error) { runtime.status = 'stopping'; runtime.error = 'Its resources have not finished closing: ' + (error?.message || error); continue; }
        }
        if (wanted && !state.runtimes.has(id)) await activateEngine(state, engine);
      }
    });
    state.reconciling = work.catch(() => {});
    return work;
  }

  async function projectContext(projectId) {
    checkedProject(projectId);
    if(!projectStates.has(projectId))projectStates.set(projectId,{projectId,runtimes:new Map(),tools:new Map(),provided:new Map(),processIds:new Set(),reconciling:Promise.resolve()});
    const state=projectStates.get(projectId);
    await reconcile(state);
    return state;
  }

  async function connect(projectId,serverId) {
    const project=checkedProject(projectId);
    const config=servers.find(server=>server.id===serverId);
    if(!config)throw fail('not_found','External MCP server is not configured: '+serverId);
    const key=projectId+':'+serverId;
    if(connections.has(key))return connections.get(key);
    const work=(async()=>{
      const options={versionNegotiation:{mode:'auto'},capabilities:onInputRequest?inputCapabilities:{},inputRequired:{autoFulfill:!!onInputRequest,maxRounds:8}};
      const client=clientFactory(options);
      if(onInputRequest){
        for(const [capability,method] of [['elicitation','elicitation/create'],['roots','roots/list'],['sampling','sampling/createMessage']]){
          if(inputCapabilities[capability])client.setRequestHandler(method,(request,context)=>onInputRequest({serverId,projectId,method,params:request.params,request,signal:requestSignal(projectId,context?.mcpReq?.signal)}));
        }
      }
      let transport;
      if(transportFactory)transport=await transportFactory(config,{project});
      else if(config.transport==='http'){
        const headers=config.bearerTokenEnv?{Authorization:'Bearer '+secretEnvironment(config.bearerTokenEnv,env)}:{};
        transport=new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers,redirect:'error'}});
      } else {
        const extra=Object.fromEntries(Object.entries(config.environment).map(([name,source])=>[name,secretEnvironment(source,env)]));
        transport=new StdioClientTransport({command:config.command,args:config.args,cwd:project.root,env:nativeEnvironment(extra),stderr:'pipe',maxBufferSize:8*1024*1024});
        transport.stderr?.resume(); // Child stderr may contain credentials; do not persist it.
      }
      try {
        await client.connect(transport,{timeout:15000,signal:requestSignal(projectId)});
        // A server that went away is not kept: the next call connects again instead of failing on the dead one.
        client.onclose=()=>{if(connections.get(key)===work)connections.delete(key);};
        return client;
      }
      catch(error){await client.close().catch(()=>{});throw error;}
    })();
    connections.set(key,work);
    try{return await work;}catch(error){connections.delete(key);throw error;}
  }

  // What a caller may invoke: owner-only tools for the owner, and for read access
  // only tools that are read-only or have a read-only dry run.
  const visible = (tool, callerRole) => (callerRole === 'owner' || !tool.ownerOnly) && (callerRole !== 'read' || tool.readOnly || !!tool.readOnlyWhen);
  const view = (tool, full) => ({
    name: tool.name, description: full ? tool.description : oneLine(tool.description),
    ...(full ? { readOnly: tool.readOnly, ownerOnly: tool.ownerOnly, longRunning: tool.longRunning }
      : { ...(tool.readOnly ? { readOnly: true } : {}), ...(tool.ownerOnly ? { ownerOnly: true } : {}), ...(tool.longRunning ? { longRunning: true } : {}) }),
    ...(tool.readOnlyWhen ? { dryRun: true } : {}),
    ...(full ? { inputSchema: z.toJSONSchema(tool.schema), annotations: tool.annotations } : {})
  });
  function hosted(projectId) {
    if (!hostRegistry) return { items: [], hosts: [] };
    return hostRegistry.list({ projectId });
  }
  function unknownCapability(state, name, all) {
    const id = engineIds().find(key => String(name).startsWith(key + '.'));
    if (id && !enabledFor(id, state.projectId)) return disabled(id);
    const runtime = state.runtimes.get(id);
    if (runtime && runtime.status !== 'ready') return fail('capability_unavailable', 'The ' + id + ' engine is unavailable: ' + runtime.error);
    if (id === HOST_ENGINE && !all.some(tool => tool.engine === HOST_ENGINE)) return fail('host_unavailable', 'No Obsidian vault is attached to this project. Open the vault in Obsidian with the DevMate plugin enabled; it attaches by itself.');
    const wanted = squash(name), suffix = squash(String(name).split('.').pop());
    const near = [...all.filter(tool => squash(tool.name) === wanted), ...all.filter(tool => suffix.length > 2 && tool.engine === id && squash(tool.name).includes(suffix))];
    return fail('unknown_capability', 'Unknown capability: ' + name + '.' +
      (near.length ? ' Did you mean ' + [...new Set(near.map(tool => tool.name))].slice(0, 3).join(', ') + '?' : '') + ' capability_list shows what this project has.');
  }

  async function list({projectId,engine,name,summary,serverId,cursor}={}, {signal,callerRole}={}) {
    assertRole(callerRole);
    if(serverId && callerRole!=='owner')throw fail('forbidden','External MCP servers are available only to the owner.');
    return callContext.run({signal,callerRole},()=>tracked(projectId,async()=>{
      const state=await projectContext(projectId), host=hosted(projectId);
      const all=[...state.tools.values(),...(enabledFor(HOST_ENGINE,projectId)?host.items:[])];
      if(name!==undefined){
        const tool=all.find(item=>item.name===name);
        if(!tool)throw unknownCapability(state,name,all);
        if(!visible(tool,callerRole))throw fail('forbidden',tool.ownerOnly&&callerRole!=='owner'?name+' is available only to the owner of this DevMate runtime.':name+' requires write access.');
        return{capability:{engine:tool.engine,...view(tool,true)},hint:'Invoke with '+(tool.readOnly?'capability_query':'capability_call')+' {capability:"'+name+'", input}.'+
          (tool.longRunning?' It can exceed a minute: start it with operations_call {operation:"job.start", input:{kind:"capability", input:{capability:"'+name+'", input}}} and follow it with operations_query {operation:"job.read", input:{id}}.':'')};
      }
      if(engine!==undefined && !engineIds().includes(engine))throw fail('unknown_engine','Unknown engine: '+engine+'. Engines are: '+engineIds().join(', ')+'.');
      const full=engine!==undefined && summary!==true;
      const tools=id=>all.filter(tool=>tool.engine===id && visible(tool,callerRole)).map(tool=>view(tool,full));
      const groups=[];
      for(const [id,item] of catalog){
        if(engine!==undefined && engine!==id)continue;
        const runtime=state.runtimes.get(id), on=enabledFor(id,projectId);
        groups.push({id,name:item.manifest.name||id,...(item.manifest.description?{description:oneLine(item.manifest.description)}:{}),
          status:!on?'disabled':runtime?.status||'unavailable',...(runtime?.error?{error:runtime.error}:{}),
          ...(item.manifest.ownerOnly?{ownerOnly:true}:{}),...(state.tools.has(id+'.diagnose')?{diagnose:id+'.diagnose'}:{}),capabilities:tools(id)});
      }
      // The vault engine is shown where it can matter: an attached host, a vault folder, or an explicit request.
      const vault=hostRegistry && (host.hosts.length>0 || engine===HOST_ENGINE || fs.existsSync(path.join(service.project(projectId).root,'.obsidian')));
      if(vault && (engine===undefined || engine===HOST_ENGINE)){
        const on=enabledFor(HOST_ENGINE,projectId);
        groups.push({id:HOST_ENGINE,name:'Obsidian vault',description:'Notes, Properties, links and search of the Obsidian vault opened in this project.',
          status:!on?'disabled':host.hosts.length?'attached':'detached',hosts:host.hosts,capabilities:tools(HOST_ENGINE),
          ...(on&&!host.hosts.length?{hint:'Open this vault in Obsidian with the DevMate plugin enabled; it attaches by itself while the runtime runs.'}:{})});
      }
      const configured=callerRole==='owner'?servers.map(({id,transport})=>({id,transport,connected:connections.has(projectId+':'+id)})):[];
      const result={engines:groups,externalServers:configured,hint:LIST_HINT};
      if(!serverId)return result;
      const client=await connect(projectId,serverId);
      const external=await client.listTools(cursor?{cursor}:{},{timeout:15000});
      return{...result,external:{serverId,...external,operations:Object.keys(methods).map(method=>'mcp.'+serverId+'.'+method)}};
    }));
  }

  function normalizeError(error, capability) {
    if (error?.name === 'ZodError') return fail('invalid_data', capability + ' met data it cannot accept: ' + issues(error));
    // DOMException codes are numbers; a caller needs a named outcome.
    if (error?.name === 'TimeoutError' && typeof error.code === 'number') return fail('timeout', capability + ' did not finish in time.');
    if (error?.name === 'AbortError' && typeof error.code === 'number') return fail('cancelled', capability + ' was cancelled.');
    return error;
  }

  // readOnly: the caller asked for something that only reads (capability.query); anything that would change is refused.
  // ownerDecides: the caller may set an engine up, as with capability.configure.
  async function call({projectId,capability,input={}}={}, {signal,callerRole,callerId,ownerDecides=false,readOnly=false}={}) {
    assertRole(callerRole);
    const changes=name=>fail('forbidden',name+' changes something: call it with capability_call.');
    return callContext.run({signal,callerRole,callerId,ownerDecides},()=>tracked(projectId,async()=>{
      checkedProject(projectId);
      if(typeof capability!=='string' || !capability)throw fail('invalid_input','capability must name a capability from capability_list.');
      if(!object(input))throw fail('invalid_input','Capability input must be an object.');
      if(capability.startsWith(HOST_ENGINE+'.')){
        if(!hostRegistry)throw fail('host_unavailable','No native vault host is attached.');
        if(!enabledFor(HOST_ENGINE,projectId))throw disabled(HOST_ENGINE);
        return hostRegistry.call({projectId,capability,input},{callerRole,readOnly,signal:requestSignal(projectId)});
      }
      if(capability.startsWith('mcp.')){
        // A configured server's credentials and resource scope belong to the owner.
        if(callerRole!=='owner')throw fail('forbidden','External MCP servers are available only to the owner.');
        if(readOnly)throw changes(capability);
        const [,serverId,...parts]=capability.split('.');
        const method=parts.join('.'), target=methods[method];
        if(!target)throw fail('unknown_capability','Unknown external MCP operation: '+capability+'. Operations are '+Object.keys(methods).map(key=>'mcp.'+serverId+'.'+key).join(', ')+'.');
        // External tools are open-world operations; their annotations are advisory.
        if(method==='tools.call')checkedProject(projectId,true);
        const client=await connect(projectId,serverId);
        const options={timeout:180000,allowInputRequired:!onInputRequest,signal:requestSignal(projectId)};
        const result=method==='discover'?await client.discover(options):await client[target](input,options);
        service.store.event('capability.external.completed',{id:projectId,projectId},{serverId,method,isError:result?.isError===true});
        return result; // Preserve content, schemas, requestState and input_required verbatim.
      }
      let operation,args;
      try{
        const state=await projectContext(projectId);
        operation=state.tools.get(capability);
        if(!operation)throw unknownCapability(state,capability,[...state.tools.values(),...hosted(projectId).items]);
        if(operation.ownerOnly && callerRole!=='owner')throw fail('forbidden',capability+' is available only to the owner of this DevMate runtime.');
        const requireWrite=()=>{
          if(readOnly)throw changes(capability);
          if(callerRole==='read')throw fail('forbidden',capability+' requires write access'+(operation.readOnlyWhen?' unless it is a dry run.':'.'));
          checkedProject(projectId,true);
        };
        // Whether a dry-run capable tool writes depends on its input; every other tool is authorized before its input is looked at.
        if(!operation.readOnly && !operation.readOnlyWhen)requireWrite();
        try{args=operation.schema.parse(input);}
        catch(error){throw error?.name==='ZodError'?fail('invalid_input','Invalid input for '+capability+': '+issues(error)+'. capability_list {name:"'+capability+'"} returns its input schema.'):error;}
        if(!operation.readOnly && operation.readOnlyWhen && operation.readOnlyWhen(args)!==true)requireWrite();
      }catch(error){
        // Refused before the capability ran: a job reports this as not started rather than as an unknown outcome.
        if(error && typeof error==='object')error.notStarted=true;
        throw error;
      }
      try{return await operation.handler({...args,workspaceId:projectId});}
      catch(error){throw normalizeError(error,capability);}
    }));
  }

  function settingsView(id, projectId, callerRole) {
    const engine = catalog.get(id), stored = layers(id, projectId), runtime = projectId ? projectStates.get(projectId)?.runtimes.get(id) : null;
    const own = callerRole === 'owner';
    let effective = {}, error = null;
    if (engine) try { effective = settingsFor(engine, projectId); } catch (cause) { error = cause.message; }
    let schema;
    if (engine?.settingsSchema) try { schema = z.toJSONSchema(engine.settingsSchema); } catch {}
    return { engine: id, name: engine?.manifest.name || 'Obsidian vault', enabled: enabledFor(id, projectId),
      ...(runtime ? { status: runtime.status, ...(runtime.error ? { error: runtime.error } : {}) } : {}),
      // Values can name local programs and folders; they are the owner's.
      ...(own ? { settings: effective, stored } : { keys: ['enabled', ...(engine ? settingKeys(engine) : [])] }),
      ...(error ? { settingsError: error } : {}), ...(own && schema ? { schema } : {}) };
  }

  /** Read engine settings. With projectId the values that apply to that project, otherwise the instance-wide ones. */
  async function settings({engine,projectId}={}, {callerRole}={}) {
    assertOpen(); assertRole(callerRole);
    if(projectId)service.project(projectId);
    if(engine!==undefined && !engineIds().includes(engine))throw fail('unknown_engine','Unknown engine: '+engine+'. Engines are: '+engineIds().join(', ')+'.');
    return{items:engineIds().filter(id=>engine===undefined||id===engine).map(id=>settingsView(id,projectId,callerRole)),
      hint:'The owner changes settings with capability.configure {engine, settings}; a null value restores the default, enabled:false switches an engine off.'};
  }

  /** Owner only. Merge settings into the instance-wide values of an engine, or with projectId into the values of one project. */
  async function configure({engine,settings:patch,projectId}={}, {callerRole}={}) {
    assertOpen(); assertRole(callerRole);
    if(callerRole!=='owner')throw fail('forbidden','Owner access is required to configure capabilities.');
    if(!engineIds().includes(engine))throw fail('unknown_engine','Unknown engine: '+engine+'. Engines are: '+engineIds().join(', ')+'.');
    if(!object(patch))throw fail('invalid_input','settings must be an object of setting names and values.');
    if(projectId)service.project(projectId);
    const key=projectId?projectKey(projectId,engine):instanceKey(engine), next={...(service.store.setting(key)||{})};
    for(const [name,value] of Object.entries(patch)){if(value===null)delete next[name];else next[name]=value;}
    const stored=layers(engine,projectId);
    checkLayer(engine,{...stored.config,...(projectId?stored.instance:{}),...next},'capability.configure');
    service.store.setting(key,next);
    service.store.event('capability.'+engine+'.configured',projectId?{id:projectId,projectId}:null,{keys:Object.keys(patch),scope:projectId?'project':'instance'});
    // Switching an engine off closes what it has open; switching it on makes it available again.
    const warnings=[];
    for(const state of projectStates.values()){
      if(closingProjects.has(state.projectId))continue;
      await reconcile(state).catch(error=>warnings.push(error.message));
      const runtime=state.runtimes.get(engine);
      if(runtime?.status==='stopping')warnings.push(runtime.error);
    }
    return{...settingsView(engine,projectId,callerRole),scope:projectId?'project':'instance',...(warnings.length?{warnings}:{})};
  }

  function closeProject(projectId) {
    if(projectClosures.has(projectId))return projectClosures.get(projectId);
    closingProjects.add(projectId);
    projectControllers.get(projectId)?.abort(new Error('Project capability resources are closing.'));
    const work=Promise.resolve().then(async()=>{
      const state=projectStates.get(projectId);
      const cleanup=[];
      for(const [key,promise] of connections){
        if(key.slice(0,key.lastIndexOf(':'))!==projectId)continue;
        const client=await promise.catch(()=>null);if(client)cleanup.push(client.close());
      }
      if(state){
        await state.reconciling;
        for(const id of state.processIds)cleanup.push(Promise.resolve().then(()=>service.processes.stop({id})).then(()=>{state.processIds.delete(id);},error=>{
          // Already gone, or exited leaving only untracked descendants: nothing of ours is left to stop.
          if(!['not_found','background_processes'].includes(error?.code))throw error;
          state.processIds.delete(id);
        }));
        for(const runtime of state.runtimes.values())if(runtime.status!=='unavailable' && runtime.engine.deactivate)cleanup.push(Promise.resolve().then(()=>runtime.engine.deactivate(runtime.context)));
      }
      const results=await Promise.allSettled(cleanup);
      await Promise.allSettled([...pending].filter(([,id])=>id===projectId).map(([promise])=>promise));
      const failures=results.filter(result=>result.status==='rejected');
      if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Project capability shutdown failed.');
      projectStates.delete(projectId);
      for(const key of connections.keys())if(key.slice(0,key.lastIndexOf(':'))===projectId)connections.delete(key);
    });
    projectClosures.set(projectId,work);
    void work.catch(()=>{if(projectClosures.get(projectId)===work)projectClosures.delete(projectId);});
    return work;
  }

  async function reopenProject(projectId) {
    assertOpen();
    if(closingProjects.has(projectId))await closeProject(projectId);
    service.project(projectId);
    projectStates.delete(projectId);
    projectControllers.delete(projectId);
    projectClosures.delete(projectId);
    closingProjects.delete(projectId);
  }

  let closePromise;
  function close() {
    if(closePromise)return closePromise;
    closed=true;executionAbort.abort(new Error('Runtime is stopping.'));
    closePromise=Promise.allSettled([...projectControllers.keys()].map(closeProject)).then(results=>{
      const failures=results.filter(result=>result.status==='rejected');
      if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Capability shutdown failed.');
    });
    const work=closePromise;
    void work.catch(()=>{if(closePromise===work)closePromise=undefined;});
    return work;
  }
  return {list,call,settings,configure,closeProject,reopenProject,close};
}
