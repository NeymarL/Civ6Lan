const http = require('node:http');
const {isIPv4, BlockList} = require('node:net');

const PORT = 49176;
const ID = /^[0-9a-f]{10}$/;
const MAX_RESPONSE = 48 * 1024;

function nickname(value) {
  if (typeof value !== 'string' || value.length > 48) throw new Error('昵称最多 24 个字符。');
  const name = value.trim();
  if ([...name].length > 24 || /[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new Error('昵称最多 24 个可显示字符。');
  }
  return name;
}

function savedNickname(value) {
  try { return nickname(value); } catch (_) { return ''; }
}

function gameIPv4(network) {
  if (network?.status !== 'OK') return null;
  return network.assignedAddresses?.map(value=>value.split('/')[0]).find(isIPv4) || null;
}

function sameSubnet(network, local, host) {
  if (!isIPv4(host) || !local || local===host) return false;
  const own=network.assignedAddresses.find(value=>value.startsWith(local+'/'));
  const bits=Number(own?.split('/')[1]);
  if (!Number.isInteger(bits) || bits<16 || bits>32) return false;
  const subnet=new BlockList();
  subnet.addSubnet(local,bits);
  return subnet.check(host);
}

async function readJson(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('消息过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

function requestRoster(room, host, self, name) {
  const body = JSON.stringify({room,nickname:name});
  return new Promise((resolve, reject) => {
    const request = http.request({hostname:host, port:PORT, method:'POST',
      path:'/profile', localAddress:self, agent:false,
      signal:AbortSignal.timeout(1500), headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, response => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve([]);
        return;
      }
      readJson(response, MAX_RESPONSE).then(resolve,reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

class RoomProfiles {
  constructor() { this.room = null; this.names = new Map(); }

  close() {
    this.stopServer();
    this.room = null;
    this.names.clear();
  }

  stopServer() {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.boundAddress = null;
  }

  hostMembers() {
    const {address, members = []} = this.state;
    return members.map(member => {
      const id = member.address || member.id;
      const name = id === address ? this.nickname : this.names.get(id) ?? this.room.applications?.[id];
      return {...member,address:id,nickname:name || ''};
    });
  }

  async receive(server, request, response) {
    const room = this.room;
    const ip = request.socket.remoteAddress;
    if (request.method !== 'POST' || request.url !== '/profile' || !isIPv4(ip) || this.server !== server) {
      response.writeHead(404).end();
      return;
    }
    try {
      const payload = await readJson(request,512);
      if (this.server !== server) { response.writeHead(503).end(); return; }
      const member = this.hostMembers().find(item=>item.authorized && item.ipAssignments?.includes(ip));
      if (payload.room!==room.id || !member) { response.writeHead(404).end(); return; }
      this.names.set(member.address,nickname(payload.nickname));
      const roster = this.hostMembers().filter(m=>m.authorized).map(m=>({address:m.address,nickname:m.nickname}));
      response.writeHead(200, {'Content-Type':'application/json','Connection':'close'}).end(JSON.stringify(roster));
    } catch (_) {
      if (!response.destroyed) response.writeHead(400).end();
    }
  }

  listen(hostAddress) {
    const server = http.createServer({requestTimeout:3000,headersTimeout:3000,maxHeaderSize:2048,connectionsCheckingInterval:1000},
      (request,response)=>void this.receive(server,request,response));
    this.server = server;
    this.boundAddress = hostAddress;
    server.maxConnections = 32;
    server.keepAliveTimeout = 1000;
    server.on('error',()=>{ if (this.server === server) this.stopServer(); });
    server.listen({host:hostAddress,port:PORT});
  }

  async sync(state, name) {
    const {room, address, network} = state;
    if (room?.id!==this.room?.id || room?.host!==this.room?.host) this.close();
    this.room = room;
    if (!room) return [];
    this.state = state;
    this.nickname = name;
    const local = gameIPv4(network);
    if (room.host) {
      if (this.server && this.boundAddress!==local) this.stopServer();
      if (local && !this.server) this.listen(local);
      const members = this.hostMembers();
      const current = new Set(members.map(member=>member.address));
      for (const id of this.names.keys()) if (!current.has(id)) this.names.delete(id);
      return members;
    }
    const host = room.id.slice(0, 10);
    const self = {address, nickname:name, authorized:network.status==='OK', ipAssignments:network.assignedAddresses};
    if (!self.authorized) return [self];
    const roster = sameSubnet(network,local,room.hostIp)
      ? await requestRoster(room.id,room.hostIp,local,name).catch(()=>null) : null;
    const verified = new Map([[host,{address:host,nickname:savedNickname(room.hostNickname),authorized:true}]]);
    if (Array.isArray(roster)) {
      for (const item of roster) {
        if (item && ID.test(item.address)) verified.set(item.address,{address:item.address,nickname:savedNickname(item.nickname),authorized:true});
      }
    }
    verified.set(address,self);
    return [...verified.values()];
  }
}

module.exports = {PORT, RoomProfiles, nickname, savedNickname, gameIPv4, sameSubnet};
