const fs = require('fs').promises;
const path = require('path');
const os = require('os');

function needsMacHostingRepair(version, platform=process.platform) {
  return platform==='darwin' && /^1\.16\.[0-2]$/.test(version || '');
}

function serviceDirectory(platform=process.platform, env=process.env) {
  if(platform==='darwin')return '/Library/Application Support/ZeroTier/One';
  if(platform==='win32')return path.win32.join(env.ProgramData || 'C:\\ProgramData','ZeroTier','One');
  return '/var/lib/zerotier-one';
}

function serviceTokenPaths(platform=process.platform, env=process.env, home=os.homedir()) {
  const file = 'authtoken.secret';
  const directory = serviceDirectory(platform, env);
  if (platform === 'win32') {
    const userDirectory = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'ZeroTier');
    return [
      path.win32.join(userDirectory, file),
      path.win32.join(userDirectory, 'One', file),
      path.win32.join(directory, file)
    ];
  }
  if (platform === 'darwin') {
    const userDirectory = path.join(home, 'Library', 'Application Support', 'ZeroTier');
    return [path.join(userDirectory, 'One', file), path.join(userDirectory, file), path.join(directory, file)];
  }
  return [path.join(directory, file)];
}

async function requestWithServiceToken({cachedToken, send, paths=serviceTokenPaths(), read=fs.readFile}) {
  const tried = new Set();
  let authError;
  async function tryToken(value) {
    if (!value || tried.has(value)) return;
    tried.add(value);
    try {
      return {token:value, data:await send(value)};
    } catch (error) {
      if (error.code !== 'ZT_AUTH') throw error;
      authError = error;
    }
  }
  const cached = await tryToken(cachedToken);
  if (cached) return cached;
  for (const file of paths) {
    let value;
    try {
      value = (await read(file, 'utf8')).trim();
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      continue;
    }
    const result = await tryToken(value);
    if (result) return result;
  }
  if (authError) throw authError;
  throw Object.assign(new Error('未找到可读取的 ZeroTier 本机令牌。请完成系统安装，再点击“授权连接”。'), {code:'ZT_TOKEN_MISSING'});
}
function parsePort(value) {
  const text=String(value).trim(), port=Number(text);
  if(!/^\d+$/.test(text) || !Number.isInteger(port) || port<1 || port>65535)throw new Error('ZeroTier 本机服务端口文件无效，请重新启动 ZeroTier 后重试。');
  return port;
}
async function servicePort(directory=serviceDirectory(),read=fs.readFile,platform=process.platform) {
  const join = platform === 'win32' ? path.win32.join : path.join;
  try {return parsePort(await read(join(directory,'zerotier-one.port'),'utf8'));}
  catch(error){
    if(error.code==='ENOENT' || (platform==='win32' && ['EACCES','EPERM'].includes(error.code)))return 9993;
    throw error;
  }
}
module.exports={serviceDirectory,servicePort,serviceTokenPaths,requestWithServiceToken,parsePort,needsMacHostingRepair};
