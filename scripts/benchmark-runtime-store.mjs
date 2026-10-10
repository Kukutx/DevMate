#!/usr/bin/env node
// DevMate 4 SQLite throughput baseline: isolated fresh state, no production files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../runtime/store.mjs';

const size = Number(process.argv[2] || 3000);
if (!Number.isSafeInteger(size) || size < 100 || size > 30000) throw new Error('Specify 100 to 30000 fixture tasks.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-store-bench-'));
const store = new Store(directory);
const withRootIndex = !process.argv.includes('--no-root-index');
if (!withRootIndex) store.db.exec('DROP INDEX projects_by_root');
const measurements = { writes: [], scopedReads: [], statusReads: [], events: [] };
const time = (key, call) => { const start = performance.now(); const result = call(); measurements[key].push(performance.now()-start); return result; };
const percentile = (samples, p) => samples.slice().sort((a,b)=>a-b)[Math.min(samples.length-1,Math.floor(p*(samples.length-1)))];
const summarize = values => ({ count: values.length, p50Ms: +percentile(values,0.50).toFixed(3),
  p95Ms: +percentile(values,0.95).toFixed(3), p99Ms: +percentile(values,0.99).toFixed(3) });
try {
  const ownRoot=path.join(directory,'mine'),otherRoot=path.join(directory,'foreign');
  fs.mkdirSync(ownRoot);fs.mkdirSync(otherRoot);
  const mine = store.create('project',{name:'Mine',root:ownRoot,access:'write'});
  const foreign = store.create('project',{name:'Foreign',root:otherRoot,access:'write'});
  const ownWorkflow = store.create('workflow',{projectId:mine.id,title:'Mine'});
  const foreignWorkflow = store.create('workflow',{projectId:foreign.id,title:'Foreign'});
  const start = performance.now();
  for(let i=0;i<size;i++){
    const own=i%3===0,project=own?mine:foreign,workflow=own?ownWorkflow:foreignWorkflow;
    time('writes',()=>store.create('task',{projectId:project.id,workflowId:workflow.id,
      title:'Task benchmark '+i,status:i%4===0?'running':'queued'}));
  }
  const elapsed=performance.now()-start;
  for(let i=0;i<200;i++){
    const cursor= i%2===0 ? undefined : 'task-';
    time('scopedReads',()=>store.list('task',{projectIds:[mine.id],afterId:cursor,limit:50}));
    time('statusReads',()=>store.list('task',{projectIds:[mine.id],status:'queued',limit:50}));
    time('events',()=>store.events({projectId:mine.id,after:0,limit:50}));
  }
  const dbSize=fs.statSync(path.join(directory,'state.sqlite')).size;
  const wal=path.join(directory,'state.sqlite-wal');
  const output={rows:size,rootIndex:withRootIndex,writeThroughputPerSecond:Math.round(size/(elapsed/1000)),
    databaseBytes:dbSize,walBytes:fs.existsSync(wal)?fs.statSync(wal).size:0,
    residentMiB:+(process.memoryUsage().rss/1048576).toFixed(1),
    measurements:Object.fromEntries(Object.entries(measurements).map(([key,values])=>[key,summarize(values)]))};
  console.log(JSON.stringify(output,null,2));
} finally {
  store.close();
  fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
