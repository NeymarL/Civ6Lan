const assert = require('assert');
const {Network,networkId,nodeId}=require('../src/network');
const ID='0123456789abcdef', OWNER='0123456789', FRIEND='abcdef0123';
function fixture(fail){
  const calls=[];let saved;
  const api=async(method,path,body)=>{
    calls.push({method,path,body});
    if(fail && fail(method,path,body))throw new Error('injected failure');
    if(path==='/status')return {address:OWNER,online:true};
    if(method==='GET' && path==='/network')return [];
    if(method==='POST' && path.endsWith('______'))return {id:ID};
    return {};
  };
  const service=new Network(api,async value=>{saved=value;});
  return {service,calls,saved:()=>saved};
}
async function run(){
  assert.equal(networkId(' CIV6-0123456789ABCDEF '),ID);
  for(const bad of ['../status','123',ID+'/member','']) assert.throws(()=>networkId(bad));
  assert.throws(()=>nodeId('../status'));
  let f=fixture();await f.service.create('好友局');
  assert.equal(f.saved().room.host,true);
  const config=f.calls.find(c=>c.path.endsWith('______')).body;
  assert.equal(config.private,true);assert.equal(config.enableBroadcast,true);
  assert.deepEqual(config.v4AssignMode,{zt:true});
  assert.equal(config.routes[0].via,null);
  assert.equal(f.calls.find(c=>c.path===`/network/${ID}`).body.allowDefault,false);
  await assert.rejects(()=>f.service.create('duplicate'));
  await f.service.authorize(FRIEND,true);
  assert.equal(f.calls[f.calls.length-1].body.authorized,true);
  await assert.rejects(()=>f.service.authorize(OWNER,false));
  await f.service.leave();assert.equal(f.saved().room,null);
  assert(f.calls.some(c=>c.method==='DELETE'&&c.path===`/controller/network/${ID}`));
  f=fixture((m,p)=>p===`/network/${ID}` && m==='POST');
  await assert.rejects(()=>f.service.create('fail'));
  assert.equal(f.service.room,null);
  assert(f.calls.some(c=>c.method==='DELETE'&&c.path===`/controller/network/${ID}`));
  f=fixture();await f.service.join('CIV6-'+ID);
  assert.equal(f.saved().room.host,false);
  await assert.rejects(()=>f.service.authorize(FRIEND,true));
  await f.service.leave();assert(!f.calls.some(c=>c.path.startsWith('/controller')));
  f=fixture();f.service.persist=async()=>{throw new Error('disk full');};
  await assert.rejects(()=>f.service.join(ID));
  assert(f.calls.some(c=>c.method==='DELETE'&&c.path===`/network/${ID}`));
  assert.equal(f.service.room,null);
  f=fixture();
  const originalApi=f.service.api;
  f.service.api=(method,path,body)=>method==='GET'&&path==='/network'?Promise.resolve([{id:ID}]):originalApi(method,path,body);
  await assert.rejects(()=>f.service.join(ID));
  assert(!f.calls.some(c=>c.method==='DELETE'));
  f=fixture();await f.service.create('snapshot');
  const baseApi=f.service.api;
  f.service.api=async(method,path,body)=>{
    if(path==='/network'&&method==='GET')return [{id:ID,status:'OK',assignedAddresses:['10.70.1.10/24']}];
    if(path===`/controller/network/${ID}/member`)return {[OWNER]:1,[FRIEND]:1};
    if(path===`/controller/network/${ID}/member/${OWNER}`)return {id:OWNER,authorized:true};
    if(path===`/controller/network/${ID}/member/${FRIEND}`)return {id:FRIEND,authorized:false};
    if(path==='/peer')return [{address:FRIEND,latency:42,paths:[{active:true}]},{address:'eeeeeeeeee',paths:[]}];
    return baseApi(method,path,body);
  };
  const state=await f.service.snapshot();
  assert.equal(state.members.length,2);assert.equal(state.network.status,'OK');
  assert.equal(state.peers.length,1);assert.equal(state.peers[0].direct,true);
  console.log('PASS: 邀请码校验、私有网络配置、授权、重复加入保护、房主退出、创建/保存失败回滚');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
