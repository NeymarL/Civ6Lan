const {execFile} = require('child_process');
const {win32} = require('path');
const {promisify} = require('util');
const {installers, ZEROTIER_VERSION} = require('./installer');
const {elevatedWindowsCommand} = require('./restart-service');

const exec = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+(?:\.0)?$/;
const normalizeVersion = value => versionPattern.test(value) ? value.split('.').slice(0, 3).join('.') : null;

const windowsProducts = String.raw`
function Get-ZeroTierProducts {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($key in $keys) {
    Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.PSChildName -match '^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$') {
        $record = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        if ($record.WindowsInstaller -eq 1 -and
            $record.DisplayName -match '^ZeroTier One(?: \d+\.\d+\.\d+)?$' -and
            $record.Publisher -match '^ZeroTier,? Inc\.?$') {
          [PSCustomObject]@{Code=$_.PSChildName;Version=$record.DisplayVersion}
        }
      }
    }
  }
}
`;

async function installedVersion(platform = process.platform) {
  try {
    if (platform==='darwin') {
      const {stdout}=await exec('/usr/sbin/pkgutil',['--pkg-info','com.zerotier.pkg.ZeroTierOne'],{timeout:5000});
      return normalizeVersion(/^version:\s*(\S+)$/m.exec(stdout)?.[1]);
    }
    if (platform==='win32') {
      const file = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const {stdout}=await exec(file, ['-NoProfile','-NonInteractive','-Command',
        windowsProducts+'; Get-ZeroTierProducts | Select-Object -ExpandProperty Version -Unique'], {timeout:5000,windowsHide:true});
      return normalizeVersion(stdout.trim());
    }
  } catch (_) {
    // A receipt may be absent or inaccessible. The service API can still detect the version.
  }
  return null;
}

function windowsReplacementCommand(file, previousVersion) {
  if (!normalizeVersion(previousVersion) || normalizeVersion(previousVersion)===ZEROTIER_VERSION) {
    throw new Error('无法确认需要替换的 ZeroTier 版本。');
  }
  const source = Buffer.from(file, 'utf8').toString('base64');
  const script = windowsProducts+`
$ErrorActionPreference = 'Stop'
$stage = $null
try {
  $oldVersion = '${normalizeVersion(previousVersion)}'
  $old = @(Get-ZeroTierProducts | Where-Object { $_.Version -in @($oldVersion, ($oldVersion+'.0')) } | Sort-Object Code -Unique)
  if ($old.Count -ne 1) { exit 3 }
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
  $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  $stage = Join-Path $programs ('Civ6-LAN-install-' + [Guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($stage)
  $verified = Join-Path $stage 'ZeroTier-One.msi'
  [IO.File]::Copy($source, $verified)
  if ((Get-FileHash -LiteralPath $verified).Hash -ne '${installers.win32.sha256}') { exit 4 }
  $signature = Get-AuthenticodeSignature -LiteralPath $verified
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'ZeroTier') { exit 4 }
  $msiexec = Join-Path ([Environment]::SystemDirectory) 'msiexec.exe'
  $remove = Start-Process -FilePath $msiexec -ArgumentList '/x',$old[0].Code,'/qn','/norestart' -Wait -PassThru
  if ($remove.ExitCode -notin @(0,3010)) { exit 5 }
  $install = Start-Process -FilePath $msiexec -ArgumentList '/i',('"'+$verified+'"'),'/passive','/norestart' -Wait -PassThru
  if ($install.ExitCode -eq 3010 -or ($remove.ExitCode -eq 3010 -and $install.ExitCode -eq 0)) { exit 6 }
  if ($install.ExitCode -ne 0) { exit 7 }
} catch { exit 1 }
finally { if ($stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue } }
exit 0`;
  return elevatedWindowsCommand(script);
}

async function replaceWindowsZeroTier(file, previousVersion) {
  const command = windowsReplacementCommand(file, previousVersion);
  try {
    await exec(command.file,command.args,{windowsHide:true});
    return false;
  } catch (error) {
    if (error.code===6) return true;
    const messages = {
      1223:'已取消版本替换。',
      3:'无法从 Windows 安装记录确认旧版 ZeroTier。请在系统设置确认后卸载旧版，再安装 1.12.2。',
      4:'安装包未通过管理员进程的校验，版本替换已停止。',
      5:'Windows 未能卸载旧版 ZeroTier。请关闭 ZeroTier 界面后重试。',
      7:'已卸载旧版，但 Windows 未能安装 1.12.2。可从 App 重新点击“自动下载安装”。'
    };
    throw new Error(messages[error.code] || 'Windows 未完成 ZeroTier 版本替换，请重试。');
  }
}

module.exports = {installedVersion,replaceWindowsZeroTier,windowsReplacementCommand};
