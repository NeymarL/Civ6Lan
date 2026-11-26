const {execFile} = require('node:child_process');
const {isIPv4} = require('node:net');
const path = require('node:path');

const SAMPLES = 2;

function echoMeasurement(output, target) {
  const times = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/\bttl\s*=/i.test(line) || !line.includes(target)) continue;
    const match = /([=<])\s*(\d+(?:[.,]\d+)?)\s*ms\b/i.exec(line);
    if (!match) continue;
    const value = Number(match[2].replace(',','.'));
    times.push(match[1]==='<' ? value/2 : value);
  }
  const latency = times.length ? times.reduce((sum,value)=>sum+value,0)/times.length : null;
  return {sent:SAMPLES,replies:times.length,latency};
}

function probeRoomPeer(source, target, platform = process.platform) {
  if (!isIPv4(source) || !isIPv4(target) || source===target) return null;
  let executable, args;
  if (platform==='darwin') {
    executable='/sbin/ping';
    args=['-n','-c',String(SAMPLES),'-W','1250','-S',source,target];
  } else if (platform==='win32') {
    executable=path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // Windows ping cannot bind an IPv4 source. Confirm the chosen interface before probing.
    const script=`$source=Find-NetRoute -RemoteIPAddress '${target}' -ErrorAction Stop | Where-Object IPAddress -eq '${source}'; if (!$source) {exit 10}; & (Join-Path $env:SystemRoot 'System32\\ping.exe') -4 -n ${SAMPLES} -w 1250 '${target}'; exit $LASTEXITCODE`;
    args=['-NoProfile','-NonInteractive','-Command',script];
  } else {
    return null;
  }
  return new Promise(resolve=>{
    execFile(executable,args,{windowsHide:true,timeout:5000,maxBuffer:16384},(error,stdout)=>{
      if (error && (typeof error.code==='string' || error.code===10 || (platform==='win32' && !stdout.trim()))) {
        resolve(null);
        return;
      }
      resolve(echoMeasurement(stdout,target));
    });
  });
}

module.exports = {probeRoomPeer,echoMeasurement};
