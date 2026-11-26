const {app,BrowserWindow,ipcMain,dialog,shell,clipboard,net} = require('electron');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const {execFile} = require('child_process');
const {Network,request,inviteCode,parseInvite,applicationCode} = require('./network');
const {downloadInstaller,ZEROTIER_VERSION} = require('./installer');
const {servicePort,requestWithServiceToken} = require('./service-config');
const {restartService,startService} = require('./restart-service');
const {changeRelay,relayState} = require('./enhanced-connection');
const {installedVersion,replaceWindowsZeroTier} = require('./replace-zerotier');
const {MacBroadcast} = require('./macos-broadcast');
const {WindowsBroadcast} = require('./windows-broadcast');
const {RoomDiscovery} = require('./room-discovery');
const {RoomProfiles,nickname} = require('./room-profiles');
const {Startup,isConnected} = require('./startup');
const smokeTest=process.argv.includes('--smoke-test');
if(process.argv.some(arg=>['--smoke-test','--download-test'].includes(arg))) {
  const testData=path.join(os.tmpdir(),'civ6-lan-check-'+process.pid);
  require('fs').mkdirSync(testData,{recursive:true});app.setPath('userData',testData);
}
let win, token, service, busy = false;
let screen='startup';
let lastRoomSnapshot;
const broadcast = new RoomDiscovery(process.platform==='win32' ? new WindowsBroadcast() : new MacBroadcast());
const profiles = new RoomProfiles();
let installState={phase:'idle'}, downloadAbort;
let fallbackVersionCheck, autoAttemptVersion;
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
async function installZeroTier(detectedVersion) {
  if(installState.phase==='waiting')throw new Error('系统安装程序已打开，请完成或关闭后点击“安装后重试”。');
  let version=detectedVersion;
  let connected=true;
  if (detectedVersion===undefined) {
    try {
      version=(await service.api('GET','/status')).version;
    } catch (_) {
      connected=false;
      version=await installedVersion();
    }
  }
  if (version===ZEROTIER_VERSION) {
    installProgress({phase:'complete',message:connected
      ? 'ZeroTier 已就绪。'
      : `已安装 ZeroTier ${ZEROTIER_VERSION}，请点击“授权连接”连接本机服务。`});
    return;
  }
  const replaceVersion=Boolean(version);
  downloadAbort=new AbortController();
  const timeout=setTimeout(()=>downloadAbort && downloadAbort.abort(),5*60*1000);
  let downloaded;
  try {
    downloaded=await downloadInstaller({platform:process.platform,directory:path.join(app.getPath('userData'),'installers'),
      fetch:(...args)=>net.fetch(...args),signal:downloadAbort.signal,onProgress:installProgress});
    await verifySignature(downloaded.path);
    if(downloadAbort.signal.aborted)throw new Error('下载已取消。');
    let reboot=false;
    if (replaceVersion) await resetDiscovery();
    if (replaceVersion && process.platform==='win32') {
      installProgress({phase:'replacing',message:`请完成 Windows 管理员授权。授权后会卸载 ZeroTier ${version}，然后安装 ${downloaded.version}。`});
      reboot=await replaceWindowsZeroTier(downloaded.path,version);
      await fs.rm(downloaded.directory,{recursive:true,force:true}).catch(()=>{});
    } else {
      const error=await shell.openPath(downloaded.path);
      if(error)throw new Error('无法打开系统安装程序：'+error);
    }
    token=undefined;
    fallbackVersionCheck=undefined;
    installProgress({phase:'waiting',expectedVersion:downloaded.version,reboot,
      message:reboot ? 'Windows 已安装 ZeroTier，请先重启电脑，再打开 App。'
        : '请按系统提示完成安装。安装完成后，App 会自动检测并连接。'});
  } catch(error) {
    if(downloaded)await fs.rm(downloaded.directory,{recursive:true,force:true}).catch(()=>{});
    installProgress({phase:'error',message:error.message});
    throw error;
  } finally {clearTimeout(timeout);downloadAbort=undefined;}
}
function replaceIfNeeded(version) {
  if (process.argv.includes('--smoke-test') || !version || version===ZEROTIER_VERSION
    || busy || autoAttemptVersion===version || installState.phase!=='idle') return;
  autoAttemptVersion=version;
  busy=true;
  void installZeroTier()
    .catch(error=>installProgress({phase:'error',message:error.message}))
    .finally(()=>{busy=false;});
}
async function requestLocalService(method, url, body) {
  const port = await servicePort();
  const result = await requestWithServiceToken({
    cachedToken: token,
    send: value => request(value, method, url, body, port)
  });
  token = result.token;
  return result.data;
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
    if (screen==='startup' && !setupMethods.has(name)) return {ok:false,error:'请先完成启动设置。'};
    if (mutation && busy) return {ok:false,error:'上一项操作尚未完成，请稍候。'};
    if (mutation) busy=true;
    try { return {ok:true,data:await fn(...args)}; }
    catch(error) { return {ok:false,error:error.message}; }
    finally { if(mutation) busy=false; }
  });
}
const setupMethods = new Set(['startupCheck','confirmStartupNickname','nickname','token','cancelDownload','installStatus','restartService']);
async function resetDiscovery() {
  await broadcast.disable();
  broadcast.useRoom(undefined);
}

async function setRelay(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('连接模式无效。');
  const status = await service.connectionStatus();
  if (relayState(status).forced !== enabled) {
    await resetDiscovery();
    await changeRelay(enabled,()=>service.api('GET','/status'));
  }
  await service.setRoomRelay(enabled);
}

const relayImpact = '切换时会重启 ZeroTier，短暂中断本机的所有 ZeroTier 网络。连接模式会保留，直到在 App 里再次切换。';
async function authorize() {
  try {
    await service.api('GET','/status');
    return;
  } catch (error) {
    if (!['ZT_AUTH','ZT_TOKEN_MISSING'].includes(error.code)) throw error;
    if (process.platform === 'win32') {
      throw new Error(`${error.message} 请先从开始菜单打开 ZeroTier One 后重试。仍失败时，可由本机管理员把 ZeroTier 的 authtoken.secret 文件内容填到下方。`);
    }
    if (process.platform !== 'darwin') throw error;
  }
  // 固定命令，无用户输入；只在用户点击时触发系统授权。令牌仅保留在主进程内存。
  const script = 'do shell script "/bin/cat \'/Library/Application Support/ZeroTier/One/authtoken.secret\'" with administrator privileges';
  token = await new Promise((resolve,reject)=>execFile('/usr/bin/osascript',['-e',script],{timeout:120000},(error,stdout)=>{
    if(error) reject(new Error('系统授权未完成。请确认已安装并启动 ZeroTier One。'));
    else resolve(stdout.trim());
  }));
  await service.api('GET','/status');
}
async function authorizeStartup() {
  if (process.platform==='win32') {
    const programs = path.join(process.env.ProgramData || 'C:\\ProgramData','Microsoft','Windows','Start Menu','Programs');
    const error = await shell.openPath(path.join(programs,'ZeroTier.lnk'));
    if (error) throw new Error('请从开始菜单打开 ZeroTier 后重试，或输入本机 API Token。');
    return;
  }
  await authorize();
}

async function openMain() {
  screen='main';
  installProgress({phase:'idle'});
  await win.loadFile(path.join(__dirname,'ui/index.html'));
  win.setResizable(true);
  win.setMaximizable(true);
  win.setMinimumSize(800,660);
  win.setSize(1120,820);
  win.center();
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
  if (saved?.room) {
    try {
      if (!/^[0-9a-f]{16}$/.test(saved.room.id)) throw new Error('invalid room');
      parseInvite(inviteCode(saved.room));
    } catch (_) { saved.room=null; }
  }
  service=new Network(requestLocalService,atomicSave,saved || {});
  const readStartupStatus=smokeTest
    ? async()=>({version:ZEROTIER_VERSION,online:true})
    : ()=>service.api('GET','/status');
  const startup=new Startup({
    readStatus:readStartupStatus,installedVersion,
    installation:()=>installState,
    install:installZeroTier,
    resetInstallation:()=>installProgress({phase:'idle'}),
    start:startService,
    authorize:authorizeStartup,
    onState:value=>{
      if(win && !win.isDestroyed() && screen==='startup') win.webContents.send('startup-progress',value);
    }
  });
  handle('startupCheck',retry=>{
    if(screen!=='startup') throw new Error('启动设置已完成。');
    if(busy) return startup.state;
    return startup.check(retry===true);
  });
  handle('confirmStartupNickname',async value=>{
    if(screen!=='startup' || startup.state.phase!=='nickname') throw new Error('请等待 ZeroTier 连接。');
    const name=nickname(value);
    if(!name) throw new Error('请输入昵称。');
    if(!await readStartupStatus().then(isConnected,()=>false)) {
      startup.show('checking');
      throw new Error('ZeroTier 连接已断开，正在重新检查。');
    }
    await service.setNickname(name);
    // Let the page receive its successful response before replacing it.
    setImmediate(()=>void openMain().catch(error=>{
      console.error(error.message);
      app.exit(1);
    }));
  },true);
  handle('snapshot',async()=>{
    let state;
    try {
      state=await service.snapshot({includePeers:false});
    } catch (error) {
      if (!process.argv.includes('--smoke-test')) {
        if (!fallbackVersionCheck) fallbackVersionCheck=installedVersion();
        replaceIfNeeded(await fallbackVersionCheck);
      }
      throw error;
    }
    replaceIfNeeded(state.version);
    if (state.room!==service.room) return {...state,discovery:{available:false,active:false}};
    lastRoomSnapshot=state;
    if(installState.phase==='waiting' && (!installState.expectedVersion || installState.expectedVersion===state.version)) {
      installProgress({phase:'complete',message:'已检测到 ZeroTier 服务，可以创建或加入房间。'});
    }
    const [members, discovery]=await Promise.all([profiles.sync(state,service.nickname),broadcast.update(state.room,state.network,!busy)]);
    return {...state, members, discovery, invite:state.room ? inviteCode(state.room,state.network,service.nickname) : null};
  });
  handle('nickname',()=>service.nickname);
  handle('saveNickname',value=>service.setNickname(value),true);
  handle('roomLinks',async()=>lastRoomSnapshot ? service.roomLinks(lastRoomSnapshot) : null);
  handle('authorize',authorize,true);
  handle('enableDiscovery',async()=>{
    const state=await service.snapshot({includePeers:false});
    if (!state.room) throw new Error('请先创建或加入房间。');
    return broadcast.enable(state.network,state.room.id);
  },true);
  handle('disableDiscovery',()=>broadcast.disable(),true);
  handle('restartService',async()=>{
    await resetDiscovery();
    const status = await restartService(()=>service.api('GET','/status'));
    return {online:status.online || relayState(status).active};
  },true);
  handle('setRelay',async enabled=>{
    if (typeof enabled !== 'boolean') throw new Error('连接模式无效。');
    const title = enabled ? '开启增强连接' : '恢复标准连接';
    const result = await dialog.showMessageBox(win,{
      type:'question',buttons:['取消',title],defaultId:0,cancelId:0,
      message:title,detail:relayImpact
    });
    if (result.response===1) await setRelay(enabled);
  },true);
  handle('token',async value=>{
    if(typeof value !== 'string' || !/^[a-zA-Z0-9]{16,128}$/.test(value.trim())) throw new Error('本机 API Token 格式无效。');
    const candidate = value.trim();
    await request(candidate, 'GET', '/status', undefined, await servicePort());
    token = candidate;
  },true);
  handle('create',name=>service.create(name),true);
  handle('join',code=>service.join(code,async()=>{
    const result = await dialog.showMessageBox(win,{
      type:'question',buttons:['取消加入','开启增强连接并加入','用标准连接加入'],defaultId:1,cancelId:0,
      message:'房主推荐使用增强连接',detail:relayImpact
    });
    if (result.response===0) throw new Error('已取消加入房间。');
    if (result.response===1) await setRelay(true);
  }),true);
  handle('member',(id,allow)=>service.authorize(id,allow),true);
  handle('leave',async()=>{
    if(!service.room) return;
    if(!service.room.existingNetwork) {
      const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确认退出'],defaultId:0,cancelId:0,
        message:service.room.host?'关闭房间并退出？':'退出虚拟局域网？',
        detail:service.room.host?'这会删除本应用创建的网络，所有朋友将失去该网络的联机权限。':'文明6连接可能中断。'});
      if(answer.response!==1) return;
    }
    await broadcast.disable();
    await service.leave();
    profiles.close();
  },true);
  handle('copy',async()=>{
    if(!service.room) return;
    const state=await service.snapshot({includePeers:false});
    clipboard.writeText(inviteCode(state.room,state.network,service.nickname));
  },true);
  handle('updateHostInfo',()=>service.updateHostInfo(clipboard.readText()),true);
  handle('copyApplication',async()=>{
    if (!service.room || service.room.host) throw new Error('请先申请加入房间。');
    const status=await service.api('GET','/status');
    clipboard.writeText(applicationCode(service.room.id,status.address,service.nickname));
  },true);
  handle('pasteApplication',()=>service.acceptApplication(clipboard.readText()),true);
  handle('download',()=>installZeroTier(),true);
  handle('installStatus',()=>installState);
  handle('cancelDownload',()=>{if(downloadAbort)downloadAbort.abort();});
  handle('retryInstallCheck',async()=>{
    if(installState.phase==='waiting')installProgress({phase:'idle'});
    token=undefined;
    fallbackVersionCheck=undefined;
    return service.snapshot();
  });
  handle('steam',()=>shell.openExternal('steam://rungameid/289070'));
  handle('diagnostics',async()=>{
    const state=await service.snapshot();
    const result=await dialog.showSaveDialog(win,{defaultPath:'civ6-lan-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});
    if(!result.canceled) await fs.writeFile(result.filePath,JSON.stringify({time:new Date().toISOString(),platform:process.platform,...state},null,2));
  });
  win=new BrowserWindow({width:480,height:460,resizable:false,maximizable:false,backgroundColor:'#0d1624',title:'Civ6 LAN',
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  await win.loadFile(path.join(__dirname,'ui/startup.html'));
  if (smokeTest) {
    // 只读界面检查，不加入或创建网络。
    setTimeout(async()=>{
      try {
        const nicknameShown=await win.webContents.executeJavaScript('!document.getElementById("nicknamePage").hidden && !document.getElementById("lobby")');
        if(!nicknameShown)throw new Error('启动窗口未显示昵称确认页。');
        const mainLoaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
        await win.webContents.executeJavaScript('document.getElementById("startupNickname").value="冒烟测试"; document.getElementById("confirmNickname").click()');
        await Promise.race([mainLoaded,new Promise((_,reject)=>setTimeout(()=>reject(new Error('主页面未打开。')),5000))]);
        const info=await win.webContents.executeJavaScript('JSON.stringify({title:document.title,service:document.getElementById("service").textContent,cards:document.querySelectorAll("#lobby article").length,connectionActionsHidden:document.getElementById("connectionActions").hidden,versionNoticeVisible:!document.getElementById("versionNotice").hidden,createDisabled:document.getElementById("create").disabled})');
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
app.on('before-quit',()=>{
  downloadAbort?.abort();
  profiles.close();
  void broadcast.disable().catch(()=>{});
});
