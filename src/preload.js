const {contextBridge,ipcRenderer} = require('electron');
const methods=['snapshot','authorize','token','create','join','member','leave','copy','download','steam','diagnostics','installStatus','cancelDownload','retryInstallCheck'];
contextBridge.exposeInMainWorld('lan',{
  ...Object.fromEntries(methods.map(name=>[name,(...args)=>ipcRenderer.invoke(name,...args)])),
  onInstallProgress:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('install-progress',listener);return ()=>ipcRenderer.removeListener('install-progress',listener);}
});
