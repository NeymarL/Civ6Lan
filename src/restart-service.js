const {execFile} = require('child_process');
const {win32} = require('path');
const {setTimeout: delay} = require('timers/promises');

function restartCommand(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return {
      file: '/usr/bin/osascript',
      args: ['-e', 'do shell script "/bin/launchctl kickstart -k system/com.zerotier.one" with administrator privileges']
    };
  }
  if (platform === 'win32') {
    const file = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const restart = "try { Restart-Service -Name ZeroTierOneService -ErrorAction Stop; exit 0 } catch { exit 1 }";
    const encoded = Buffer.from(restart, 'utf16le').toString('base64');
    // Only the fixed Restart-Service command runs elevated. The App stays at the user's normal privilege level.
    const elevate = "try { $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') " +
      "-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','" + encoded + "' " +
      "-Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $process.ExitCode } " +
      "catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }";
    return {file, args: ['-NoProfile', '-NonInteractive', '-Command', elevate]};
  }
  throw new Error('当前系统不支持在 App 内重启 ZeroTier。');
}

async function restartService(readStatus) {
  const {file, args} = restartCommand();
  await new Promise((resolve, reject) => {
    execFile(file, args, {timeout:120000, windowsHide:true}, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if (error.code === 1223 || /\(-128\)/.test(stderr)) return reject(new Error('已取消 ZeroTier 重启。'));
      if (error.killed) return reject(new Error('等待系统授权超时，请确认系统安装或授权窗口后重试。'));
      reject(new Error('系统未能重启 ZeroTier，请确认 ZeroTier One 已安装且当前账户可以管理系统服务。'));
    });
  });

  const deadline = Date.now() + 12000;
  let status, lastError;
  do {
    await delay(1000);
    try {
      status = await readStatus();
      if (status.online) return status;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  } while (Date.now() < deadline);
  if (lastError) throw new Error('已发出重启指令，但暂时无法读取服务状态。' + lastError.message);
  return status;
}

module.exports = {restartCommand, restartService};
