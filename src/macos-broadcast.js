const {execFile} = require('child_process');
const fs = require('fs').promises;
const {isIPv4} = require('net');
const os = require('os');
const path = require('path');
const {setTimeout: delay} = require('timers/promises');
const {promisify} = require('util');

const exec = promisify(execFile);
const DESTINATION = '255.255.255.255';

// The privileged process owns the route and rolls it back when the app or room closes.
// The app can only remove its marker directory. The helper neither runs nor writes user files.
const WATCH_ROUTE = String.raw`set -eu
iface=$1
ip=$2
marker=$3
parent=$4
dest=255.255.255.255
lock=/var/run/civ6-lan-broadcast.lock

running() {
  [ -d "$marker" ] && /bin/kill -0 "$parent" 2>/dev/null
}
interface_ready() {
  /sbin/ifconfig "$iface" 2>/dev/null |
    /usr/bin/awk -v ip="$ip" '$1 == "inet" && $2 == ip {found=1} END {exit !found}'
}
broadcast_interface() {
  /sbin/route -n get "$dest" 2>/dev/null |
    /usr/bin/awk '$1 == "interface:" {print $2; exit}'
}
running && interface_ready || exit 1
/bin/mkdir "$lock"
added=0
cleanup() {
  result=0
  if [ "$added" = 1 ] && /usr/sbin/netstat -nrf inet | /usr/bin/awk -v dest="$dest" -v iface="$iface" '
    ($1 == dest || $1 == dest "/32") && $3 ~ /H/ && $3 ~ /S/ && $3 !~ /I/ && $4 == iface {found=1}
    END {exit !found}'; then
    /sbin/route -n delete -host "$dest" -interface "$iface" || result=$?
  fi
  /bin/rmdir "$lock"
  return "$result"
}
trap 'status=$?; trap - EXIT; cleanup || status=$?; exit "$status"' EXIT
trap 'exit 0' HUP INT TERM
[ "$(broadcast_interface)" != "$iface" ] || exit 0
/sbin/route -n add -host "$dest" -interface "$iface"
added=1
[ "$(broadcast_interface)" = "$iface" ] || exit 1
while running && interface_ready && [ "$(broadcast_interface)" = "$iface" ]; do
  /bin/sleep 1
done`;

const SCRIPT = `on run argv
  set cmd to "/bin/sh -c " & quoted form of (item 1 of argv) & " civ6-broadcast"
  repeat with idx from 2 to count argv
    set cmd to cmd & " " & quoted form of (item idx of argv)
  end repeat
  do shell script cmd with administrator privileges
end run`;

function roomInterface(network, interfaces = os.networkInterfaces()) {
  const name = network?.portDeviceName;
  if (network?.status !== 'OK' || !/^[a-z][a-z0-9]{0,14}$/i.test(name || '')) {
    throw new Error('房间的 ZeroTier 网卡尚未就绪。');
  }
  const assigned = (network.assignedAddresses || []).map(value => value.split('/')[0]);
  const ipv4 = (interfaces[name] || []).find(item => isIPv4(item.address) && assigned.includes(item.address));
  if (!ipv4) throw new Error('找不到当前房间的 ZeroTier IPv4 地址。');
  return {name, address:ipv4.address};
}

async function broadcastInterface() {
  try {
    const {stdout} = await exec('/sbin/route', ['-n','get',DESTINATION], {timeout:3000});
    return /^\s*interface:\s+(\S+)\s*$/m.exec(stdout)?.[1] || null;
  } catch (_) {
    return null;
  }
}

class MacBroadcast {
  constructor() {
    this.supported = process.platform === 'darwin';
    this.session = null;
  }

  get active() { return this.session?.active === true && !this.session.done; }

  available(network) {
    if (!this.supported) return false;
    try { return Boolean(roomInterface(network)); }
    catch (_) { return false; }
  }

  async update(room, network) {
    const session = this.session;
    if (session && (session.roomId !== room?.id || network?.status !== 'OK' ||
      network.portDeviceName !== session.name)) await this.disable();
    const available = this.available(network);
    const external = available && this.externalRoom===room?.id && await broadcastInterface()===network.portDeviceName;
    return {available, active:this.active || Boolean(external), external:Boolean(external)};
  }

  async enable(network, roomId, signal) {
    signal?.throwIfAborted();
    if (!this.supported) throw new Error('当前系统尚不支持修复广播找房。');
    if (this.session) throw new Error('广播找房正在运行，请先关闭。');
    const {name,address} = roomInterface(network);
    const current = await broadcastInterface();
    signal?.throwIfAborted();
    if (current === name) {
      this.externalRoom = roomId;
      return {alreadyEnabled:true};
    }
    const marker = await fs.mkdtemp(path.join(os.tmpdir(),'civ6-broadcast-'));
    if (signal?.aborted) {
      await fs.rmdir(marker);
      signal.throwIfAborted();
    }
    const session = {marker, name, roomId, active:false, done:false};
    this.session = session;
    const invocation = exec('/usr/bin/osascript', ['-e',SCRIPT,'--',WATCH_ROUTE,name,address,marker,String(process.pid)]);
    session.cancel = ()=>invocation.child.kill();
    session.finished = invocation
      .then(() => { session.done = true; }, error => {
        session.done = true;
        session.error = error;
      }).finally(async () => {
        if (this.session === session) this.session = null;
        await fs.rmdir(marker).catch(()=>{});
      });
    const deadline = Date.now()+120000;
    while (this.session === session && !session.done && !signal?.aborted && Date.now() < deadline) {
      if (await broadcastInterface() === name && !session.done && !signal?.aborted && this.session === session) {
        session.active = true;
        return {alreadyEnabled:false};
      }
      await delay(350);
    }
    if (this.session === session && !signal?.aborted) await this.disable();
    signal?.throwIfAborted();
    const stderr = session.error?.stderr || '';
    if (/\(-128\)/.test(stderr)) throw new Error('已取消局域网找房修复。');
    if (!session.done) {
      invocation.child.kill();
      throw new Error('等待系统授权超时。');
    }
    if (/File exists/i.test(stderr)) throw new Error('系统已有广播路由，无法安全切换网卡。');
    throw new Error('系统未能切换广播网卡。请检查当前房间仍然就绪，再重试。');
  }

  async disable() {
    this.externalRoom = undefined;
    const session = this.session;
    if (!session) return;
    await fs.rmdir(session.marker).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if (!session.active) { if (!session.done) session.cancel(); return; }
    await Promise.race([session.finished, delay(3500)]);
    if (!session.done) throw new Error('正在恢复原广播路由，请稍后重试。');
    if (session.error) throw new Error('系统报告广播路由清理异常，请检查当前网络设置。');
  }
}

module.exports = {MacBroadcast,roomInterface};
