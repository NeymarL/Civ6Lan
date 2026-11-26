const assert=require('assert');
const http=require('http');
const {EventEmitter}=require('events');
const {servicePort,serviceTokenPaths,requestWithServiceToken,parsePort,needsMacHostingRepair}=require('../src/service-config');
const {Network,request}=require('../src/network');
const {relayState,relayCommand}=require('../src/enhanced-connection');
async function run(){
  assert.equal(parsePort('61109\n'),61109);
  assert.deepEqual(relayState({config:{settings:{forceTcpRelay:true}}}),{forced:true,active:false});
  assert.deepEqual(relayState({tcpFallbackActive:true}),{forced:false,active:true});
  assert.throws(()=>relayCommand('true','darwin'),/连接模式无效/);
  for (const version of ['1.16.0','1.16.1','1.16.2']) assert(needsMacHostingRepair(version,'darwin'));
  for (const version of ['1.14.2','1.16.3']) assert(!needsMacHostingRepair(version,'darwin'));
  assert(!needsMacHostingRepair('1.16.2','win32'));
  if (process.platform==='darwin') {
    const room={id:'0123456789abcdef',host:true};
    const api=async (method,path)=>{
      if (method==='GET' && path==='/status') return {address:'0123456789',online:true,version:'1.16.2'};
      if (method==='GET' && path==='/network') return [];
      assert.fail('Hosting operations must wait for a compatible controller.');
    };
    await assert.rejects(()=>new Network(api,()=>{}).create('好友房间'),/1\.12\.2/);
    await assert.rejects(()=>new Network(api,()=>{}).join(room.id),/1\.12\.2/);
    const savedHost=new Network(api,()=>{},{room});
    assert.equal((await savedHost.snapshot({includePeers:false})).versionMismatch,true);
    await assert.rejects(()=>savedHost.authorize('fedcba4321',true),/兼容建房/);
  }
  for(const bad of ['0','65536','-1','1.2','9993/path','NaN',''])assert.throws(()=>parsePort(bad));
  assert.equal(await servicePort('/test',async()=> '61109'),61109);
  assert.equal(await servicePort('/test',async()=>{throw Object.assign(new Error(),{code:'ENOENT'});}),9993);
  await assert.rejects(()=>servicePort('/test',async()=>{throw Object.assign(new Error('permission denied'),{code:'EACCES'});}));
  const windows = {LOCALAPPDATA:'C:\\Users\\Player\\AppData\\Local', ProgramData:'C:\\ProgramData'};
  const paths = serviceTokenPaths('win32', windows);
  const userToken = 'C:\\Users\\Player\\AppData\\Local\\ZeroTier\\authtoken.secret';
  const legacyToken = 'C:\\Users\\Player\\AppData\\Local\\ZeroTier\\One\\authtoken.secret';
  const machineToken = 'C:\\ProgramData\\ZeroTier\\One\\authtoken.secret';
  assert.deepEqual(paths, [userToken, legacyToken, machineToken]);
  assert.equal(await servicePort('C:\\ProgramData\\ZeroTier\\One', async()=>{throw Object.assign(new Error(),{code:'EACCES'});}, 'win32'), 9993);
  const sent = [];
  const result = await requestWithServiceToken({
    cachedToken:'stale-token',
    paths,
    read:async file => {
      assert.equal(file,userToken);
      return 'current-token\r\n';
    },
    send:async value => {
      sent.push(value);
      if(value==='stale-token')throw Object.assign(new Error(),{code:'ZT_AUTH'});
      return {online:true};
    }
  });
  assert.deepEqual(sent,['stale-token','current-token']);
  assert.deepEqual(result,{token:'current-token',data:{online:true}});
  await assert.rejects(()=>requestWithServiceToken({
    paths,
    read:async()=>{throw Object.assign(new Error(),{code:'EACCES'});},
    send:async()=>assert.fail('Requests need a token.')
  }), {code:'ZT_TOKEN_MISSING'});
  await assert.rejects(()=>requestWithServiceToken({
    cachedToken:'valid-token',
    paths,
    read:async()=>assert.fail('A connection failure must not be retried with other tokens.'),
    send:async()=>{throw Object.assign(new Error(),{code:'ECONNREFUSED'});}
  }), {code:'ECONNREFUSED'});
  let current='61109';const read=async()=>current;
  assert.equal(await servicePort('/test',read),61109);current='61234';assert.equal(await servicePort('/test',read),61234);
  const original=http.request;
  try{
    http.request=(options,callback)=>{
      assert.equal(options.hostname,'127.0.0.1');assert.equal(options.port,61109);
      const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>{
        const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data','{"online":true}');res.emit('end');
      };return req;
    };
    assert.equal((await request('test-token','GET','/status',undefined,61109)).online,true);
    await assert.rejects(()=>request('test-token','GET','/status',undefined,65536));
  }finally{http.request=original;}
  console.log('PASS: 动态端口、重启后端口变化、缺失默认值、无效/无权限文件、实际请求端口传递');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
