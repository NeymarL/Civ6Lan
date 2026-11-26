const assert = require('node:assert/strict');
const {Startup} = require('../src/startup');
const {ZEROTIER_VERSION: expected} = require('../src/installer');

function fixture({version=null, status, failure}={}) {
  const calls=[];
  let installing={phase:'idle'};
  const startup=new Startup({
    readStatus:async()=>{
      if (!status) throw failure || new Error('service stopped');
      return status;
    },
    installedVersion:async()=>version,
    installation:()=>installing,
    install:async current=>{calls.push(['install',current]);installing={phase:'waiting'};},
    resetInstallation:()=>{installing={phase:'idle'};},
    start:async()=>calls.push('start'),
    authorize:async()=>calls.push('authorize')
  });
  return {
    startup,calls,
    setStatus:value=>{status=value;},
    setInstallation:value=>{installing=value;}
  };
}

async function test() {
  for (const version of [null,'1.16.2']) {
    const {startup,calls,setStatus}=fixture({version});
    assert.equal((await startup.check()).phase,'installing');
    await startup.check();
    assert.deepEqual(calls,[['install',version]]);
    setStatus({version:expected,online:true});
    assert.equal((await startup.check()).phase,'nickname');
  }

  const stopped=fixture({version:expected,failure:Object.assign(new Error('no token'),{code:'ZT_TOKEN_MISSING'})});
  assert.equal((await stopped.startup.check()).phase,'starting');
  assert.equal((await stopped.startup.check()).phase,'authorizing');
  assert.equal((await stopped.startup.check()).phase,'connecting');
  assert.deepEqual(stopped.calls,['start','authorize']);
  stopped.setStatus({version:expected,tcpFallbackActive:true});
  assert.equal((await stopped.startup.check()).phase,'nickname');

  const offline=fixture({status:{version:expected,online:false}});
  assert.equal((await offline.startup.check()).phase,'connecting');
  assert.deepEqual(offline.calls,[]);

  const reboot=fixture({version:expected});
  reboot.setInstallation({phase:'waiting',reboot:true});
  assert.equal((await reboot.startup.check()).phase,'installing');
  assert.deepEqual(reboot.calls,[]);

  const retry=fixture({version:'1.16.2'});
  retry.startup.dependencies.install=async()=>{throw new Error('下载已取消');};
  assert.deepEqual(await retry.startup.check(),{phase:'error',message:'下载已取消'});
  retry.startup.dependencies.install=async value=>retry.calls.push(value);
  assert.equal((await retry.startup.check()).phase,'error');
  assert.deepEqual(retry.calls,[]);
  assert.equal((await retry.startup.check(true)).phase,'installing');
  assert.deepEqual(retry.calls,['1.16.2']);
  console.log('PASS: 自动安装、等待重启、启动与授权、连接后确认昵称、失败后可重试');
}

test().catch(error=>{console.error(error);process.exitCode=1;});
