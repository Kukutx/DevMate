import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClientMetadataResolver, clientMetadataUrl, configuredClientId, matchRedirectUri, usableRedirect, validateClientMetadata,
  CACHE_MIN_MS, CACHE_DEFAULT_MS, CACHE_MAX_MS, FAILURE_MS, MAX_PENDING, MAX_PENDING_PER_HOST } from '../runtime/auth-client.mjs';

const clientId='https://client.example/metadata.json';
const metadata={client_id:clientId,client_name:'Fixture',redirect_uris:['http://127.0.0.1:4000/callback']};
const publicLookup=async()=>[{address:'8.8.8.8',family:4}];
function fakeRequest(value=metadata,{status=200,contentType='application/json',advertisedLength,cacheControl}={}){
  const calls=[];
  const request=(url,options,onResponse)=>{
    const req=new EventEmitter();req.destroy=()=>{};calls.push({url,options});
    req.end=()=>queueMicrotask(()=>{
      const res=new PassThrough();res.statusCode=status;
      res.headers={'content-type':contentType,...(advertisedLength?{'content-length':String(advertisedLength)}:{}),...(cacheControl?{'cache-control':cacheControl}:{})};
      const body=typeof value==='function'?value(url):value;
      onResponse(res);if(!res.destroyed)res.end(typeof body==='string'?body:JSON.stringify(body));
    });
    return req;
  };
  return {request,calls};
}
test('CIMD fetch pins a validated public address, preserves URL hostname and caches',async()=>{
  let resolutions=0;
  const fake=fakeRequest();
  const resolve=createClientMetadataResolver({lookup:async()=>{resolutions++;return [{address:'8.8.8.8',family:4}];},request:fake.request});
  assert.deepEqual((await resolve(clientId)).redirect_uris,metadata.redirect_uris);
  await resolve(clientId);
  assert.equal(resolutions,1);assert.equal(fake.calls.length,1);
  assert.equal(fake.calls[0].url.hostname,'client.example');
  assert.equal(fake.calls[0].options.agent,false,'no pooled connection can stand in for the pinned address');
  assert.equal(fake.calls[0].options.method,'GET');
  const actual=await new Promise((res,rej)=>fake.calls[0].options.lookup('client.example',{},(err,address,family)=>err?rej(err):res({address,family})));
  assert.deepEqual(actual,{address:'8.8.8.8',family:4});
  const all=await new Promise((res,rej)=>fake.calls[0].options.lookup('client.example',{all:true},(err,records)=>err?rej(err):res(records)));
  assert.deepEqual(all,[{address:'8.8.8.8',family:4}]);
  resolve.close();
});
test('CIMD rejects private, mixed, mapped loopback and metadata service DNS addresses before HTTPS',async()=>{
  for(const records of [
    [{address:'127.0.0.1',family:4}],
    [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],
    [{address:'169.254.169.254',family:4}],
    [{address:'::ffff:127.0.0.1',family:6}],
    [{address:'fd00::1',family:6}],
    []
  ]){
    const fake=fakeRequest();
    const resolve=createClientMetadataResolver({lookup:async()=>records,request:fake.request});
    await assert.rejects(resolve(clientId),/public addresses/);assert.equal(fake.calls.length,0);
  }
});
test('CIMD rejects literal private IPs, credentials and query-bearing client identifiers',async()=>{
  const fake=fakeRequest();
  const resolve=createClientMetadataResolver({request:fake.request});
  await assert.rejects(resolve('https://127.0.0.1/client.json'),/public addresses/);
  await assert.rejects(resolve('https://[::1]/client.json'),/public addresses/);
  for(const value of ['http://client.example/a','https://user:password@client.example/a',clientId+'?token=value',clientId+'#fragment'])assert.throws(()=>clientMetadataUrl(value));
  assert.equal(fake.calls.length,0);
});
test('a client identifier is a canonical HTTPS URL with a path',async()=>{
  for(const value of [clientId,'https://chatgpt.com/oauth/client.json','https://claude.ai/oauth/mcp-oauth-client-metadata','https://client.example:8443/a/b%2Fc'])
    assert.equal(clientMetadataUrl(value).href,value);
  // CIMD section 3 requires a path component and forbids dot segments; the rest keeps
  // the identifier a string that compares the same everywhere.
  for(const value of ['https://client.example','https://client.example/','https://client.example/a/../metadata.json','https://client.example/./metadata.json',
    'https://client.example/%2e%2e/metadata.json','https://CLIENT.example/metadata.json','HTTPS://client.example/metadata.json','https://client.example:443/metadata.json',
    ' '+clientId,clientId+'?',clientId+'#','https://client.example\\metadata.json','ftp://client.example/a','client.example/a','',null,undefined,42,'https://client.example/'+'a'.repeat(2048)])
    assert.throws(()=>clientMetadataUrl(value),undefined,String(value));
  const fake=fakeRequest({...metadata,client_id:'https://client.example/'});
  const resolve=createClientMetadataResolver({lookup:publicLookup,request:fake.request});
  await assert.rejects(resolve('https://client.example'),/canonical HTTPS URL with a path/);
  assert.equal(fake.calls.length,0);
});
test('CIMD never follows redirects, requires JSON and enforces its response bound',async()=>{
  for(const [value,options] of [[metadata,{status:302}],[metadata,{status:404}],[metadata,{contentType:'text/html'}],[metadata,{advertisedLength:65537}],['x'.repeat(65537),{}],['invalid JSON',{}]]){
    const fake=fakeRequest(value,options);
    const resolve=createClientMetadataResolver({lookup:publicLookup,request:fake.request});
    await assert.rejects(resolve(clientId));assert.equal(fake.calls.length,1);
  }
  const typed=fakeRequest(metadata,{contentType:'application/cimd+json; charset=utf-8'});
  assert.equal((await createClientMetadataResolver({lookup:publicLookup,request:typed.request})(clientId)).client_name,'Fixture');
});
test('CIMD DNS and request time are bounded and concurrent lookup for one client is shared',async()=>{
  const slow=createClientMetadataResolver({lookup:()=>new Promise(()=>{}),timeoutMs:20});
  await assert.rejects(slow(clientId),/DNS lookup timed out/);
  let destroyed=0;
  const silent=createClientMetadataResolver({lookup:publicLookup,timeoutMs:20,request:()=>{const req=new EventEmitter();req.destroy=()=>{destroyed++;};req.end=()=>{};return req;}});
  await assert.rejects(silent(clientId),/request timed out/);assert.equal(destroyed,1);
  const refused=createClientMetadataResolver({lookup:publicLookup,request:()=>{const req=new EventEmitter();req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(new Error('connect ECONNREFUSED 8.8.8.8:443'),{code:'ECONNREFUSED'})));return req;}});
  await assert.rejects(refused(clientId),{message:'Client metadata request failed (ECONNREFUSED).'});
  const unknown=createClientMetadataResolver({lookup:async()=>{throw Object.assign(new Error('getaddrinfo ENOTFOUND client.example'),{code:'ENOTFOUND'});}});
  await assert.rejects(unknown(clientId),{message:'Client metadata host could not be resolved (ENOTFOUND).'});
  let finish,count=0;
  const fake=fakeRequest(),resolve=createClientMetadataResolver({lookup:()=>{count++;return new Promise(res=>finish=res);},request:fake.request});
  const first=resolve(clientId),second=resolve(clientId);
  finish([{address:'8.8.8.8',family:4}]);
  await Promise.all([first,second]);assert.equal(count,1);assert.equal(fake.calls.length,1);
});
test('a fetched document is reused for what Cache-Control allows, within bounds',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const lifetime=async cacheControl=>{
    const fake=fakeRequest(metadata,{cacheControl}),resolve=createClientMetadataResolver({lookup:publicLookup,request:fake.request});
    const probe=async elapsed=>{t.mock.timers.tick(elapsed);await resolve(clientId);return fake.calls.length;};
    return {probe};
  };
  for(const [cacheControl,expected] of [['public, max-age=300',300000],[undefined,CACHE_DEFAULT_MS],['max-age=3600',3600000],['max-age="120"',120000],
    ['max-age=1',CACHE_MIN_MS],['no-store,no-cache,max-age=0',CACHE_MIN_MS],['no-cache',CACHE_MIN_MS],['private, max-age=999999999',CACHE_MAX_MS],
    ['max-age=nonsense',CACHE_DEFAULT_MS],['s-maxage=10, x-max-age=7',CACHE_DEFAULT_MS]]){
    const {probe}=await lifetime(cacheControl);
    assert.equal(await probe(0),1,String(cacheControl));
    assert.equal(await probe(expected-1),1,cacheControl+' is still fresh just before '+expected+' ms');
    assert.equal(await probe(1),2,cacheControl+' is fetched again at '+expected+' ms');
  }
  assert.equal(CACHE_MIN_MS<CACHE_DEFAULT_MS&&CACHE_DEFAULT_MS<CACHE_MAX_MS,true);
});
test('a failed fetch is not repeated for a short time and is never served as metadata',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  let healthy=false;
  const calls=[];
  const request=(url,options,onResponse)=>{
    const inner=fakeRequest(healthy?metadata:'invalid JSON');
    calls.push(url.href);return inner.request(url,options,onResponse);
  };
  const resolve=createClientMetadataResolver({lookup:publicLookup,request});
  await assert.rejects(resolve(clientId),{message:'Client metadata is invalid JSON.'});
  healthy=true;
  await assert.rejects(resolve(clientId),{message:'Client metadata is invalid JSON.'});
  t.mock.timers.tick(FAILURE_MS-1);
  await assert.rejects(resolve(clientId),{message:'Client metadata is invalid JSON.'});
  assert.equal(calls.length,1,'one request per failure window');
  // The pause is per client identifier.
  const other='https://client.example/other.json';
  healthy=false;
  await assert.rejects(resolve(other));assert.equal(calls.length,2);
  healthy=true;
  t.mock.timers.tick(1);
  assert.equal((await resolve(clientId)).client_name,'Fixture');assert.equal(calls.length,3);
  await resolve(clientId);assert.equal(calls.length,3,'and the good document is cached');
  // A document that fails validation is a failure too, and is not kept.
  const wrong=fakeRequest({...metadata,client_id:'https://other.example/metadata.json'});
  const strict=createClientMetadataResolver({lookup:publicLookup,request:wrong.request});
  await assert.rejects(strict(clientId),/does not match its URL/);await assert.rejects(strict(clientId),/does not match its URL/);
  assert.equal(wrong.calls.length,1);
  t.mock.timers.tick(FAILURE_MS);
  await assert.rejects(strict(clientId));assert.equal(wrong.calls.length,2);
  strict.close();
  await assert.rejects(strict(clientId));assert.equal(wrong.calls.length,3,'close forgets failures');
});
test('slow hosts cannot occupy every fetch: pending requests are limited per host and overall',async()=>{
  const waiting=[];
  const fake=fakeRequest(url=>({...metadata,client_id:url.href}));
  const resolve=createClientMetadataResolver({lookup:()=>new Promise(res=>waiting.push(res)),request:fake.request});
  const pending=[];
  const start=value=>{const work=resolve(value);work.catch(()=>{});pending.push(work);return work;};
  for(let index=0;index<MAX_PENDING_PER_HOST;index++)start('https://slow.example/client-'+index+'.json');
  await assert.rejects(resolve('https://slow.example/one-more.json'),/Too many client metadata requests to this host/);
  // The same identifier joins the request already in flight instead of counting again.
  start('https://slow.example/client-0.json');
  assert.equal(waiting.length,MAX_PENDING_PER_HOST);
  for(let index=0;waiting.length<MAX_PENDING;index++)start('https://host-'+index+'.example/client.json');
  await assert.rejects(resolve('https://fresh.example/client.json'),/Too many client metadata requests are in progress/);
  assert.equal(waiting.length,MAX_PENDING);assert.equal(fake.calls.length,0);
  for(const release of waiting.splice(0))release([{address:'8.8.8.8',family:4}]);
  const results=await Promise.all(pending);
  assert.equal(results.length,MAX_PENDING+1);assert.equal(fake.calls.length,MAX_PENDING);
  // Being turned away for capacity is not a failure of that client: it works as soon as there is room.
  const late=[resolve('https://slow.example/one-more.json'),resolve('https://fresh.example/client.json')];
  for(const release of waiting.splice(0))release([{address:'8.8.8.8',family:4}]);
  assert.deepEqual((await Promise.all(late)).map(item=>item.client_id),['https://slow.example/one-more.json','https://fresh.example/client.json']);
  assert.equal(MAX_PENDING_PER_HOST<MAX_PENDING,true);
});
test('CIMD metadata binds exact identity and permits only HTTPS or loopback redirects',()=>{
  assert.throws(()=>validateClientMetadata({...metadata,client_id:'https://other.example/a'},clientId));
  assert.throws(()=>validateClientMetadata({...metadata,client_id:clientId+'/'},clientId));
  assert.throws(()=>validateClientMetadata({...metadata,redirect_uris:['http://public.example/callback']},clientId));
  assert.throws(()=>validateClientMetadata({...metadata,redirect_uris:['https://user:password@public.example/callback']},clientId));
  assert.throws(()=>validateClientMetadata({...metadata,redirect_uris:['https://public.example/callback#fragment']},clientId));
  assert.throws(()=>validateClientMetadata({...metadata,token_endpoint_auth_method:'client_secret_basic'},clientId));
  assert.equal(validateClientMetadata({...metadata,redirect_uris:['https://public.example/callback']},clientId).client_name,'Fixture');
  for(const broken of [null,[],'text',{...metadata,client_name:''},{...metadata,client_name:'x'.repeat(201)},{...metadata,client_name:undefined},{...metadata,redirect_uris:[]},
    {...metadata,redirect_uris:'https://public.example/callback'},{...metadata,redirect_uris:[42]},{...metadata,redirect_uris:Array.from({length:21},(_,i)=>'https://public.example/'+i)},
    {...metadata,response_types:['token']},{...metadata,grant_types:['client_credentials']},{...metadata,grant_types:'authorization_code'}])
    assert.throws(()=>validateClientMetadata(broken,clientId),undefined,JSON.stringify(broken));
  // Redirects this server would never use are dropped; the usable ones remain.
  const mixed=validateClientMetadata({...metadata,redirect_uris:['cursor://callback','http://public.example/cb','https://app.example/cb','http://localhost/cb','http://[::1]/cb','https://app.example/cb','not a url']},clientId);
  assert.deepEqual(mixed.redirect_uris,['https://app.example/cb','http://localhost/cb','http://[::1]/cb']);
  assert.throws(()=>validateClientMetadata({...metadata,redirect_uris:['cursor://callback','http://192.168.1.2/cb']},clientId),/no HTTPS or loopback redirect/);
});
test('a document is accepted when the client can act as a public client',()=>{
  const accept=extra=>validateClientMetadata({...metadata,...extra},clientId);
  assert.deepEqual(accept({}).grant_types,['authorization_code']);
  assert.deepEqual(accept({token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token']}).grant_types,['authorization_code','refresh_token']);
  // The client states a preference and lists what it can do; it uses "none" here because that is all this server advertises.
  accept({token_endpoint_auth_method:'private_key_jwt',token_endpoint_auth_methods_supported:['none','private_key_jwt'],jwks_uri:'https://client.example/jwks.json'});
  accept({token_endpoint_auth_methods_supported:['none']});
  accept({application_type:'native',logo_uri:'https://client.example/logo.png',unknown_property:{nested:true}});
  assert.throws(()=>accept({token_endpoint_auth_method:'private_key_jwt'}),/public client/);
  assert.throws(()=>accept({token_endpoint_auth_method:'private_key_jwt',token_endpoint_auth_methods_supported:['private_key_jwt','tls_client_auth']}),/public client/);
  assert.throws(()=>accept({token_endpoint_auth_methods_supported:'none'}),/list of method names/);
  // CIMD section 4.1: nothing built on a shared secret.
  for(const method of ['client_secret_basic','client_secret_post','client_secret_jwt']){
    assert.throws(()=>accept({token_endpoint_auth_method:method,token_endpoint_auth_methods_supported:['none',method]}),/shared secret/);
    assert.throws(()=>accept({token_endpoint_auth_method:'none',token_endpoint_auth_methods_supported:['none',method]}),/shared secret/);
  }
  assert.throws(()=>accept({client_secret:'published'}),/shared secret/);
  assert.throws(()=>accept({client_secret_expires_at:0}),/shared secret/);
  // Validating an already validated document changes nothing.
  const once=accept({token_endpoint_auth_method:'private_key_jwt',token_endpoint_auth_methods_supported:['none','private_key_jwt'],grant_types:['authorization_code','refresh_token']});
  assert.deepEqual(validateClientMetadata(once,clientId),once);
});
test('redirects match exactly, except that a loopback redirect may use any port',()=>{
  const declared=['https://app.example/cb','http://127.0.0.1/callback','http://localhost/callback','http://[::1]/v6','http://127.0.0.1:33418/','http://localhost/q?fixed=1'];
  for(const accepted of ['https://app.example/cb','http://127.0.0.1/callback','http://127.0.0.1:49152/callback','http://localhost:3118/callback','http://[::1]:5000/v6',
    'http://127.0.0.1:33418/','http://127.0.0.1:40000/','http://127.0.0.1:40000','http://localhost:9/q?fixed=1'])
    assert.equal(matchRedirectUri(declared,accepted),true,accepted);
  for(const refused of ['https://app.example/cb/','https://app.example:8443/cb','https://app.example/cb?x=1','https://APP.example/cb','http://app.example/cb',
    'http://127.0.0.1:49152/other','http://127.0.0.1:49152/callback/','http://127.0.0.1:49152/callback?x=1','http://localhost:3118/v6','http://[::1]:5000/callback',
    'https://127.0.0.1:49152/callback','https://localhost/callback','http://127.0.0.2:49152/callback','http://localhost.attacker.example:3118/callback','http://localhost.:3118/callback',
    'http://user@127.0.0.1:49152/callback','http://user:pass@localhost:3118/callback','http://127.0.0.1:49152/callback#fragment','http://127.0.0.1:49152/callback#',
    'http://localhost:9/q','http://localhost:9/q?fixed=2','http://0.0.0.0:49152/callback','http://127.0.0.1:99999/callback','not a url','',null,undefined,42,
    'http://127.0.0.1:1/'+'a'.repeat(2048)])
    assert.equal(matchRedirectUri(declared,refused),false,String(refused));
  // A remote redirect never gains the port exception.
  assert.equal(matchRedirectUri(['https://app.example/cb','http://127.0.0.1/cb'],'https://app.example:444/cb'),false);
  assert.equal(matchRedirectUri(['http://127.0.0.1/cb'],'http://localhost:1/cb'),false);
});
test('the id of a client registered in the configuration is a plain name that no metadata document URL can equal',()=>{
  for(const value of ['gemini-cli','Gemini.CLI_2','a','0','x'.repeat(200)]){
    assert.equal(configuredClientId(value),true,value);assert.throws(()=>clientMetadataUrl(value),undefined,value);
  }
  for(const value of [clientId,'https://client.example/a','http://127.0.0.1/a','urn:a:b','devmate:route-verification','a:b','a/b','a b','.a','-a','_a','','x'.repeat(201),'caf'+String.fromCharCode(233),' a','a\n',null,undefined,42,['a']])
    assert.equal(configuredClientId(value),false,String(value));
  // Its redirects are held to the rule a metadata document's redirects are held to.
  for(const uri of ['https://app.example/cb','http://127.0.0.1/cb','http://localhost:7777/cb','http://[::1]/cb'])assert.equal(usableRedirect(uri),true,uri);
  for(const uri of ['http://app.example/cb','http://192.168.1.2/cb','https://app.example/cb#fragment','https://user@app.example/cb','cursor://callback','/cb','',null,undefined,42])
    assert.equal(usableRedirect(uri),false,String(uri));
});
