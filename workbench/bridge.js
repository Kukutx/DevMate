import { App } from '@modelcontextprotocol/ext-apps';
export function unwrap(value) {
  if(value?.isError || value?.ok === false) {
    // A failed tool call carries the same {code, message} as the local API, so both transports report errors alike.
    const error=value.error ?? value.structuredContent?.error;
    const message=error?.message || (typeof error==='string'?error:'') || value.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n') || 'The operation failed.';
    throw Object.assign(new Error(String(message)),{code:error?.code || 'operation_failed'});
  }
  return value?.structuredContent ?? (value?.ok === true ? value.result : value);
}
// The local page is signed in per tab. What the tab was given stays in the tab (sessionStorage belongs to one origin,
// port included, and one tab) and travels in a request header: no other page and no other local service receives it.
const SESSION_KEY='devmate.session';
const stored=()=>{try{return sessionStorage.getItem(SESSION_KEY)||'';}catch{return '';}};
const refused=status=>Object.assign(new Error(status===401?'This page is not signed in to DevMate.':'DevMate returned HTTP '+status),{code:status===401?'session_expired':'refused'});
/** Only transport adaptation lives here. The official MCP Apps SDK owns its handshake and RPC lifecycle. */
export class Bridge {
  constructor({onContext=()=>{},onTeardown=()=>{}}={}) {
    this.embedded=window.parent !== window;
    this.onContext=onContext;this.onTeardown=onTeardown;this.initial=null;this.mode=null;this.stopResize=null;
    this.initialReady=new Promise(resolve=>{this.resolveInitial=resolve;});
    this.session=this.embedded?'':stored();this.lastEvent='';
    if(this.embedded) {
      this.app=new App({name:'DevMate Workbench',version:'1.0.0'},{availableDisplayModes:['inline','fullscreen']},{autoResize:false});
      this.app.ontoolresult=result=>{try{this.initial=unwrap(result);this.resolveInitial(this.initial);}catch(error){this.resolveInitial(null);}};
      this.app.onhostcontextchanged=context=>this.contextChanged(context);
      this.app.onteardown=async()=>{this.onTeardown();return {};};
    }
  }
  async connect() {
    if(!this.embedded)return this.signIn();
    await this.app.connect(undefined,{timeout:15000});
    const context=this.app.getHostContext();if(context)this.contextChanged(context);else this.fit();
  }
  /** Spend the single-use code of the link that opened this tab. The code leaves the address bar; the session never enters a URL. */
  async signIn() {
    const code=new URLSearchParams(location.search).get('code');
    if(code===null)return;
    history.replaceState(null,'',location.pathname);
    const response=await fetch('/api/session/exchange',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(15000)}).catch(()=>null);
    const session=response?.ok?(await response.json().catch(()=>null))?.result?.session:null;
    if(!session)return;
    this.session=session;try{sessionStorage.setItem(SESSION_KEY,session);}catch{}
  }
  get authorization() { return this.session?{Authorization:'Bearer '+this.session}:{}; }
  contextChanged(context) {
    if(context.displayMode)this.mode=context.displayMode;
    this.fit();this.onContext(context);
  }
  /** The host's name, for wording only. */
  get hostName() { return this.app?.getHostVersion()?.name || ''; }
  get displayMode() { return this.mode || 'inline'; }
  canDisplay(mode) { return !!this.app?.getHostContext()?.availableDisplayModes?.includes(mode); }
  /** Ask through the official API; the host decides and answers with the mode it applied. */
  async requestDisplayMode(mode) {
    if(!this.canDisplay(mode))return this.displayMode;
    const result=await this.app.requestDisplayMode({mode},{timeout:15000});
    this.mode=result.mode;this.fit();
    return this.mode;
  }
  /** An inline container follows the height of the content; a fullscreen one is sized by the host. */
  fit() {
    const inline=this.displayMode!=='fullscreen';
    if(inline&&!this.stopResize)this.stopResize=this.app.setupSizeChangedNotifications();
    else if(!inline&&this.stopResize){this.stopResize();this.stopResize=null;}
  }
  async initialResult() {
    if(!this.embedded)return null;
    if(this.initial)return this.initial;
    let timer;try{return await Promise.race([this.initialReady,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);}
    finally{clearTimeout(timer);}
  }
  async call(operation,input={}) {
    if(this.embedded) return unwrap(await this.app.callServerTool({name:'workbench_call',arguments:{operation,input}},{timeout:60000}));
    let response;
    try{response=await fetch('/api/call',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json',...this.authorization},body:JSON.stringify({operation,input}),signal:AbortSignal.timeout(60000)});}
    catch(error){throw Object.assign(new Error(error?.name==='TimeoutError'?'DevMate took too long to answer.':'DevMate is not responding. It may have been stopped or restarted.'),{code:'unreachable'});}
    // A session belongs to one running DevMate; after a restart it means nothing.
    if(response.status===401)throw refused(401);
    let value;try{value=await response.json();}catch{throw new Error('DevMate returned HTTP '+response.status);}
    if(!response.ok && value?.ok !== false) throw new Error('DevMate returned HTTP '+response.status);
    return unwrap(value);
  }
  /**
   * Read the local event stream until it ends. EventSource cannot send the header that carries this tab's session,
   * so the stream is read with fetch. Resolves when the server ends it; rejects when it is refused or cut.
   */
  async listen({onOpen=()=>{},onEvent,onRetry=()=>{},signal}) {
    const response=await fetch('/events',{credentials:'omit',headers:{Accept:'text/event-stream',...this.authorization,...(this.lastEvent?{'Last-Event-ID':this.lastEvent}:{})},signal});
    if(!response.ok||!response.body)throw refused(response.status);
    onOpen();
    const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let pending='';
    for(;;) {
      const {value,done}=await reader.read();if(done)return;
      const blocks=(pending+value).split(/\r?\n\r?\n/);pending=blocks.pop();
      for(const block of blocks) {
        const data=[];
        for(const line of block.split(/\r?\n/)) {
          const at=line.indexOf(':'),field=at<0?line:line.slice(0,at),text=at<0?'':line.slice(at+1).replace(/^ /,'');
          if(field==='data')data.push(text);else if(field==='id')this.lastEvent=text;else if(field==='retry'&&/^\d+$/.test(text))onRetry(Number(text));
        }
        if(data.length)onEvent(data.join('\n'));
      }
    }
  }
  async updateReferences(references) {
    if(!this.embedded)throw new Error('References can be added to a conversation when this workbench is opened inside a chat app.');
    const capability=this.app.getHostCapabilities()?.updateModelContext;
    if(!capability)throw new Error('This host does not advertise model-context updates.');
    const links=references.map(ref=>({type:'resource_link',uri:ref.uri,name:ref.name||ref.title||ref.uri,...(ref.mimeType?{mimeType:ref.mimeType}:{}),...(ref.description?{description:ref.description}:{})}));
    const content=capability.resourceLink ? links : [{type:'text',text:references.map(ref=>(ref.name||ref.uri)+'\n'+ref.uri+(ref.description?'\n'+ref.description:'')).join('\n\n')}];
    return this.app.updateModelContext({content},{timeout:15000});
  }
  dispose() { this.stopResize?.();if(this.app)void this.app.close(); }
}
globalThis.DevMateBridge={Bridge,unwrap};
