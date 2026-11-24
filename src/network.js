const http = require('http');
const crypto = require('crypto');
const os = require('os');

function networkId(value) {
  const id = String(value || '').trim().replace(/^CIV6-/i, '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('请输入 CIV6- 加 16 位网络 ID 的邀请码。');
  return id;
}
function nodeId(value) {
  if (!/^[0-9a-f]{10}$/.test(value)) throw new Error('设备 ID 无效。');
  return value;
}
function request(token, method, path, body, port=9993) {
  if(!Number.isInteger(port) || port<1 || port>65535)return Promise.reject(new Error('本机服务端口无效。'));
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({hostname:'127.0.0.1', port, path, method,
      headers:{'X-ZT1-Auth':token, 'Content-Type':'application/json'}}, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; if (raw.length > 4e6) req.destroy(new Error('服务响应过大。')); });
      res.on('end', () => {
        if (method === 'DELETE' && res.statusCode === 404) return resolve({});
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(Object.assign(new Error('ZeroTier 拒绝了本机令牌，请重新授权。'), {code:'ZT_AUTH'}));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`ZeroTier 服务返回 ${res.statusCode}，请确认服务和控制器可用。`));
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('ZeroTier 响应格式无效。')); }
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('本机 ZeroTier 服务响应超时。')));
    req.on('error', error => {
      if(error.code === 'ECONNREFUSED') {
        const hint = process.platform === 'win32' ? '请到任务管理器 → 服务，确认 ZeroTierOneService 正在运行。' : '请确认 ZeroTier 服务正在运行。';
        reject(new Error(`无法连接本机 ZeroTier 服务（端口 ${port}）。${hint}`));
      } else reject(error);
    });
    req.end(data);
  });
}
class Network {
  constructor(api, persist, saved = {}) { this.api = api; this.persist = persist; this.room = saved.room || null; }
  async save(room) { await this.persist({room}); this.room = room; }
  async create(name) {
    if (this.room) throw new Error('请先离开当前房间。');
    name = String(name || '').trim().slice(0, 48) || '文明6好友局';
    const status = await this.api('GET', '/status');
    const owner = nodeId(status.address);
    // 随机选择私有 /24 网段，并排除房主已有接口网段；朋友端仍需检查冲突。
    const occupied = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i.address);
    let base;
    do { base = `10.${crypto.randomInt(64, 128)}.${crypto.randomInt(1, 255)}`; }
    while (occupied.some(ip => ip.startsWith(base + '.')));
    let id;
    try {
      const created = await this.api('POST', `/controller/network/${owner}______`, {
        name, private:true, enableBroadcast:true, multicastLimit:32, v4AssignMode:{zt:true},
        ipAssignmentPools:[{ipRangeStart:base+'.10', ipRangeEnd:base+'.250'}],
        routes:[{target:base+'.0/24', via:null}],
        rules:[{type:'ACTION_ACCEPT'}]
      });
      id = networkId(created.id || created.nwid);
      await this.api('POST', `/controller/network/${id}/member/${owner}`, {authorized:true});
      await this.api('POST', `/network/${id}`, {allowManaged:true,allowGlobal:false,allowDefault:false,allowDNS:false});
      await this.save({id,name,host:true});
      return this.room;
    } catch (error) {
      if (id) {
        await this.api('DELETE', `/network/${id}`).catch(()=>{});
        await this.api('DELETE', `/controller/network/${id}`).catch(()=>{});
      }
      throw error;
    }
  }
  async join(code) {
    if (this.room) throw new Error('请先离开当前房间。');
    const id = networkId(code);
    const networks = await this.api('GET', '/network');
    const existing = networks.find(network => (network.id || network.nwid) === id);
    if (existing) {
      await this.save({id, host:false, existingNetwork:true});
      return this.room;
    }
    await this.api('POST', `/network/${id}`, {allowManaged:true,allowGlobal:false,allowDefault:false,allowDNS:false});
    try { await this.save({id,host:false}); }
    catch (error) { await this.api('DELETE', `/network/${id}`).catch(()=>{}); throw error; }
    return this.room;
  }
  async leave() {
    if (!this.room) return;
    const {id,host,existingNetwork} = this.room;
    // 房主离开即关闭控制器网络，朋友的网络配置会失效。
    if (host) await this.api('DELETE', `/controller/network/${id}`);
    if (!existingNetwork) await this.api('DELETE', `/network/${id}`);
    await this.save(null);
  }
  async authorize(member, authorized) {
    if (!this.room || !this.room.host) throw new Error('只有房主可以批准成员。');
    const status = await this.api('GET', '/status');
    if (member === status.address) throw new Error('不能撤销房主自己的授权。');
    return this.api('POST', `/controller/network/${this.room.id}/member/${nodeId(member)}`, {authorized:!!authorized});
  }
  async snapshot({includePeers = true} = {}) {
    const room = this.room;
    const status = await this.api('GET','/status');
    const result = {address:status.address,online:status.online,version:status.version,room};
    if (!room) return result;
    const id = room.id;
    const networks = await this.api('GET','/network');
    const network = networks.find(n => (n.id || n.nwid) === id);
    result.network = network || {status:'NOT_JOINED'};
    if (room.host) {
      const members = await this.api('GET',`/controller/network/${id}/member`);
      result.members = await Promise.all(Object.keys(members).map(member =>
        this.api('GET',`/controller/network/${id}/member/${nodeId(member)}`)));
    }
    if (!includePeers) return result;
    const peers = await this.api('GET','/peer');
    const memberIds = new Set((result.members || []).map(m => m.address || m.id));
    result.peers = peers.filter(p => memberIds.has(p.address) || (!room.host && p.address === id.slice(0,10)))
      .map(p => ({address:p.address,latency:p.latency, direct:(p.paths || []).some(path => path.active)}));
    return result;
  }

  async roomLinks({room, address, network, members = []}) {
    if (!room || room !== this.room || network?.status !== 'OK') return null;
    const targets = room.host
      ? members.filter(member => member.authorized).map(member => member.address || member.id)
      : [room.id.slice(0, 10)];
    const ids = [...new Set(targets)].filter(id => id !== address && /^[0-9a-f]{10}$/.test(id));
    const peers = ids.length ? await this.api('GET', '/peer') : [];
    if (room !== this.room) return null;
    const peersById = new Map(peers.map(peer => [peer.address, peer]));
    return {
      roomId: room.id,
      sampledAt: Date.now(),
      links: ids.map(id => {
        const peer = peersById.get(id);
        return {
          address: id,
          latency: Number.isFinite(peer?.latency) && peer.latency >= 0 ? peer.latency : null,
          direct: Boolean(peer?.paths?.some(path => path.active))
        };
      })
    };
  }
}
module.exports = {Network,request,networkId,nodeId};
