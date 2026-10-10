'use strict';
const {randomUUID}=require('node:crypto');
function createRuntimeRecordStore({client,projectId,hostId,hostToken,kind}){
  if(!['operation','plan'].includes(kind))throw new Error('Invalid vault record kind.');
  const binding={projectId,hostId,hostToken,kind};
  return{
    createId:()=>kind+'-'+randomUUID(),
    read:recordId=>client.call('host.record.get',{...binding,recordId}),
    write:record=>client.call('host.record.put',{...binding,record}),
    async list(limit=50){return(await client.call('host.record.list',{...binding,limit})).items;},
    async listPublic(limit=50){return this.list(limit);}
  };
}
module.exports={createRuntimeRecordStore};
