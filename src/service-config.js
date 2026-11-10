const fs = require('fs').promises;
const path = require('path');

function serviceDirectory(platform=process.platform) {
  if(platform==='darwin')return '/Library/Application Support/ZeroTier/One';
  if(platform==='win32')return path.join(process.env.ProgramData || 'C:\\ProgramData','ZeroTier','One');
  return '/var/lib/zerotier-one';
}
function parsePort(value) {
  const text=String(value).trim(), port=Number(text);
  if(!/^\d+$/.test(text) || !Number.isInteger(port) || port<1 || port>65535)throw new Error('ZeroTier 本机服务端口文件无效，请重新启动 ZeroTier 后重试。');
  return port;
}
async function servicePort(directory=serviceDirectory(),read=fs.readFile) {
  try {return parsePort(await read(path.join(directory,'zerotier-one.port'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return 9993;throw error;}
}
module.exports={serviceDirectory,servicePort,parsePort};
