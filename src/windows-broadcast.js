const {execFile} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function gameAddress(network) {
  if (network?.status !== 'OK') return null;
  const own = Object.values(os.networkInterfaces()).flat();
  return (network.assignedAddresses || []).map(value=>value.split('/')[0]).find(address=>
    net.isIPv4(address) && own.filter(item=>item?.address === address && !item.internal).length === 1);
}

class WindowsBroadcast {
  constructor() { this.session = null; }
  get active() { return Boolean(this.session?.control); }

  async update(room, network) {
    const address = gameAddress(network);
    if (this.session && (this.session.id !== room?.id || this.session.address !== address)) await this.disable();
    return {available:Boolean(address),active:this.active};
  }

  async enable(network, id, signal) {
    signal?.throwIfAborted();
    if (this.session) throw new Error('局域网广播正在运行。');
    const address = gameAddress(network);
    if (!address) throw new Error('房间的 ZeroTier IPv4 地址尚未就绪。');
    const source = await fs.readFile(path.join(__dirname,'windows-broadcast.cs'));
    signal?.throwIfAborted();
    const token = crypto.randomBytes(32).toString('hex');
    const listener = net.createServer();
    const session = {address,id,listener};
    this.session = session;
    const ready = new Promise((resolve,reject)=>{
      session.fail = reject;
      listener.once('error',reject);
      listener.on('connection',socket=>{
        socket.setTimeout(1000,()=>socket.destroy());
        socket.on('error',()=>socket.destroy());
        let data = '';
        socket.on('data',chunk=>{
          if (session.control === socket) { socket.destroy(); return; }
          data += chunk.toString('ascii');
          if (data.length > token.length + 1) { socket.destroy(); return; }
          if (!data.endsWith('\n')) return;
          if (data !== token+'\n' || this.session !== session || session.control) { socket.destroy(); return; }
          session.control = socket;
          socket.setTimeout(0);
          socket.once('close',()=>{ if (this.session === session) void this.disable(); });
          listener.close();
          resolve({alreadyEnabled:false});
        });
      });
    });
    try {
      listener.listen(0,'127.0.0.1',()=>{
        if (this.session!==session) return;
        const port = listener.address().port;
        const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source.toString('base64')}'))); [Civ6Broadcast]::Run('${address}',${port},'${token}')`;
        const encoded = Buffer.from(script,'utf16le').toString('base64');
        const launcher = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -PassThru -Wait; exit $p.ExitCode`;
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        session.launcher = execFile(powershell,['-NoProfile','-NonInteractive','-Command',launcher],{windowsHide:true},error=>{
          if (this.session !== session) return;
          if (session.control) { void this.disable(); return; }
          session.fail(new Error(error ? '广播修复未启动。请确认 Windows 管理员授权。' : 'Windows 广播助手已退出。'));
        });
      });
      const timeout = setTimeout(()=>session.fail(new Error('等待 Windows 管理员授权超时。')),120000);
      try { return await ready; } finally { clearTimeout(timeout); }
    } catch (error) {
      if (this.session === session) await this.disable();
      throw error;
    }
  }

  async disable() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.listener.close();
    if (session.control) session.control.destroy();
    else session.launcher?.kill();
    session.fail(new Error('局域网广播修复已关闭。'));
  }
}

module.exports = {WindowsBroadcast};
