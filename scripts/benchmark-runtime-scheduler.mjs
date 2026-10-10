#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../runtime/store.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-queue-latency-'));
const store=new Store(root);
const projects=[];
const size=4000;
function measure(call,repetitions=50) {
  const times=[];
  for(let i=0;i<repetitions;i++){
    const before=performance.now();
    call();times.push(performance.now()-before);
  }
  times.sort((a,b)=>a-b);
  return {p50Ms:+times[Math.floor(times.length*.5)].toFixed(3),
    p95Ms:+times[Math.floor(times.length*.95)].toFixed(3)};
}
try {
  for(let i=0;i<4;i++)projects.push(store.create('project',{root:path.join(root,'project-'+i),access:'write'}));
  const writer=store.db.prepare('INSERT INTO entities(id,kind,project_id,workflow_id,revision,data) VALUES(?,?,?,?,?,?)');
  store.transaction(()=>{
    for(let i=0;i<size;i++){
      const id='job-bench-'+String(i).padStart(8,'0');
      const project=projects[Math.floor(i/1000)];
      writer.run(id,'job',project.id,null,1,JSON.stringify({id,kind:'command',
        projectId:project.id,status:'queued',queuedSequence:i+1,input:{file:'node',args:[]}}));
    }
  });
  const busy=new Set([projects[0].id,projects[1].id,projects[2].id]);
  const oldScan=()=>{
    let afterId,rows=[];
    do{const page=store.list('job',{status:'queued',afterId,limit:1000});rows.push(...page);
      afterId=page.length===1000?page.at(-1).id:undefined;
    }while(afterId);
    return rows.filter(job=>!busy.has(job.projectId))
      .sort((a,b)=>a.queuedSequence-b.queuedSequence).slice(0,1);
  };
  const indexed=()=>store.runnableQueuedJobs(busy);
  if(oldScan().length!==indexed().length)throw Error('Semantics mismatch');
  for(let i=0;i<10;i++){oldScan();indexed();}
  console.log(JSON.stringify({rows:size,busyProjects:busy.size,
    fullMaterialization:measure(oldScan),indexedPerProject:measure(indexed)},null,2));
} finally {store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
