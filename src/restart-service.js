const {execFile} = require('child_process');
const {win32} = require('path');
const {promisify} = require('util');
const {setTimeout: delay} = require('timers/promises');

const exec = promisify(execFile);

function elevatedWindowsCommand(script, env = process.env) {
  const file = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const elevate = "try { $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') " +
    "-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','" + encoded + "' " +
    "-Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $process.ExitCode } " +
    "catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }";
  return {file, args: ['-NoProfile', '-NonInteractive', '-Command', elevate]};
}

function restartCommand(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return {
      file: '/usr/bin/osascript',
      args: ['-e', 'do shell script "/bin/launchctl kickstart -k system/com.zerotier.one" with administrator privileges']
    };
  }
  if (platform === 'win32') {
    return elevatedWindowsCommand("try { Restart-Service -Name ZeroTierOneService -ErrorAction Stop; exit 0 } catch { exit 1 }", env);
  }
  throw new Error('当前系统不支持在 App 内重启 ZeroTier。');
}

async function startService(platform = process.platform) {
  let command;
  if (platform==='darwin') {
    const job = 'system/com.zerotier.one';
    const print = await exec('/bin/launchctl',['print',job],{timeout:5000}).catch(()=>null);
    if (/^\s*pid = \d+/m.test(print?.stdout || '')) return;
    const launch = `/bin/launchctl print ${job} >/dev/null 2>&1 || /bin/launchctl bootstrap system /Library/LaunchDaemons/com.zerotier.one.plist; /bin/launchctl kickstart ${job}`;
    command = {file:'/usr/bin/osascript',args:['-e',`do shell script "${launch}" with administrator privileges`]};
  } else if (platform==='win32') {
    command = elevatedWindowsCommand("try { Start-Service -Name ZeroTierOneService -ErrorAction Stop; exit 0 } catch { exit 1 }");
    const {stdout} = await exec(command.file, ['-NoProfile','-NonInteractive','-Command',
      '(Get-Service -Name ZeroTierOneService -ErrorAction Stop).Status.ToString()'], {timeout:5000,windowsHide:true}).catch(()=>({stdout:''}));
    if (['Running','StartPending'].includes(stdout.trim())) return;
  } else {
    throw new Error('当前系统不支持启动 ZeroTier。');
  }
  try {
    await exec(command.file,command.args,{timeout:120000,windowsHide:true});
  } catch (error) {
    if (error.code===1223 || /\(-128\)/.test(error.stderr || '')) throw new Error('已取消启动 ZeroTier，请重试并完成管理员授权。');
    throw new Error('系统未能启动 ZeroTier。请确认系统安装已完成，再重试。');
  }
}

async function restartService(readStatus, {
  command = restartCommand(), change, ready = status => status.online || status.tcpFallbackActive
} = {}) {
  const {file, args} = command;
  await new Promise((resolve, reject) => {
    execFile(file, args, {timeout:120000, windowsHide:true}, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if (error.code === 1223 || /\(-128\)/.test(stderr)) return reject(new Error(`已取消 ${change || 'ZeroTier 重启'}。`));
      if (error.killed) return reject(new Error('等待系统授权超时，请确认系统授权窗口后重试。'));
      if (change && (error.code === 2 || /\(2\)\s*$/.test(stderr))) return reject(new Error('ZeroTier 的中继已在本机配置中禁用。请先确认 local.conf 的 allowTcpFallbackRelay 设置。'));
      reject(new Error(change ? `系统未能${change}，请检查 ZeroTier 的 local.conf 和管理员权限。`
        : '系统未能重启 ZeroTier，请确认 ZeroTier One 已安装且当前账户可以管理系统服务。'));
    });
  });

  const deadline = Date.now() + 12000;
  let status, lastError;
  do {
    await delay(1000);
    try {
      status = await readStatus();
      if (ready(status)) return status;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  } while (Date.now() < deadline);
  if (lastError) throw new Error('已发出重启指令，但暂时无法读取服务状态。' + lastError.message);
  return status;
}

module.exports = {restartCommand, restartService, startService, elevatedWindowsCommand};
