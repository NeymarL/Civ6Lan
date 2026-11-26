const $ = id => document.getElementById(id);
let state, working=false, refreshRequest, installation={phase:'idle'};
let localNickname;
let linkRoomId=null, linkInterval, linkSample, linkError, linkRequest;
const labels={OK:'网络就绪',ACCESS_DENIED:'等待房主批准',REQUESTING_CONFIGURATION:'正在获取网络配置',NOT_FOUND:'房主离线或房间不存在',PORT_ERROR:'虚拟网卡异常',CLIENT_TOO_OLD:'请升级 ZeroTier',AUTHENTICATION_REQUIRED:'需要认证',NOT_JOINED:'本机未加入，请退出后重新加入'};
function notice(message){$('notice').textContent=message || ''; $('notice').hidden=!message;}
async function call(name,...args){const result=await window.lan[name](...args);if(!result.ok)throw new Error(result.error);return result.data;}
async function action(fn){if(working)return;working=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);notice('');try{await fn();await refreshRequest;await refresh();}catch(e){notice(e.message);}finally{working=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);renderInstall(installation);}}
function renderInstall(value){
  installation=value;const phase=value.phase, downloading=['downloading','verifying'].includes(phase);
  $('installation').hidden=phase==='idle';
  $('installTitle').textContent=({downloading:'正在从官网下载 ZeroTier',verifying:'正在校验安装包',replacing:'正在切换 ZeroTier 版本',waiting:'请完成系统安装',complete:'网络组件已就绪',error:'安装未完成'})[phase] || '准备安装';
  const mb=n=>(n/1024/1024).toFixed(1)+' MB';
  $('installMessage').textContent=value.message || (phase==='downloading'?`${mb(value.received || 0)}${value.total?' / '+mb(value.total):''} · 下载完成后会打开系统安装程序，请按提示授权。`:'正在检查文件完整性及发布者签名…');
  $('installProgress').hidden=!downloading;
  if(value.total)$('installProgress').value=Math.min(100,Math.round(value.received/value.total*100));else $('installProgress').removeAttribute('value');
  $('cancelDownload').hidden=!downloading;$('cancelDownload').disabled=!downloading;
  $('retryInstallCheck').hidden=phase!=='waiting';
  const installing=downloading || phase==='replacing' || phase==='waiting';
  $('download').disabled=working || installing;
  $('replaceVersion').hidden=installing;
  $('replaceVersion').disabled=working;
  $('create').disabled=working || Boolean(state?.versionMismatch);
  $('join').disabled=working || Boolean(state?.versionMismatch);
}
window.lan.onInstallProgress(renderInstall);
call('installStatus').then(renderInstall).catch(e=>notice(e.message));
call('nickname').then(value=>{
  localNickname=value;
  if (!$('nickname').value) $('nickname').value=value;
}).catch(e=>notice(e.message));
async function saveNickname(){
  if ($('nickname').value!==localNickname) {
    localNickname=await call('saveNickname',$('nickname').value);
    $('nickname').value=localNickname;
  }
}
function renderRoomLinks(){
  if (!state?.room) return;
  if (state.network.status!=='OK') {
    $('roomLinksUpdated').textContent='每 30 秒刷新';
    $('roomLinksStatus').textContent='网络就绪后显示联机延迟。';
    $('roomLinksStatus').hidden=false;
    $('roomLinksTable').hidden=true;
    $('roomLinksRows').replaceChildren();
    $('measureLinks').hidden=true;
    return;
  }
  const targets=state.room.host
    ? [...new Set((state.members || []).filter(m=>m.authorized).map(m=>m.address || m.id))]
        .filter(id=>id && id!==state.address)
    : [state.room.id.slice(0,10)];
  const byAddress=new Map((linkSample?.links || []).map(link=>[link.address,link]));
  const names=new Map((state.members || []).map(member=>[member.address || member.id,member.nickname]));
  $('roomLinksUpdated').textContent=linkRequest?'正在测量…':linkSample
    ? `每 30 秒刷新 · 上次测量 ${new Date(linkSample.sampledAt).toLocaleTimeString('zh-CN',{hour12:false})}`
    : '每 30 秒刷新';
  $('roomLinksStatus').textContent=linkError || (!targets.length
    ? '其他成员获批后会显示在这里。'
    : state.room.host ? '' : '成员端可查看与房主的延迟。');
  $('roomLinksStatus').hidden=!$('roomLinksStatus').textContent;
  $('roomLinksTable').hidden=!targets.length;
  $('measureLinks').hidden=!targets.length;
  const rows=targets.map(address=>{
    const row=document.createElement('tr');
    const link=byAddress.get(address);
    const name=names.get(address) || address;
    const probe=link?.measurement;
    const connection=link?.direct && !state.relay?.forced ? '直连'
      : probe?.replies ? state.relay?.forced && state.relay.active ? '可达，经 TCP 中继' : '可达，未检测到直连'
      : probe ? '未收到应答' : link ? '未检测到直连' : '等待测量';
    const measured=probe ? ` · ${probe.replies}/${probe.sent} 次应答` : link?.latency!=null ? ' · ZeroTier' : '';
    const cells=[
      state.room.host ? name : `${name}（房主）`,
      connection,
      (link?.latency!=null ? `${Math.round(link.latency)} ms` : '—')+measured
    ];
    cells.forEach((value,index)=>{
      const cell=document.createElement(index===0?'th':'td');
      if(index===0)cell.scope='row';
      cell.textContent=value;
      row.append(cell);
    });
    return row;
  });
  $('roomLinksRows').replaceChildren(...rows);
}
async function refreshRoomLinks(){
  if (!linkRoomId || linkRequest) return;
  const request={};
  linkRequest=request;
  renderRoomLinks();
  try {
    const sample=await call('roomLinks');
    if (request===linkRequest && sample?.roomId===linkRoomId) {
      linkSample=sample;
      linkError=undefined;
    }
  } catch (_) {
    if (request===linkRequest) {
      linkSample=undefined;
      linkError='暂时无法读取延迟，下一次会自动重试。';
    }
  } finally {
    if (request===linkRequest) {
      linkRequest=undefined;
      renderRoomLinks();
    }
  }
}
function watchRoomLinks(roomId){
  if (roomId!==linkRoomId) {
    clearInterval(linkInterval);
    linkRoomId=roomId;
    linkSample=linkError=linkRequest=undefined;
    if (roomId) {
      refreshRoomLinks();
      linkInterval=setInterval(refreshRoomLinks,30000);
    }
  }
  renderRoomLinks();
}
function render(s){
  state=s;
  $('versionNotice').hidden=!s.versionMismatch;
  if (s.versionMismatch) {
    $('versionTitle').textContent=`所有玩家需使用 ZeroTier ${s.expectedVersion}`;
    $('versionMessage').textContent=`本机当前运行 ${s.version}。App 会自动下载所需版本。请按系统提示完成替换，ZeroTier 连接会短暂中断。`;
  }
  $('relayPanel').hidden=s.versionMismatch;
  $('relayTitle').textContent=s.relay.forced?'增强连接':'标准连接';
  $('relayHint').textContent=s.relay.forced
    ? s.relay.active?'TCP 中继已连通。':'已启用 TCP 中继，正在等待连通。'
    : s.room?.enhanced?'房主推荐使用增强连接。'
    : s.relay.active?'ZeroTier 正在使用备用 TCP 中继。':'直连不稳定时，可以尝试通过 TCP 中继连接。';
  $('toggleRelay').textContent=s.relay.forced?'恢复标准连接':'开启增强连接';
  renderInstall(installation);
  // 本机服务可用就无需安装。尚未上线时保留授权连接入口。
  $('download').hidden=true;
  $('restartService').hidden=false;
  const reachable=s.online || s.relay.active;
  $('connectionActions').hidden=Boolean(reachable);
  $('service').textContent=s.relay.active?'ZeroTier TCP 中继已连通':s.online?'ZeroTier 已连接互联网':'ZeroTier 运行中，尚未上线';
  $('dot').className='dot'+(reachable?' online':'');
  $('device').textContent=`本机设备 ID：${s.address} · ZeroTier ${s.version}`;
  $('lobby').hidden=!!s.room; $('room').hidden=!s.room;
  watchRoomLinks(s.network?.status==='OK' ? s.room.id : null);
  if(!s.room)return;
  $('discovery').hidden=!s.discovery?.available && !s.discovery?.active;
  $('discoveryHint').textContent=s.discovery?.starting
    ? '正在启用找房修复。请确认系统管理员提示。'
    : s.discovery?.active
    ? '找房修复已启用。请回到文明6刷新局域网列表。'
    : s.discovery?.error || '房间就绪后会自动启用。你也可以手动重新启用找房修复。';
  $('toggleDiscovery').hidden=Boolean(s.discovery?.starting || s.discovery?.external);
  $('toggleDiscovery').textContent=s.discovery?.active?'关闭找房修复':'修复局域网找房';
  const ready=s.network.status==='OK';
  $('role').textContent=s.room.host?'房主 / 网络控制器':ready?'成员 / 已加入':'成员 / 已申请加入';
  $('leave').textContent=s.room.existingNetwork?'关闭房间页面':'退出房间';
  $('roomName').textContent=s.network.name || s.room.name || '好友房间';
  $('invite').textContent=s.invite || 'CIV6-'+s.room.id;
  $('networkState').textContent=labels[s.network.status] || s.network.status || '未知';
  $('ip').textContent=(s.network.assignedAddresses || []).join(', ') || '尚未分配';
  const members=s.members || [];
  $('count').textContent=s.room.host?`${members.filter(m=>m.authorized).length} / ${members.filter(m=>!m.awaitingDiscovery).length}`:'仅房主可查看';
  $('guestActions').hidden=s.room.host;
  $('applications').hidden=!s.room.host;
  $('applicationHint').textContent=members.some(m=>!m.authorized)
    ? '只有设备 ID 时，可粘贴朋友发来的昵称申请。'
    : '暂无待批准申请。可以先粘贴朋友发来的昵称申请。';
  $('hint').textContent=ready?'网络已配置。请在文明6中验证房间发现与连接。':s.room.host?'等待网络配置完成。若持续失败，请检查 ZeroTier 服务和网络连接。':s.network.status==='ACCESS_DENIED'
    ? '已提交加入申请，等待房主批准。复制昵称申请发给房主，批准后会自动连接房间。'
    : '可以先复制昵称申请发给房主，并留意上方的网络状态。';
  $('members').replaceChildren();
  $('pendingMembers').replaceChildren();
  for(const m of members){
    const id=m.address || m.id;
    const row=document.createElement('div');row.className='member';
    const text=document.createElement('div');const title=document.createElement('strong');
    const role=id===s.address?'（本机）':id===s.room.id.slice(0,10)?'（房主）':'';
    title.textContent=(m.nickname || id)+role;text.append(title,document.createElement('br'));
    const small=document.createElement('small');
    const status=m.authorized?'已批准':m.awaitingDiscovery?'等待 ZeroTier 识别设备':'待批准';
    small.textContent=[m.nickname && id,status,...(m.ipAssignments || [])].filter(Boolean).join(' · ');
    text.append(small);row.append(text);
    if(s.room.host && id!==s.address && !m.awaitingDiscovery){const button=document.createElement('button');button.textContent=m.authorized?'撤销授权':'核对后批准';button.disabled=working;button.onclick=()=>action(()=>call('member',id,!m.authorized));row.append(button);}
    $(s.room.host && !m.authorized?'pendingMembers':'members').append(row);
  }
}
function refresh(){
  if(!refreshRequest)refreshRequest=loadSnapshot().finally(()=>{refreshRequest=undefined;});
  return refreshRequest;
}
async function loadSnapshot(){
  try {
    render(await call('snapshot'));
  } catch(e) {
    $('download').hidden=false;
    $('connectionActions').hidden=false;
    $('service').textContent='本机服务尚未连接';
    $('dot').className='dot';
    $('discovery').hidden=true;
    $('versionNotice').hidden=true;
    $('relayPanel').hidden=true;
    notice(e.message);
  }
}
$('authorize').onclick=()=>action(async()=>{
  const button=$('authorize');button.textContent='正在连接…';
  notice('正在检测本机服务；如系统弹出授权窗口，请完成授权。');
  try{await call('authorize');notice('已连接本机 ZeroTier 服务。');}
  finally{button.textContent='授权连接';}
});
$('saveToken').onclick=()=>action(async()=>{const value=$('token').value;$('token').value='';await call('token',value);});
$('restartService').onclick=()=>action(async()=>{
  const button=$('restartService');
  button.textContent='正在重启…';
  notice('ZeroTier 正在重启，将短暂中断虚拟网络连接。如系统弹出授权窗口，请完成授权。');
  try {
    const result=await call('restartService');
    notice(result.online?'ZeroTier 已重启并上线。':'ZeroTier 已重启，仍在等待上线。若持续未上线，可切换到手机热点测试。');
  } finally {
    button.textContent='重启 ZeroTier';
  }
});
$('nicknameForm').onsubmit=event=>{
  event.preventDefault();
  action(async()=>{await saveNickname();notice('昵称已保存。');});
};
$('create').onclick=()=>action(async()=>{await saveNickname();await call('create',$('name').value);});
$('join').onclick=()=>action(async()=>{await saveNickname();await call('join',$('code').value);});
$('leave').onclick=()=>action(()=>call('leave'));
$('toggleDiscovery').onclick=()=>action(async()=>{
  if(state?.discovery?.active) {
    await call('disableDiscovery');
    notice('已关闭找房修复。');
    return;
  }
  notice('请确认系统的管理员授权提示。');
  const result=await call('enableDiscovery');
  notice(result.alreadyEnabled?'当前广播已走 ZeroTier，请回到文明6刷新。':'找房修复已启用，请回到文明6刷新。');
});
$('copy').onclick=()=>action(async()=>{await call('copy');notice('邀请码已复制。');});
$('copyApplication').onclick=()=>action(async()=>{await saveNickname();await call('copyApplication');notice('昵称申请已复制，请发送给房主。');});
$('pasteApplication').onclick=()=>action(async()=>{const name=await call('pasteApplication');notice(`已保存「${name}」的昵称申请。`);});
$('updateHostInfo').onclick=()=>action(async()=>{await call('updateHostInfo');notice('已更新当前房间的房主信息。');});
$('measureLinks').onclick=()=>void refreshRoomLinks();
$('download').onclick=()=>action(()=>call('download'));
$('replaceVersion').onclick=()=>action(()=>call('download'));
$('toggleRelay').onclick=()=>action(()=>call('setRelay',!state.relay.forced));
$('cancelDownload').onclick=async()=>{try{await call('cancelDownload');}catch(e){notice(e.message);}};
$('retryInstallCheck').onclick=()=>action(()=>call('retryInstallCheck'));
$('steam').onclick=()=>action(()=>call('steam'));
$('diagnostics').onclick=()=>action(()=>call('diagnostics'));
refresh();setInterval(()=>{if(!working)refresh();},5000);
