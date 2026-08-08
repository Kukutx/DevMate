import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTeamConfigurationPatch } from '../gateway/team-management-tools.mjs';
function config(provider='external',publicUrl='https://external.example.com',allowedHosts=[]){return{version:11,connection:{provider,publicUrl},team:{members:[],requireWorkspaceLeaseForWrites:true,defaultMemberRole:'developer',maxMembers:100},requestPolicy:{maxRequestBytes:2097152,requestsPerMinute:600,maxConcurrentRequests:64,maxConcurrentPerPrincipal:16,requestTimeoutMs:900000,allowedHosts},runtime:{},jobs:{embeddedRunnerEnabled:true},runnerControl:{enabled:false,credentials:[]},workspaces:[]}}

test('dynamic provider transitions clear stale stable URLs',()=>{
 for(const provider of ['ngrok','cloudflare-quick']){const value=applyTeamConfigurationPatch(config(),{tunnelProvider:provider});assert.equal(value.connection.provider,provider);assert.equal(value.connection.publicUrl,'');}
});
test('managed and external providers require a stable URL in the same operation',()=>{
 for(const provider of ['cloudflare-managed','external']) assert.throws(()=>applyTeamConfigurationPatch(config('ngrok',''),{tunnelProvider:provider}),/requires a public HTTPS URL/);
});
test('same provider keeps stable URL when only another capability changes',()=>{const value=applyTeamConfigurationPatch(config(),{requestsPerMinute:900});assert.equal(value.connection.publicUrl,'https://external.example.com');assert.equal(value.requestPolicy.requestsPerMinute,900)});
test('explicit URL accompanies a managed provider change',()=>{const value=applyTeamConfigurationPatch(config(),{tunnelProvider:'cloudflare-managed',publicUrl:'https://managed.example.com'});assert.deepEqual(value.connection,{provider:'cloudflare-managed',publicUrl:'https://managed.example.com'})});
test('ngrok and Cloudflare Quick remain valid without a stable URL',()=>{assert.doesNotThrow(()=>applyTeamConfigurationPatch(config('ngrok',''),{}));assert.doesNotThrow(()=>applyTeamConfigurationPatch(config('cloudflare-quick',''),{}))});
test('connection changes never silently mutate explicit Host policy',()=>{const value=applyTeamConfigurationPatch(config('external','https://old.example.com',['old.example.com','manual.example.com']),{tunnelProvider:'cloudflare-quick'});assert.deepEqual(value.requestPolicy.allowedHosts,['old.example.com','manual.example.com'])});
test('allowedHosts changes only when explicitly patched',()=>{const value=applyTeamConfigurationPatch(config('external','https://old.example.com',['old.example.com']),{publicUrl:'https://new.example.com',allowedHosts:['explicit.example.com']});assert.equal(value.connection.publicUrl,'https://new.example.com');assert.deepEqual(value.requestPolicy.allowedHosts,['explicit.example.com'])});
