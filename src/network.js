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
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('本机服务授权失败，请重新授权。'));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`ZeroTier 服务返回 ${res.statusCode}，请确认服务和控制器可用。`));
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('ZeroTier 响应格式无效。')); }
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('本机 ZeroTier 服务响应超时。')));
    req.on('error', error => reject(new Error(error.code === 'ECONNREFUSED' ? `无法连接本机 ZeroTier 服务（端口 ${port}）。请确认服务已启动，再点击“授权连接”。` : error.message)));
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
    const existing = await this.api('GET', '/network');
    if (existing.some(n => (n.id || n.nwid) === id)) throw new Error('本机已通过其他方式加入此网络。请先在 ZeroTier 中确认并退出，再用本应用加入。');
    await this.api('POST', `/network/${id}`, {allowManaged:true,allowGlobal:false,allowDefault:false,allowDNS:false});
    try { await this.save({id,host:false}); }
    catch (error) { await this.api('DELETE', `/network/${id}`).catch(()=>{}); throw error; }
    return this.room;
  }
  async leave() {
    if (!this.room) return;
    const {id,host} = this.room;
    // 房主离开即关闭控制器网络，朋友的网络配置会失效。
    if (host) await this.api('DELETE', `/controller/network/${id}`);
    await this.api('DELETE', `/network/${id}`);
    await this.save(null);
  }
  async authorize(member, authorized) {
    if (!this.room || !this.room.host) throw new Error('只有房主可以批准成员。');
    const status = await this.api('GET', '/status');
    if (member === status.address) throw new Error('不能撤销房主自己的授权。');
    return this.api('POST', `/controller/network/${this.room.id}/member/${nodeId(member)}`, {authorized:!!authorized});
  }
  async snapshot() {
    const status = await this.api('GET','/status');
    const result = {address:status.address,online:status.online,version:status.version,room:this.room};
    if (!this.room) return result;
    const id = this.room.id;
    const networks = await this.api('GET','/network');
    const network = networks.find(n => (n.id || n.nwid) === id);
    result.network = network || {status:'NOT_JOINED'};
    if (this.room.host) {
      const members = await this.api('GET',`/controller/network/${id}/member`);
      result.members = await Promise.all(Object.keys(members).map(member =>
        this.api('GET',`/controller/network/${id}/member/${nodeId(member)}`)));
    }
    const peers = await this.api('GET','/peer');
    const memberIds = new Set((result.members || []).map(m => m.address || m.id));
    result.peers = peers.filter(p => memberIds.has(p.address) || (!this.room.host && p.address === id.slice(0,10)))
      .map(p => ({address:p.address,latency:p.latency, direct:(p.paths || []).some(path => path.active)}));
    return result;
  }
}
module.exports = {Network,request,networkId,nodeId};
