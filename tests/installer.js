const assert=require('assert');
const fs=require('fs').promises;
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {downloadInstaller,trustedUrl}=require('../src/installer');
async function test(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'civ6-installer-test-'));
  const bytes=Buffer.from('test installer bytes');
  const config={url:'https://download.zerotier.com/test.pkg',file:'test.pkg',version:'test',sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  function response({body=bytes,status=200,length=body.length,location}={}){
    return {status,headers:{get:key=>key==='location'?location:key==='content-length'?String(length):null},
      body:{cancel:async()=>{},async *[Symbol.asyncIterator](){yield body;}}};
  }
  const options={platform:'darwin',directory,config,fetch:async()=>response()};
  try {
    for(const url of ['http://download.zerotier.com/a','https://evil.test/file','https://download.zerotier.com.evil.test/a','https://user:password@download.zerotier.com/a','https://download.zerotier.com:8080/a'])assert.throws(()=>trustedUrl(url));
    const phases=[];
    const result=await downloadInstaller({...options,onProgress:value=>phases.push(value.phase)});
    assert.deepEqual(await fs.readFile(result.path),bytes);assert(phases.includes('verifying'));
    await fs.rm(result.directory,{recursive:true});
    async function rejected(overrides,pattern){
      await assert.rejects(()=>downloadInstaller({...options,...overrides}),pattern);
      assert.deepEqual(await fs.readdir(directory),[], '失败后必须删除临时文件');
    }
    await rejected({config:{...config,sha256:'0'.repeat(64)}},/校验失败/);
    await rejected({fetch:async()=>response({status:404})},/HTTP 404/);
    await rejected({fetch:async()=>response({length:bytes.length+1})},/不完整/);
    await rejected({fetch:async()=>response({status:302,location:'https://evil.test/x'})},/不可信/);
    await rejected({fetch:async()=>response({status:302,location:'/loop'})},/重定向异常/);
    await rejected({fetch:async()=>response({length:201*1024*1024})},/大小异常/);
    const abort=new AbortController();
    await rejected({signal:abort.signal,fetch:async()=>{abort.abort();return response();}},/取消/);
    await rejected({fetch:async()=>{throw new Error('connection reset');}},/connection reset/);
    console.log('PASS: 下载完成、哈希不符、HTTP失败、截断、恶意重定向、大小限制、取消与失败文件清理');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}
test().catch(error=>{console.error(error);process.exitCode=1;});
