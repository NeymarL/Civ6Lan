const {app,BrowserWindow,ipcMain,dialog,shell,clipboard,net} = require('electron');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const {execFile} = require('child_process');
const {Network,request} = require('./network');
const {downloadInstaller} = require('./installer');
const {servicePort} = require('./service-config');
if(process.argv.some(arg=>['--smoke-test','--download-test'].includes(arg))) {
  const testData=path.join(os.tmpdir(),'civ6-lan-check-'+process.pid);
  require('fs').mkdirSync(testData,{recursive:true});app.setPath('userData',testData);
}
let win, token, service, busy = false;
let installState={phase:'idle'}, downloadAbort;
function installProgress(value) {
  installState=value;
  if(win && !win.isDestroyed())win.webContents.send('install-progress',value);
}
function runFile(file,args) {
  return new Promise((resolve,reject)=>execFile(file,args,{timeout:30000,windowsHide:true},(error,stdout)=>error?reject(new Error('无法验证安装包的系统签名，未启动安装。请检查网络和系统信任设置后重试。')):resolve(stdout)));
}
async function verifySignature(file) {
  if(process.platform==='darwin') {
    const signature=await runFile('/usr/sbin/pkgutil',['--check-signature',file]);
    if(!signature.includes('Developer ID Installer: ZeroTier, Inc (8ZD9JUCZ4V)') || /invalid signature/i.test(signature))throw new Error('安装包发布者签名无效，未启动安装。');
  } else {
    const escaped=file.replace(/'/g,"''");
    const signature=await runFile(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',`$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -ne 'Valid') { exit 1 }; $s.SignerCertificate.Subject`]);
    if(!/ZeroTier/i.test(signature))throw new Error('安装包发布者不是 ZeroTier，未启动安装。');
  }
}
async function installZeroTier() {
  if(installState.phase==='waiting')throw new Error('系统安装程序已打开，请完成或关闭后点击“安装后重试”。');
  try {
    await service.api('GET','/status');
    installProgress({phase:'complete',message:'检测到可用的 ZeroTier 服务，无需重复安装。'});
    return;
  }catch(_){}
  downloadAbort=new AbortController();
  const timeout=setTimeout(()=>downloadAbort && downloadAbort.abort(),5*60*1000);
  let downloaded;
  try {
    downloaded=await downloadInstaller({platform:process.platform,directory:path.join(app.getPath('userData'),'installers'),
      fetch:(...args)=>net.fetch(...args),signal:downloadAbort.signal,onProgress:installProgress});
    await verifySignature(downloaded.path);
    if(downloadAbort.signal.aborted)throw new Error('下载已取消。');
    // 验证后只打开官方系统安装程序，不静默提权。
    const error=await shell.openPath(downloaded.path);
    if(error)throw new Error('无法打开系统安装程序：'+error);
    token=undefined;
    installProgress({phase:'waiting',message:'系统安装程序已打开。请完成安装和网络授权；安装结束后将自动重新检测。若未连接，请点击“授权连接”。'});
  } catch(error) {
    if(downloaded)await fs.rm(downloaded.directory,{recursive:true,force:true}).catch(()=>{});
    installProgress({phase:'error',message:error.message});
    throw error;
  } finally {clearTimeout(timeout);downloadAbort=undefined;}
}
const tokenPaths = process.platform === 'win32' ? [
  path.join(process.env.LOCALAPPDATA || os.homedir(),'ZeroTier','One','authtoken.secret'),
  path.join(process.env.ProgramData || 'C:\\ProgramData','ZeroTier','One','authtoken.secret')
] : [path.join(os.homedir(),'Library/Application Support/ZeroTier/One/authtoken.secret'),
  '/Library/Application Support/ZeroTier/One/authtoken.secret'];
async function loadToken() {
  if (token) return token;
  for (const file of tokenPaths) {
    try { const value = (await fs.readFile(file,'utf8')).trim(); if (value) return (token=value); } catch (_) {}
  }
  throw new Error('需要本机服务授权。点击“授权连接”；Windows 可先打开 ZeroTier One 托盘程序后重试。');
}
async function atomicSave(value) {
  const file = path.join(app.getPath('userData'),'room.json');
  await fs.writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});
  await fs.rename(file+'.tmp',file);
}
function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效请求。');
}
function handle(name, fn, mutation = false) {
  ipcMain.handle(name,async(event,...args)=>{
    trusted(event);
    if (mutation && busy) return {ok:false,error:'上一项操作尚未完成，请稍候。'};
    if (mutation) busy=true;
    try { return {ok:true,data:await fn(...args)}; }
    catch(error) { return {ok:false,error:error.message}; }
    finally { if(mutation) busy=false; }
  });
}
async function authorize() {
  token = undefined;
  try { await loadToken(); await service.api('GET','/status'); return; } catch (_) { token=undefined; }
  if (process.platform !== 'darwin') throw new Error('请先运行 ZeroTier One 桌面程序后重试；也可在下方输入本机 API Token。不要输入 Central 云端令牌。');
  // 固定命令，无用户输入；只在用户点击时触发系统授权。令牌仅保留在主进程内存。
  const script = 'do shell script "/bin/cat \'/Library/Application Support/ZeroTier/One/authtoken.secret\'" with administrator privileges';
  token = await new Promise((resolve,reject)=>execFile('/usr/bin/osascript',['-e',script],{timeout:120000},(error,stdout)=>{
    if(error) reject(new Error('系统授权未完成。请确认已安装并启动 ZeroTier One。'));
    else resolve(stdout.trim());
  }));
  await service.api('GET','/status');
}
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async()=>{
  if(process.argv.includes('--download-test')) {
    let downloaded;
    try {
      downloaded=await downloadInstaller({platform:process.platform,directory:path.join(app.getPath('userData'),'installers'),fetch:(...args)=>net.fetch(...args),signal:AbortSignal.timeout(120000)});
      await verifySignature(downloaded.path);
      await fs.rm(downloaded.directory,{recursive:true,force:true});downloaded=null;
      console.log('PASS: 官方安装包实际下载、SHA-256 和系统发布者签名验证；未执行安装');
      app.quit();
    }catch(error){console.error(error.message);app.exitCode=1;app.exit(1);}
    finally{if(downloaded)await fs.rm(downloaded.directory,{recursive:true,force:true});}
    return;
  }
  let saved={};
  try { saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'room.json'),'utf8')); } catch (_) {}
  if (saved.room && !/^[0-9a-f]{16}$/.test(saved.room.id)) saved={};
  service=new Network(async(method,url,body)=>request(await loadToken(),method,url,body,await servicePort()),atomicSave,saved);
  handle('snapshot',async()=>{
    const state=await service.snapshot();
    if(installState.phase==='waiting')installProgress({phase:'complete',message:'已检测到 ZeroTier 服务，可以创建或加入房间。'});
    return state;
  });
  handle('authorize',authorize,true);
  handle('token',async value=>{
    if(typeof value !== 'string' || !/^[a-zA-Z0-9]{16,128}$/.test(value.trim())) throw new Error('本机 API Token 格式无效。');
    token=value.trim();
    try { await service.api('GET','/status'); } catch(error) { token=undefined; throw error; }
  },true);
  handle('create',name=>service.create(name),true);
  handle('join',code=>service.join(code),true);
  handle('member',(id,allow)=>service.authorize(id,allow),true);
  handle('leave',async()=>{
    if(!service.room) return;
    const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确认退出'],defaultId:0,cancelId:0,
      message:service.room.host?'关闭房间并退出？':'退出虚拟局域网？',
      detail:service.room.host?'这会删除本应用创建的网络，所有朋友将失去该网络的联机权限。':'文明6连接可能中断。'});
    if(answer.response===1) await service.leave();
  },true);
  handle('copy',()=>{if(service.room) clipboard.writeText('CIV6-'+service.room.id);});
  handle('download',installZeroTier,true);
  handle('installStatus',()=>installState);
  handle('cancelDownload',()=>{if(downloadAbort)downloadAbort.abort();});
  handle('retryInstallCheck',async()=>{
    if(installState.phase==='waiting')installProgress({phase:'idle'});
    token=undefined;
    return service.snapshot();
  });
  handle('steam',()=>shell.openExternal('steam://rungameid/289070'));
  handle('diagnostics',async()=>{
    const state=await service.snapshot();
    const result=await dialog.showSaveDialog(win,{defaultPath:'civ6-lan-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});
    if(!result.canceled) await fs.writeFile(result.filePath,JSON.stringify({time:new Date().toISOString(),platform:process.platform,...state},null,2));
  });
  win=new BrowserWindow({width:1120,height:820,minWidth:800,minHeight:660,backgroundColor:'#0d1624',title:'Civ6 LAN',
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  await win.loadFile(path.join(__dirname,'ui/index.html'));
  if (process.argv.includes('--smoke-test')) {
    // 只读界面检查，不加入或创建网络。
    setTimeout(async()=>{
      try {
        const info=await win.webContents.executeJavaScript('JSON.stringify({title:document.title,service:document.getElementById("service").textContent,cards:document.querySelectorAll("#lobby article").length,connectionActionsHidden:document.getElementById("connectionActions").hidden,bridge:typeof window.lan.cancelDownload})');
        console.log(info);
        const screenshot=await win.webContents.capturePage();
        await fs.mkdir(path.resolve('dist'),{recursive:true});
        await fs.writeFile(path.resolve('dist/smoke.png'),screenshot.toPNG());
        app.quit();
      } catch(error) {console.error(error.message);app.exit(1);}
    },1800);
  }
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
});
app.on('window-all-closed',()=>app.quit());
