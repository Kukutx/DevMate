import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnectionRecovery } from '../runtime/connection-recovery.mjs';
import { createConnection } from '../runtime/connection.mjs';

test('connection recovery uses bounded exponential delays and stops scheduling after disable',async()=>{
  const scheduled=[];
  let time=1000,starts=0;
  const recovery=createConnectionRecovery({
    restart:async()=>{starts++;if(starts===1)throw new Error('temporary network error');},
    onError:()=>{},
    now:()=>time,
    schedule:(fn,delay)=>{const timer={fn,delay,cancelled:false};scheduled.push(timer);return timer;},
    cancel:timer=>{timer.cancelled=true;}
  });
  recovery.enable();recovery.unexpectedExit();
  assert.equal(scheduled[0].delay,1000);
  time+=1000;await scheduled[0].fn();
  assert.equal(scheduled[1].delay,2000);
  time+=2000;await scheduled[1].fn();
  assert.equal(starts,2);
  assert.equal(recovery.status().retryScheduled,false);
  recovery.unexpectedExit();
  assert.equal(scheduled[2].delay,4000);
  recovery.disable();
  assert.equal(scheduled[2].cancelled,true);
  await scheduled[2].fn();
  assert.equal(starts,2);
  assert.equal(recovery.status().autoReconnect,false);
});

test('owned official tunnel restarts after child exit, and manual stop cancels future reconnect',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-native-tunnel-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const children=[];
  const spawnImpl=()=>{
    const child=new EventEmitter();
    child.pid=children.length+100;
    child.exitCode=null;child.signalCode=null;
    children.push(child);
    return child;
  };
  const connection=createConnection({instanceRoot:root,
    localMcpUrl:'http://127.0.0.1:23456/mcp',
    config:{kind:'openai-tunnel',tunnelId:'tunnel_fixture',executable:process.execPath},
    env:{CONTROL_PLANE_API_KEY:'synthetic-test-key'},
    spawnImpl,
    terminateImpl:async child=>{child.exitCode=0;child.emit('exit',0);return {exitConfirmed:true};}
  });
  await connection.start();
  assert.equal(children.length,1);
  children[0].exitCode=3;children[0].emit('exit',3);
  assert.equal((await connection.status()).retryScheduled,true);
  const deadline=Date.now()+5000;
  while(children.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(children.length,2);
  assert.equal((await connection.status()).autoReconnect,true);
  await connection.stop();
  const count=children.length;
  await new Promise(resolve=>setTimeout(resolve,1150));
  assert.equal(children.length,count,'explicit stop must not respawn a tunnel');
});
