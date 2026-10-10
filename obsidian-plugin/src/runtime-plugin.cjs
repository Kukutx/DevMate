'use strict';
const {Plugin,PluginSettingTab,Setting,Notice}=require('obsidian');
const os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const {materializeRuntimeAssets}=require('./runtime-assets.cjs');
const {createObsidianRuntimeEntry}=require('./runtime-entry.cjs');
const embedded=__DEVMATE_RUNTIME_ASSETS__;
class RuntimeSettings extends PluginSettingTab{
  display(){
    const el=this.containerEl;el.empty();
    // A wrong directory or Node path stops the plugin before it has any other surface: say so here, where it is fixed.
    if(this.plugin.startupError)el.createEl('p',{cls:'devmate-setup-error',text:'DevMate could not start: '+this.plugin.startupError+' Correct the settings below, then turn this plugin off and on.'});
    el.createEl('p',{text:'Changes apply after turning this plugin off and on (Settings → Community plugins). The shared runtime starts when you start it, or with Obsidian if you switch that on below.'});
    const edit=(name,description,key,placeholder)=>new Setting(el).setName(name).setDesc(description).addText(input=>input.setPlaceholder(placeholder).setValue(String(this.plugin.settings[key]||'')).onChange(async value=>{this.plugin.settings[key]=value.trim();await this.plugin.saveData(this.plugin.settings);}));
    const toggle=(name,description,key,on=true)=>new Setting(el).setName(name).setDesc(description).addToggle(input=>input.setValue(on?this.plugin.settings[key]!==false:this.plugin.settings[key]===true).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.saveData(this.plugin.settings);}));
    edit('Node.js executable','Node.js 24 or newer, installed on this computer. Leave empty to find it on PATH.','nodeCommandPath','node');
    edit('Instance directory','Where DevMate keeps its state, outside the vault. Editors and the command line that use the same directory share one runtime.','runtimeInstanceDirectory',path.join(os.homedir(),'.devmate','runtime'));
    new Setting(el).setName('Local port').setDesc('A whole number from 1024 to 65535, used when this plugin starts the runtime. A runtime that is already running keeps its own port.').addText(input=>input.setValue(String(this.plugin.settings.runtimePort||8788)).onChange(async value=>{const port=/^\d+$/.test(value.trim())?Number(value.trim()):NaN,valid=Number.isInteger(port)&&port>=1024&&port<=65535;input.inputEl?.classList?.toggle('devmate-invalid',!valid);if(!valid)return;this.plugin.settings.runtimePort=port;await this.plugin.saveData(this.plugin.settings);}));
    toggle('Start the runtime with Obsidian','Start the shared DevMate runtime, a background process that keeps running after Obsidian closes, when Obsidian opens this vault, and start it again if it ends unexpectedly. A runtime you stopped stays stopped.','autoStart',false);
    toggle('Attach this vault automatically','While the runtime runs and this vault is a registered project, keep it attached, also after a runtime restart.','autoAttach');
    toggle('Share the active note and selection','Lets a connected model see which note is open and what is selected.','publishEditorContext');
  }
}
module.exports=class DevMateRuntimePlugin extends Plugin{
  async onload(){
    this.settings={nodeCommandPath:'',runtimeInstanceDirectory:'',runtimePort:8788,autoStart:false,autoAttach:true,publishEditorContext:true,...await this.loadData()};
    this.startupError=null;
    // The settings tab comes first: it is the only place a bad instance directory can be corrected.
    this.addSettingTab(new RuntimeSettings(this.app,this));
    const start=async()=>{try{
      const chosen=String(this.settings.runtimeInstanceDirectory||'').trim();
      if(chosen&&!path.isAbsolute(chosen))throw new Error('The instance directory must be an absolute path: '+chosen);
      const instanceRoot=path.resolve(chosen||path.join(os.homedir(),'.devmate','runtime'));
      const runtimeRoot=materializeRuntimeAssets(instanceRoot,embedded);
      const requireRuntime=createRequire(path.join(runtimeRoot,'runtime','host-client.cjs'));
      const {createHostClient}=requireRuntime(path.join(runtimeRoot,'runtime','host-client.cjs'));
      const client=createHostClient({instanceRoot,nodePath:this.settings.nodeCommandPath,port:this.settings.runtimePort});
      this.runtimeEntry=createObsidianRuntimeEntry(this,{client});
      await this.runtimeEntry.activate();
    }catch(error){
      this.startupError=['ENOTDIR','EACCES','ENOENT','EPERM','EROFS'].includes(error.code)?'The instance directory cannot be created or written ('+error.code+'): '+(error.path||this.settings.runtimeInstanceDirectory||'the default one')+'.'
        :String(error.message||error).replace(/\.?\s*$/,'.');
      this.addStatusBarItem().setText('DevMate: setup error');
      this.setupNotice=new Notice('DevMate could not start: '+this.startupError+' Open Settings → DevMate to correct it.',0);
    }};
    // Checking the runtime files takes a moment. Obsidian's own start does not wait for it.
    const workspace=this.app?.workspace;
    if(typeof workspace?.onLayoutReady==='function')workspace.onLayoutReady(()=>{this.started=start();});
    else await(this.started=start());
  }
  onunload(){
    return Promise.resolve(this.started).then(()=>{
      const entry=this.runtimeEntry;this.runtimeEntry=null;
      this.setupNotice?.hide?.();this.setupNotice=null;
      return entry?.deactivate().catch(error=>new Notice('DevMate detach: '+error.message));
    });
  }
};
