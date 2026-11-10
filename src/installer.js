const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// 固定官方版本和文件哈希；不下载可变的 latest 地址。
const installers = {
  darwin: {version:'1.16.2',file:'ZeroTier-One-1.16.2.pkg',url:'https://download.zerotier.com/RELEASES/1.16.2/dist/ZeroTier%20One.pkg',sha256:'13b5054c0b51e337970e83da6f32bd245a70a5dd92421b08dadbefcaadf2f37f'},
  win32: {version:'1.16.2',file:'ZeroTier-One-1.16.2.msi',url:'https://download.zerotier.com/RELEASES/1.16.2/dist/ZeroTier%20One.msi',sha256:'42514072b0fe44b8f66e0395bcd23a0b1d1642c28ed00831f1527b2f41b14670'}
};
function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'download.zerotier.com' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('安装包下载地址不可信，已停止下载。');
  }
  return url.href;
}
async function downloadInstaller({platform,directory,fetch,signal,onProgress=()=>{},config=installers[platform]}) {
  if (!config) throw new Error('目前仅支持 Windows 和 macOS 自动安装。');
  if (!/^[a-f0-9]{64}$/.test(config.sha256)) throw new Error('安装包校验配置无效。');
  let temp, file;
  const checkAbort=()=>{if(signal && signal.aborted)throw new Error('下载已取消或超时，请重试。');};
  try {
    checkAbort();
    await fs.mkdir(directory,{recursive:true});
    // 每次用独立目录，不复用旧包，也不覆盖其他任务的文件。
    temp=await fs.mkdtemp(path.join(directory,'download-'));
    let url=trustedUrl(config.url), response;
    onProgress({phase:'downloading',received:0,total:0});
    for(let redirects=0;redirects<=3;redirects++) {
      checkAbort();
      response=await fetch(url,{redirect:'manual',signal});
      if([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get('location');
        if(response.body) await response.body.cancel();
        if(!location || redirects===3) throw new Error('下载重定向异常，请稍后重试。');
        url=trustedUrl(new URL(location,url).href);
      } else break;
    }
    if(response.status!==200 || !response.body) {if(response.body)await response.body.cancel();throw new Error(`官方下载失败（HTTP ${response.status}），请重试。`);}
    const total=Number(response.headers.get('content-length')) || 0, max=200*1024*1024;
    if(total>max) {await response.body.cancel();throw new Error('安装包大小异常，已停止下载。');}
    const partial=path.join(temp,config.file+'.part');
    file=await fs.open(partial,'wx',0o600);
    let received=0, last=0;const hash=crypto.createHash('sha256');
    for await (const chunk of response.body) {
      checkAbort();received+=chunk.byteLength;
      if(received>max)throw new Error('安装包大小异常，已停止下载。');
      hash.update(chunk);await file.writeFile(chunk);
      if(Date.now()-last>150){onProgress({phase:'downloading',received,total});last=Date.now();}
    }
    checkAbort();
    if(!received || (total && received!==total))throw new Error('下载不完整，请重试。');
    onProgress({phase:'verifying',received,total});
    if(hash.digest('hex')!==config.sha256)throw new Error('安装包校验失败，文件已删除。请重试或更新本应用。');
    await file.close();file=null;
    const destination=path.join(temp,config.file);
    await fs.rename(partial,destination);
    return {path:destination,directory:temp,version:config.version};
  } catch(error) {
    if(file)await file.close().catch(()=>{});
    if(temp)await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
    if(signal && signal.aborted)throw new Error('下载已取消或超时，请重试。');
    throw error;
  }
}
module.exports={downloadInstaller,installers,trustedUrl};
