import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeOtherText, createWorkspaceService, resolveProjectPath } from '../runtime/workspace.mjs';

const git = (cwd, ...args) => ({ exitCode: spawnSync('git', args, { cwd, windowsHide: true }).status });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-workspace-'));
  const events = [];
  const project = { id: 'project-test', root, access: 'write' };
  const service = createWorkspaceService({ store: { event: (...value) => events.push(value) } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, service, events };
}
test('explicit CAS creates, updates, rejects stale and missing versions, and records metadata only', async t => {
  const {root, project, service, events} = await fixture(t);
  // A new file needs no hash. Replacing an existing one always does: nothing is overwritten unseen.
  const first = service.write(project, {path:'readme.md',text:'one'});
  assert.equal(service.read(project,{path:'readme.md'}).sha256,first.sha256);
  // The refusal says to read the file first; it does not hand over the value that reading it supplies.
  assert.throws(() => service.write(project,{path:'readme.md',text:'two'}),error=>error.code==='conflict'&&/already exists/.test(error.message)&&!JSON.stringify(error.details||{}).includes(first.sha256));
  assert.throws(() => service.write(project,{path:'readme.md',text:'two',expectedSha256:null}),{code:'conflict'});
  assert.throws(() => service.write(project,{path:'readme.md',text:'two',expectedSha256:'not a hash'}),{code:'invalid_input'});
  const second = service.write(project,{path:'readme.md',text:'two',expectedSha256:first.sha256});
  assert.throws(() => service.write(project,{path:'readme.md',text:'three',expectedSha256:first.sha256}),{code:'conflict'});
  assert.equal(fs.readFileSync(path.join(root,'readme.md'),'utf8'),'two');
  assert.equal(second.written,true);
  assert.equal(service.write(project,{path:'readme.md',text:'two',expectedSha256:second.sha256}).written,false);
  assert.equal(events.length,2);
  assert.equal(JSON.stringify(events).includes('"text"'),false);
  assert.deepEqual(fs.readdirSync(root),['readme.md']);
});
test('two service clients cannot both publish the same stale file version',async t=>{
  const {project,service}=await fixture(t);
  const first=service.write(project,{path:'same.txt',text:'one',expectedSha256:null});
  const other=createWorkspaceService();
  const results=await Promise.allSettled([service,other].map((client,i)=>Promise.resolve().then(()=>client.write(project,{path:'same.txt',text:String(i),expectedSha256:first.sha256}))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'conflict');
});
test('read-only projects permit reads and reject writes and commands',async t=>{
  const {project,service}=await fixture(t);
  service.write(project,{path:'a.txt',text:'a',expectedSha256:null});
  const ro={...project,access:'read'};
  assert.equal(service.read(ro,{path:'a.txt'}).text,'a');
  assert.throws(()=>service.write(ro,{path:'b.txt',text:'b',expectedSha256:null}),{code:'read_only'});
  assert.throws(()=>service.edit(ro,{path:'a.txt',edits:[{oldText:'a',newText:'b'}]}),{code:'read_only'});
});
test('canonical containment rejects traversal, absolute, Windows alias and junction paths',async t=>{
  const {root,project,service}=await fixture(t);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-outside-'));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'data.txt'),'outside');
  fs.symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
  // Device names and alternate data streams exist only on Windows; elsewhere they are ordinary file names.
  for(const p of ['../data.txt',outside,'.env','link/data.txt',...(process.platform==='win32'?['C:\\outside.txt','NUL','.env.','a.txt:stream']:[])]){
    assert.throws(()=>service.read(project,{path:p}));
    assert.throws(()=>service.write(project,{path:p,text:'bad',expectedSha256:null}));
  }
  assert.equal(fs.readFileSync(path.join(outside,'data.txt'),'utf8'),'outside');
});
test('a link that stays inside the project is read through and listed; nothing is changed through it, and it is never a way out or around the protection',async t=>{
  const {root,project,service}=await fixture(t);
  const kind=process.platform==='win32'?'junction':'dir';
  // What a package manager builds: the real files in a store folder, and a linked folder that points at them.
  fs.mkdirSync(path.join(root,'store','lib'),{recursive:true});fs.writeFileSync(path.join(root,'store','lib','index.js'),'module.exports = 1;\n');
  fs.mkdirSync(path.join(root,'packages'));fs.symlinkSync(path.join(root,'store','lib'),path.join(root,'packages','lib'),kind);
  assert.equal(service.read(project,{path:'packages/lib/index.js'}).text,'module.exports = 1;\n');
  assert.deepEqual(service.files(project,{path:'packages'}).items.map(item=>[item.name,item.type]),[['lib','directory']]);
  assert.deepEqual(service.files(project,{path:'packages/lib'}).items.map(item=>item.name),['index.js']);
  assert.equal(Buffer.from(service.readBytes(project,{path:'packages/lib/index.js',offset:0}).base64,'base64').toString(),'module.exports = 1;\n');
  // Changing goes to the real path, never through the link.
  for(const change of [()=>service.write(project,{path:'packages/lib/new.js',text:'x',expectedSha256:null}),()=>service.edit(project,{path:'packages/lib/index.js',edits:[{oldText:'1',newText:'2'}]}),
    ()=>service.remove(project,{path:'packages/lib/index.js'}),()=>service.move(project,{from:'packages/lib/index.js',to:'moved.js'})])
    assert.throws(change,{code:'unsafe_path'});
  assert.equal(fs.readFileSync(path.join(root,'store','lib','index.js'),'utf8'),'module.exports = 1;\n');
  // A link to a protected place is judged by where it leads.
  fs.mkdirSync(path.join(root,'credentials'));fs.writeFileSync(path.join(root,'credentials','token.txt'),'secret');
  fs.symlinkSync(path.join(root,'credentials'),path.join(root,'harmless-name'),kind);
  assert.throws(()=>service.read(project,{path:'harmless-name/token.txt'}),{code:'protected_workspace_path'});
  assert.equal(service.files(project,{}).items.some(item=>item.name==='harmless-name'),false);
  // A link that leads out of the project, or nowhere, is refused for reading as for everything else.
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'data.txt'),'outside');fs.symlinkSync(outside,path.join(root,'way-out'),kind);
  assert.throws(()=>service.read(project,{path:'way-out/data.txt'}),{code:'outside_project'});
  assert.equal(service.files(project,{}).items.some(item=>item.name==='way-out'),false);
  fs.mkdirSync(path.join(root,'gone'));fs.symlinkSync(path.join(root,'gone'),path.join(root,'dangling'),kind);fs.rmdirSync(path.join(root,'gone'));
  assert.throws(()=>service.read(project,{path:'dangling/x.txt'}),{code:'not_found'});
});
test('sensitive paths are excluded from files/search and rejected by direct access',async t=>{
  const {root,project,service}=await fixture(t);
  fs.writeFileSync(path.join(root,'.env'),'hiddenneedle=secret');
  fs.writeFileSync(path.join(root,'code.txt'),'hiddenneedle public');
  fs.mkdirSync(path.join(root,'credentials'));
  fs.writeFileSync(path.join(root,'credentials','data.txt'),'hiddenneedle credential');
  assert.throws(()=>service.read(project,{path:'.env'}),{code:'protected_workspace_path'});
  assert.deepEqual(service.files(project).items.map(x=>x.name),['code.txt']);
  const result=await service.search(project,{query:'hiddenneedle'});
  assert.deepEqual(result.items.map(x=>x.path),['code.txt']);
  assert.equal(result.items[0].line,1);
});
test('directory pagination is scoped and does not expose protected entries',async t=>{
  const {root,project,service}=await fixture(t);
  for(const name of ['a.txt','b.txt','c.txt','.env'])fs.writeFileSync(path.join(root,name),name);
  const one=service.files(project,{limit:1}),two=service.files(project,{limit:1,cursor:one.nextCursor}),three=service.files(project,{limit:1,cursor:two.nextCursor});
  assert.deepEqual([...one.items,...two.items,...three.items].map(x=>x.name),['a.txt','b.txt','c.txt']);
  assert.equal(three.nextCursor,undefined);
  fs.mkdirSync(path.join(root,'sub'));
  assert.throws(()=>service.files(project,{path:'sub',cursor:one.nextCursor}),{code:'invalid_cursor'});
});
test('binary and invalid UTF-8 are not editable text, and a file with a second name is read but never changed',async t=>{
  const {root,project,service}=await fixture(t);
  fs.writeFileSync(path.join(root,'binary.dat'),Buffer.from([0,1,2]));
  fs.writeFileSync(path.join(root,'invalid.txt'),Buffer.from([0xff]));
  fs.writeFileSync(path.join(root,'original.txt'),'original');
  fs.linkSync(path.join(root,'original.txt'),path.join(root,'alias.txt'));
  assert.throws(()=>service.read(project,{path:'binary.dat'}),error=>error.code==='binary_file'&&/operations_call workspace\.read_bytes/.test(error.message));
  // A file with two names (a hard link, as package managers make them) is read like any other. Changing it would change
  // what its other name shows, possibly outside the project, so that stays refused.
  assert.equal(service.read(project,{path:'alias.txt'}).text,'original');
  assert.throws(()=>service.edit(project,{path:'alias.txt',edits:[{oldText:'original',newText:'changed'}]}),{code:'unsafe_file'});
  assert.equal(fs.readFileSync(path.join(root,'original.txt'),'utf8'),'original');
  // Text in another encoding is still text: it can be read, and it is not rewritten as UTF-8 behind the user's back.
  const foreign=service.read(project,{path:'invalid.txt'});
  assert.equal(foreign.text.length,1);assert.ok(foreign.encoding);assert.match(foreign.note,/not UTF-8/);
  assert.throws(()=>service.edit(project,{path:'invalid.txt',edits:[{oldText:foreign.text,newText:'x'}]}),error=>error.code==='binary_file'&&/other than UTF-8/.test(error.message));
  assert.deepEqual([...fs.readFileSync(path.join(root,'invalid.txt'))],[0xff]);
  fs.writeFileSync(path.join(root,'wide.txt'),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('héllo\r\n世界','utf16le')]));
  assert.deepEqual([service.read(project,{path:'wide.txt'}).text,service.read(project,{path:'wide.txt'}).encoding],['héllo\r\n世界','utf-16le']);
  assert.equal(decodeOtherText(Buffer.from([0xd6,0xd0,0xce,0xc4]),'gbk').text,'中文');
  assert.deepEqual(decodeOtherText(Buffer.from([0x63,0x61,0x66,0xe9]),'gbk'),{text:'café',encoding:'windows-1252'},'bytes that do not fit the local encoding are read as Latin-1');
  // A folder is not a file, and the answer says what to use instead.
  fs.mkdirSync(path.join(root,'folder'));
  assert.throws(()=>service.read(project,{path:'folder'}),error=>error.code==='is_directory'&&/workspace_files/.test(error.message));
  assert.throws(()=>service.write(project,{path:'original.txt/inside.txt',text:'x',expectedSha256:null}),error=>error.code==='not_directory'&&!/EEXIST|ENOTDIR/.test(error.message));
});
test('search treats shell and option characters as query data',async t=>{
  const {root,project,service}=await fixture(t);
  fs.writeFileSync(path.join(root,'text.txt'),'--help & $(no command)\nsecond');
  const result=await service.search(project,{query:'--help & $(no command)'});
  assert.equal(result.items.length,1);assert.equal(result.items[0].text,'--help & $(no command)');
});
test('Git status and diff omit protected data and disable external diff execution',async t=>{
  const {root,project,service}=await fixture(t);
  assert.equal(git(root,'init','--quiet').exitCode,0);
  fs.writeFileSync(path.join(root,'file.txt'),'before\n');
  fs.writeFileSync(path.join(root,'.env'),'SECRET=before\n');
  assert.equal(git(root,'add','--','file.txt','.env').exitCode,0);
  fs.writeFileSync(path.join(root,'file.txt'),'after\n');
  fs.writeFileSync(path.join(root,'.env'),'SECRET=after\n');
  const previous=process.env.GIT_EXTERNAL_DIFF;
  process.env.GIT_EXTERNAL_DIFF='this-command-must-not-run';
  t.after(()=>{if(previous===undefined)delete process.env.GIT_EXTERNAL_DIFF;else process.env.GIT_EXTERNAL_DIFF=previous;});
  // A protected file is named, so nobody stages it by accident, and marked; its content never appears.
  const status=await service.gitStatus(project);
  assert.deepEqual(status.items.map(x=>[x.path,x.protected===true]),[['.env',true],['file.txt',false]]);
  assert.match(status.stdout,/\.env {2}\[protected: do not commit\]/);
  const diff=await service.gitDiff(project);
  assert.match(diff.stdout,/\+after/);
  assert.equal(diff.stdout.includes('SECRET'),false);
  assert.equal(diff.stdout.includes('.env'),false);
  assert.equal(diff.omittedProtected,1);assert.match(diff.stdout,/1 protected file\(s\) changed and are not shown/);
  await assert.rejects(service.gitDiff(project,{paths:['.env']}),{code:'protected_workspace_path'});
});
test('exported path resolver supports bounded artifact lookup and missing create paths',async t=>{
  const {root,project}=await fixture(t);
  fs.writeFileSync(path.join(root,'image.bin'),Buffer.from([0,1,2]));
  assert.equal(resolveProjectPath(project,'image.bin'),path.join(root,'image.bin'));
  assert.equal(resolveProjectPath(project,'future.txt',{mustExist:false}),path.join(root,'future.txt'));
  assert.throws(()=>resolveProjectPath(project,'future.txt'),{code:'not_found'});
});

test('custom instance control subtree is hidden from files, search, Git and artifact paths', async t => {
  const { root, project, service } = await fixture(t);
  const controlRoot = path.join(root, 'ordinary-folder'); fs.mkdirSync(controlRoot);
  const scoped = { ...project, controlRoot };
  fs.writeFileSync(path.join(controlRoot, 'state.txt'), 'controlneedle secret');
  fs.writeFileSync(path.join(root, 'public.txt'), 'controlneedle public');
  for (const action of [
    () => service.read(scoped, { path: 'ordinary-folder/state.txt' }),
    () => service.write(scoped, { path: 'ordinary-folder/new.txt', text: 'bad', expectedSha256: null }),
    () => resolveProjectPath(scoped, 'ordinary-folder/state.txt')
  ]) assert.throws(action, { code: 'protected_instance_path' });
  assert.deepEqual(service.files(scoped).items.map(item => item.name), ['public.txt']);
  assert.deepEqual((await service.search(scoped, { query: 'controlneedle' })).items.map(item => item.path), ['public.txt']);
  assert.equal(git(root, 'init', '--quiet').exitCode, 0);
  assert.equal(git(root, 'add', '--', '.').exitCode, 0);
  fs.writeFileSync(path.join(controlRoot, 'state.txt'), 'controlneedle changed secret');
  fs.writeFileSync(path.join(root, 'public.txt'), 'controlneedle changed public');
  assert.deepEqual((await service.gitStatus(scoped)).items.map(item => item.path), ['public.txt']);
  const diff = await service.gitDiff(scoped);
  assert.match(diff.stdout, /changed public/); assert.equal(diff.stdout.includes('secret'), false);
  await assert.rejects(service.gitDiff(scoped, { paths: ['ordinary-folder/state.txt'] }), { code: 'protected_instance_path' });
});


test('large local files remain readable through bounded byte pages without loading the full file',async t=>{
  const {root,project,service}=await fixture(t);
  const expected=Buffer.alloc(8*1024*1024+128,0x5a);
  const filename='big-data.bin';
  fs.writeFileSync(path.join(root,filename),expected);
  assert.equal(service.read(project,{path:filename}).truncated,true,'one enormous line is cut, with a note');
  // Text of that size (a long log) is read a part at a time; editing keeps its smaller limit.
  const log='line of a long log\n'.repeat(Math.ceil((8*1024*1024+128)/19));
  fs.writeFileSync(path.join(root,'long.log'),log);
  const head=service.read(project,{path:'long.log'});
  assert.equal(head.startLine,1);assert.equal(head.truncated,true);assert.equal(head.totalLines,log.length/19);assert.ok(head.nextStartLine>1);
  assert.equal(service.read(project,{path:'long.log',startLine:head.totalLines-1,lineCount:5}).endLine,head.totalLines);
  assert.throws(()=>service.edit(project,{path:'long.log',edits:[{oldText:'line',newText:'row'}]}),error=>error.code==='file_too_large'&&/last lines/.test(error.message));
  assert.equal((await service.search(project,{query:'line of a long log',path:'.',limit:3})).items.length,3,'and searched');
  const parts=[];let offset=0,version;
  do {
    const page=service.readBytes({...project,access:'read'},{
      path:filename,offset,length:131072,...(version?{expectedVersion:version}:{})
    });
    version=page.version;
    assert.equal(page.encoding,'base64');
    assert.ok(page.bytes<=131072);
    parts.push(Buffer.from(page.base64,'base64'));
    offset=page.nextOffset;
  }while(offset!==null);
  assert.deepEqual(Buffer.concat(parts),expected);
  const first=service.readBytes(project,{path:filename,offset:0,length:4096});
  fs.appendFileSync(path.join(root,filename),'changed');
  assert.throws(()=>service.readBytes(project,{path:filename,offset:4096,length:4096,expectedVersion:first.version}),{code:'conflict'});
  fs.writeFileSync(path.join(root,'.env'),'secret');
  assert.throws(()=>service.readBytes(project,{path:'.env',offset:0}),{code:'protected_workspace_path'});
  fs.writeFileSync(path.join(root,'original.txt'),'original');
  fs.linkSync(path.join(root,'original.txt'),path.join(root,'hardlink.txt'));
  assert.equal(Buffer.from(service.readBytes(project,{path:'hardlink.txt',offset:0}).base64,'base64').toString(),'original');
});

test('an edit keeps the line endings of a CRLF file, listings say what they leave out, and long answers say where they were cut',async t=>{
  const {root,project,service}=await fixture(t);
  fs.writeFileSync(path.join(root,'windows.txt'),'one\r\ntwo\r\nthree\r\n');
  // A single-line oldText needs no conversion to match; the two lines that replace it still get the file's line ending.
  service.edit(project,{path:'windows.txt',edits:[{oldText:'two',newText:'two\ntwo-and-a-half'}]});
  assert.equal(fs.readFileSync(path.join(root,'windows.txt'),'utf8'),'one\r\ntwo\r\ntwo-and-a-half\r\nthree\r\n');
  // A file that mixes line endings is left exactly as the edit says.
  fs.writeFileSync(path.join(root,'mixed.txt'),'a\r\nb\nc\n');
  service.edit(project,{path:'mixed.txt',edits:[{oldText:'b',newText:'b\nb2'}]});
  assert.equal(fs.readFileSync(path.join(root,'mixed.txt'),'utf8'),'a\r\nb\nb2\nc\n');
  // What cannot be read is not listed, but it is counted.
  fs.writeFileSync(path.join(root,'.env'),'TOKEN=x\n');fs.mkdirSync(path.join(root,'credentials'));fs.writeFileSync(path.join(root,'credentials','login.txt'),'x');
  fs.linkSync(path.join(root,'windows.txt'),path.join(root,'second-name.txt'));
  const listing=service.files(project,{});
  assert.deepEqual(listing.items.map(item=>item.name),['mixed.txt','second-name.txt','windows.txt'],'both names of a linked file are there to be read');
  assert.equal(listing.withheld,2);assert.match(listing.note,/2 entries are not shown/);
  assert.equal(service.files({...project,protectSecrets:false},{}).withheld,undefined,'without the protection nothing is kept back');
  const found=await service.find(project,{pattern:'**/*.txt'});
  assert.deepEqual(found.items.map(item=>item.path),['mixed.txt','second-name.txt','windows.txt']);assert.equal(found.withheld,1);
  assert.throws(()=>service.read(project,{path:'credentials/login.txt'}),error=>error.code==='protected_workspace_path'&&/owner can lift that/.test(error.message));
  // One very long line in a search hit is cut with a mark.
  fs.rmSync(path.join(root,'second-name.txt'));
  fs.writeFileSync(path.join(root,'wide.txt'),'needle '+'x'.repeat(5000)+'\n');
  const hit=(await service.search(project,{query:'needle'})).items.find(item=>item.path==='wide.txt');
  assert.match(hit.text,/\[line cut; 5007 characters\]$/);assert.equal(hit.text.length,2000+' [line cut; 5007 characters]'.length);
});
