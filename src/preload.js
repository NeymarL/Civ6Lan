const {contextBridge,ipcRenderer} = require('electron');
const methods=['startupCheck','confirmStartupNickname','snapshot','roomLinks','nickname','saveNickname','authorize','restartService','setRelay','enableDiscovery','disableDiscovery','token','create','join','member','leave','copy','copyApplication','pasteApplication','updateHostInfo','download','steam','diagnostics','installStatus','cancelDownload','retryInstallCheck'];
function subscribe(name,callback) {
  const listener=(_event,value)=>callback(value);
  ipcRenderer.on(name,listener);
  return ()=>ipcRenderer.removeListener(name,listener);
}
contextBridge.exposeInMainWorld('lan',{
  ...Object.fromEntries(methods.map(name=>[name,(...args)=>ipcRenderer.invoke(name,...args)])),
  onInstallProgress:callback=>subscribe('install-progress',callback),
  onStartupProgress:callback=>subscribe('startup-progress',callback)
});
