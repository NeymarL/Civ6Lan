const {serviceDirectory} = require('./service-config');
const {elevatedWindowsCommand, restartService} = require('./restart-service');

const ADMIN_PERL = `on run argv
  set cmd to "/usr/bin/perl -e"
  repeat with value in argv
    set cmd to cmd & " " & quoted form of (contents of value)
  end repeat
  do shell script cmd with administrator privileges
end run`;

function relayState(status) {
  return {
    forced:status.config?.settings?.forceTcpRelay === true,
    active:status.tcpFallbackActive === true
  };
}

// Only the fixed ZeroTier service directory and restart command are used.
// Room data and credentials never enter the privileged scripts.
const macConfigScript = String.raw`
use strict;
use warnings;
use File::Temp qw(tempfile);
use JSON::PP qw(decode_json encode_json);
my ($dir, $enabled) = @ARGV;
my @dirStat = lstat($dir);
die "Unsafe ZeroTier directory" unless -d _ && $dirStat[4] == 0 && !($dirStat[2] & 0022);
my $path = "$dir/local.conf";
my $before;
if (lstat($path)) {
  die "Unsafe ZeroTier configuration" unless -f _;
  open(my $input, '<:raw', $path) or die "Cannot read ZeroTier configuration";
  $before = do { local $/; <$input> } // '';
}
my $config = defined($before) ? decode_json($before) : {};
die "Invalid ZeroTier configuration" unless ref($config) eq 'HASH';
$config->{settings} = {} unless exists $config->{settings};
my $settings = $config->{settings};
die "Invalid ZeroTier settings" unless ref($settings) eq 'HASH';
if ($enabled && exists($settings->{allowTcpFallbackRelay}) &&
    !$settings->{allowTcpFallbackRelay}) { exit 2; }
exit 0 if !!$settings->{forceTcpRelay} == !!$enabled;
$settings->{forceTcpRelay} = $enabled ? JSON::PP::true : JSON::PP::false;
sub write_config {
  my ($content) = @_;
  my ($output, $temp) = tempfile('.civ6-relay-XXXXXX', DIR => $dir, UNLINK => 1);
  binmode($output, ':raw');
  print {$output} $content or die "Cannot write ZeroTier configuration";
  close($output) or die "Cannot close ZeroTier configuration";
  rename($temp, $path) or die "Cannot replace ZeroTier configuration";
}
write_config(encode_json($config));
sub restart { system('/bin/launchctl', 'kickstart', '-k', 'system/com.zerotier.one') == 0 }
unless (restart()) {
  if (defined($before)) { write_config($before); }
  else { unlink($path) or die "Cannot restore ZeroTier configuration"; }
  restart();
  exit 1;
}
`;

function windowsConfigScript(enabled) {
  return `
$ErrorActionPreference = 'Stop'
$enabled = ${enabled ? '$true' : '$false'}
try {
  $null = Get-Service -Name ZeroTierOneService
  $common = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  $parent = Join-Path $common 'ZeroTier'
  $directory = Join-Path $parent 'One'
  foreach ($item in @($parent, $directory)) {
    $info = Get-Item -LiteralPath $item -Force
    if (!$info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
  }
  $file = Join-Path $directory 'local.conf'
  $existed = Test-Path -LiteralPath $file
  $before = $null
  $config = [PSCustomObject]@{}
  if ($existed) {
    $info = Get-Item -LiteralPath $file -Force
    if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
    $before = [IO.File]::ReadAllBytes($file)
    $config = [IO.File]::ReadAllText($file) | ConvertFrom-Json
  }
  if ($config -isnot [PSCustomObject]) { exit 1 }
  if (!$config.PSObject.Properties['settings']) {
    $config | Add-Member -MemberType NoteProperty -Name settings -Value ([PSCustomObject]@{})
  }
  $settings = $config.settings
  if ($settings -isnot [PSCustomObject]) { exit 1 }
  if ($enabled -and $settings.PSObject.Properties['allowTcpFallbackRelay'] -and !$settings.allowTcpFallbackRelay) { exit 2 }
  if (($settings.forceTcpRelay -eq $true) -eq $enabled) { exit 0 }
  $settings | Add-Member -MemberType NoteProperty -Name forceTcpRelay -Value $enabled -Force
  function Write-Config([byte[]]$content) {
    $temp = Join-Path $directory ('.civ6-relay-' + [Guid]::NewGuid().ToString('N'))
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew)
    try {
      try { $stream.Write($content, 0, $content.Length) } finally { $stream.Dispose() }
      if ([IO.File]::Exists($file)) { [IO.File]::Replace($temp, $file, [NullString]::Value) }
      else { [IO.File]::Move($temp, $file) }
    } finally { [IO.File]::Delete($temp) }
  }
  Write-Config ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $config -Depth 100)))
  try {
    Restart-Service -Name ZeroTierOneService
  } catch {
    if ($existed) { Write-Config $before }
    else { [IO.File]::Delete($file) }
    Restart-Service -Name ZeroTierOneService -ErrorAction SilentlyContinue
    exit 1
  }
} catch { exit 1 }
exit 0`;
}

function relayCommand(enabled, platform = process.platform) {
  if (typeof enabled !== 'boolean') throw new Error('连接模式无效。');
  if (platform === 'darwin') {
    return {
      file:'/usr/bin/osascript',
      args:['-e', ADMIN_PERL, '--', macConfigScript, serviceDirectory('darwin'), enabled ? '1' : '0']
    };
  }
  if (platform === 'win32') return elevatedWindowsCommand(windowsConfigScript(enabled));
  throw new Error('当前系统不支持增强连接。');
}

async function changeRelay(enabled, readStatus) {
  const status = await restartService(readStatus, {
    command:relayCommand(enabled),
    change:enabled ? '开启增强连接' : '恢复标准连接',
    ready:status=>relayState(status).forced===enabled
  });
  const state = relayState(status);
  if (state.forced !== enabled) throw new Error('ZeroTier 尚未应用新的连接模式，请重试。');
  return state;
}

module.exports = {changeRelay, relayState, relayCommand};
