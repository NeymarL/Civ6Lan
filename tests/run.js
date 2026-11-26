const assert = require('assert');
const {Network,networkId,nodeId,parseInvite,inviteCode,applicationCode,parseApplication}=require('../src/network');
const {RoomProfiles}=require('../src/room-profiles');
const {RoomDiscovery}=require('../src/room-discovery');
const {echoMeasurement}=require('../src/room-probe');
const {ZEROTIER_VERSION}=require('../src/installer');
const ID='0123456789abcdef', OWNER='0123456789', FRIEND='abcdef0123';
const INVITE='CIV6-'+ID+'-0a46010a';
function fixture(fail){
  const calls=[];let saved;
  const api=async(method,path,body)=>{
    calls.push({method,path,body});
    if(fail && fail(method,path,body))throw new Error('injected failure');
    if(path==='/status')return {address:OWNER,online:true,version:ZEROTIER_VERSION};
    if(method==='GET' && path==='/network')return [];
    if(method==='GET' && path==='/peer')return [];
    if(method==='POST' && path.endsWith('______'))return {id:ID};
    return {};
  };
  const service=new Network(api,async value=>{saved=value;});
  return {service,calls,saved:()=>saved};
}
async function testDiscovery(){
  const room={id:ID,host:false};
  const ready={status:'OK'};
  let active=false;
  const starts=[];
  const backend={
    update:async (_room,network)=>({available:network?.status==='OK',active}),
    enable:async (_network,id,signal)=>{
      starts.push(id);
      if (starts.length===1) throw new Error('用户取消授权');
      if (starts.length===3) await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      active=true;
    },
    disable:async()=>{active=false;}
  };
  const discovery=new RoomDiscovery(backend);
  await discovery.update(room,{status:'ACCESS_DENIED'},true);
  await discovery.update(room,ready,false);
  assert.deepEqual(starts,[]);
  await Promise.all([discovery.update(room,ready,true),discovery.update(room,ready,true)]);
  assert.equal((await discovery.update(room,ready,true)).error,'用户取消授权');
  assert.deepEqual(starts,[ID]);
  await discovery.enable(ready,ID);
  assert.equal((await discovery.update(room,ready,true)).active,true);
  await discovery.disable();
  assert.equal((await discovery.update(room,ready,true)).active,false);
  assert.deepEqual(starts,[ID,ID]);
  const hostRoom={id:'0123456789123456',host:true};
  assert.equal((await discovery.update(hostRoom,ready,true)).starting,true);
  await discovery.disable();
  assert.equal((await discovery.update(null,null,true)).starting,false);
  assert.deepEqual(starts,[ID,ID,hostRoom.id]);
}
async function run(){
  await testDiscovery();
  assert.equal(networkId(' CIV6-0123456789ABCDEF '),ID);
  for(const bad of ['../status','123',ID+'/member','']) assert.throws(()=>networkId(bad));
  assert.throws(()=>nodeId('../status'));
  assert.throws(()=>nodeId(1234567890));
  assert.deepEqual(parseInvite('CIV6-'+ID),{id:ID});
  assert.deepEqual(parseInvite(INVITE),{id:ID,hostIp:'10.70.1.10'});
  const shortInvite=inviteCode({id:ID,host:true},{status:'OK',assignedAddresses:['10.70.1.10/24']},'房主 🎲');
  assert.equal(shortInvite.length,17);
  assert.deepEqual(parseInvite('CIV6-'+shortInvite),parseInvite(shortInvite));
  assert.deepEqual(parseInvite(shortInvite),{id:ID,hostIp:'10.70.1.10'});
  assert.equal(inviteCode({id:ID,host:false,hostIp:'10.70.1.10'}),shortInvite);
  assert.deepEqual(parseInvite(inviteCode({id:ID,host:true})),{id:ID});
  const enhancedInvite=inviteCode({id:ID,host:true,enhanced:true},{status:'OK',assignedAddresses:['10.70.1.10/24']});
  assert.deepEqual(parseInvite(enhancedInvite),{id:ID,hostIp:'10.70.1.10',enhanced:true});
  assert.deepEqual(parseInvite(inviteCode({id:ID,host:true,enhanced:true})),{id:ID,enhanced:true});
  const enhancedJoin=fixture();
  await assert.rejects(enhancedJoin.service.join(enhancedInvite,async()=>{throw new Error('cancelled');}),/cancelled/);
  assert(!enhancedJoin.calls.some(call=>call.method==='POST'));
  await enhancedJoin.service.join(enhancedInvite,async()=>{
    assert(!enhancedJoin.calls.some(call=>call.method==='POST'));
  });
  assert.equal(enhancedJoin.service.room.enhanced,true);
  for (const bad of [shortInvite+'.',shortInvite.slice(0,-1),shortInvite+'A','CIV6-S']) assert.throws(()=>parseInvite(bad));
  const shortJoin=fixture();
  await shortJoin.service.join(shortInvite,async()=>assert.fail('standard invites must not request relay'));
  assert.equal(shortJoin.service.room.hostIp,'10.70.1.10');
  const namedInvite=INVITE+'.'+Buffer.from('房主 🎲').toString('base64url');
  assert.deepEqual(parseInvite(namedInvite),{id:ID,hostIp:'10.70.1.10',hostNickname:'房主 🎲'});
  assert.throws(()=>parseInvite('CIV6-'+ID+'-'+ID));
  assert.throws(()=>parseInvite(INVITE+'.x'));
  assert.deepEqual(echoMeasurement('来自 10.70.1.10 的回复: 字节=32 时间<1ms TTL=64\n64 bytes from 10.70.1.10: ttl=64 time=3.5 ms','10.70.1.10'),{sent:2,replies:2,latency:2});
  assert.deepEqual(echoMeasurement('Reply from 10.70.1.20: Destination host unreachable.','10.70.1.10'),{sent:2,replies:0,latency:null});
  const application=applicationCode(ID,FRIEND,'小白 🎲');
  assert.deepEqual(parseApplication(application),{room:ID,address:FRIEND,nickname:'小白 🎲'});
  assert.throws(()=>parseApplication('CIV6-REQUEST-invalid'));
  assert.throws(()=>applicationCode(ID,FRIEND,'\u202e显示'));
  let f=fixture();await f.service.create('好友局');
  assert.equal(f.saved().room.host,true);
  assert.equal(inviteCode(f.service.room,{status:'OK',assignedAddresses:['10.70.1.10/24']}),shortInvite);
  await f.service.setNickname('  回合玩家 🎲  ');
  assert.equal(f.saved().nickname,'回合玩家 🎲');
  assert.equal(new Network(f.service.api,f.service.persist,f.saved()).nickname,'回合玩家 🎲');
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
  assert.equal(f.saved().nickname,'回合玩家 🎲');
  assert(f.calls.some(c=>c.method==='DELETE'&&c.path===`/controller/network/${ID}`));
  f=fixture((m,p)=>p===`/network/${ID}` && m==='POST');
  await assert.rejects(()=>f.service.create('fail'));
  assert.equal(f.service.room,null);
  assert(f.calls.some(c=>c.method==='DELETE'&&c.path===`/controller/network/${ID}`));
  f=fixture();await f.service.join(INVITE);
  assert.equal(f.saved().room.host,false);
  assert.equal(f.saved().room.hostIp,'10.70.1.10');
  await assert.rejects(()=>f.service.updateHostInfo('CIV6-0123456789123456'),/当前房间/);
  await f.service.updateHostInfo(namedInvite);
  assert.equal(f.saved().room.hostNickname,'房主 🎲');
  await f.service.updateHostInfo(INVITE);
  assert.equal(f.saved().room.hostNickname,'房主 🎲');
  const guestRoom=f.service.room;
  const readyNetwork={status:'OK',assignedAddresses:['10.70.1.43/24']};
  const relayMeasurement={sent:2,replies:1,latency:168};
  const measured=await f.service.roomLinks({room:guestRoom,address:FRIEND,network:readyNetwork},async (source,target)=>{
    assert.equal(source,'10.70.1.43');assert.equal(target,'10.70.1.10');return relayMeasurement;
  });
  assert.deepEqual(measured.links,[{address:OWNER,direct:false,latency:168,measurement:relayMeasurement}]);
  const guestApi=f.service.api;
  f.service.api=(method,path,body)=>path==='/peer'?Promise.resolve([{address:OWNER,latency:168,paths:[{active:true}]}]):guestApi(method,path,body);
  const noReply=await f.service.roomLinks({room:guestRoom,address:FRIEND,network:readyNetwork},async()=>({sent:2,replies:0,latency:null}));
  assert.deepEqual(noReply.links,[{address:OWNER,direct:true,latency:null,measurement:{sent:2,replies:0,latency:null}}]);
  const outside=await f.service.roomLinks({room:guestRoom,address:FRIEND,network:{status:'OK',assignedAddresses:['10.80.1.43/24']}},()=>{throw Error('unexpected probe');});
  assert.equal(outside.links[0].measurement,null);
  const guestProfiles=new RoomProfiles();
  assert.equal((await guestProfiles.sync({room:guestRoom,address:FRIEND,network:{status:'OK',assignedAddresses:['10.80.1.43/24']}},'成员'))[0].nickname,'房主 🎲');
  await assert.rejects(()=>f.service.acceptApplication(application),/只有房主/);
  await assert.rejects(()=>f.service.authorize(FRIEND,true));
  await f.service.leave();assert(!f.calls.some(c=>c.path.startsWith('/controller')));
  f=fixture();f.service.persist=async()=>{throw new Error('disk full');};
  await assert.rejects(()=>f.service.join(ID));
  assert(f.calls.some(c=>c.method==='DELETE'&&c.path===`/network/${ID}`));
  assert.equal(f.service.room,null);
  f=fixture();
  const originalApi=f.service.api;
  f.service.api=(method,path,body)=>method==='GET'&&path==='/network'?Promise.resolve([{nwid:ID,status:'ACCESS_DENIED'}]):originalApi(method,path,body);
  await f.service.join(ID);
  assert.equal(f.saved().room.existingNetwork,true);
  assert.equal(f.saved().room.host,false);
  const reopened = new Network(f.service.api, f.service.persist, f.saved());
  assert.equal((await reopened.snapshot()).network.status,'ACCESS_DENIED');
  await reopened.leave();
  assert.equal(f.saved().room,null);
  assert(f.calls.every(c=>c.method==='GET'));
  f=fixture();await f.service.create('snapshot');
  const baseApi=f.service.api;
  let deviceDiscovered=false;
  f.service.api=async(method,path,body)=>{
    if(path==='/network'&&method==='GET')return [{id:ID,status:'OK',assignedAddresses:['10.70.1.10/24']}];
    if(path===`/controller/network/${ID}/member`)return {[OWNER]:1,[FRIEND]:1};
    if(path===`/controller/network/${ID}/member/${OWNER}`)return {id:OWNER,authorized:true};
    if(path===`/controller/network/${ID}/member/${FRIEND}` && method==='GET'){
      if (!deviceDiscovered) throw Object.assign(new Error('member data not ready'), {statusCode:404});
      return {id:FRIEND,authorized:false};
    }
    if(path==='/peer')return [{address:FRIEND,latency:42,paths:[{active:true}]},{address:'eeeeeeeeee',paths:[]}];
    return baseApi(method,path,body);
  };
  const callsBeforePaste=f.calls.length;
  assert.equal(await f.service.acceptApplication(application),'小白 🎲');
  assert.equal(f.saved().room.applications[FRIEND],'小白 🎲');
  assert.equal(f.calls.length,callsBeforePaste);
  const hostReopened = new Network(f.service.api,f.service.persist,f.saved());
  const early = await hostReopened.snapshot({includePeers:false});
  assert.deepEqual(early.members.find(m=>m.address===FRIEND),{address:FRIEND,authorized:false,awaitingDiscovery:true});
  await assert.rejects(()=>hostReopened.authorize(FRIEND,true),/尚未识别/);
  assert(f.calls.slice(callsBeforePaste).every(call=>call.method==='GET'));

  deviceDiscovered=true;
  const state=await f.service.snapshot();
  assert.equal(state.members.length,2);assert.equal(state.network.status,'OK');
  assert.equal(state.peers.length,1);assert.equal(state.peers[0].direct,true);
  const profiles=new RoomProfiles();
  try {
    const members=await profiles.sync(state,'房主');
    assert.deepEqual(members.find(m=>m.address===FRIEND),{id:FRIEND,address:FRIEND,authorized:false,nickname:'小白 🎲'});
  } finally {profiles.close();}
  await f.service.authorize(FRIEND,true);
  assert.equal(f.calls.at(-1).body.authorized,true);
  console.log('PASS: 自动启用找房、取消和手动重试、昵称申请先于设备记录、设备记录恢复后批准、失败回滚');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
