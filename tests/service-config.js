const assert=require('assert');
const http=require('http');
const {EventEmitter}=require('events');
const {servicePort,parsePort}=require('../src/service-config');
const {request}=require('../src/network');
async function run(){
  assert.equal(parsePort('61109\n'),61109);
  for(const bad of ['0','65536','-1','1.2','9993/path','NaN',''])assert.throws(()=>parsePort(bad));
  assert.equal(await servicePort('/test',async()=> '61109'),61109);
  assert.equal(await servicePort('/test',async()=>{throw Object.assign(new Error(),{code:'ENOENT'});}),9993);
  await assert.rejects(()=>servicePort('/test',async()=>{throw Object.assign(new Error('permission denied'),{code:'EACCES'});}));
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
