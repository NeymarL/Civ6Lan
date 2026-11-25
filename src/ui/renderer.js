const $ = id => document.getElementById(id);
let state, working=false, refreshing=false, installation={phase:'idle'};
let localNickname;
let linkRoomId=null, linkInterval, linkSample, linkError, linkRequest;
const labels={OK:'网络就绪',ACCESS_DENIED:'等待房主批准',REQUESTING_CONFIGURATION:'正在获取网络配置',NOT_FOUND:'房主离线或房间不存在',PORT_ERROR:'虚拟网卡异常',CLIENT_TOO_OLD:'请升级 ZeroTier',AUTHENTICATION_REQUIRED:'需要认证',NOT_JOINED:'本机未加入，请退出后重新加入'};
function notice(message){$('notice').textContent=message || ''; $('notice').hidden=!message;}
async function call(name,...args){const result=await window.lan[name](...args);if(!result.ok)throw new Error(result.error);return result.data;}
async function action(fn){if(working)return;working=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);notice('');try{await fn();await refresh();}catch(e){notice(e.message);}finally{working=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);renderInstall(installation);}}
function renderInstall(value){
  installation=value;const phase=value.phase, downloading=['downloading','verifying'].includes(phase);
  $('installation').hidden=phase==='idle';
  $('installTitle').textContent=({downloading:'正在从官网下载 ZeroTier',verifying:'正在校验安装包',waiting:'请完成系统安装',complete:'网络组件已就绪',error:'安装未完成'})[phase] || '准备安装';
  const mb=n=>(n/1024/1024).toFixed(1)+' MB';
  $('installMessage').textContent=value.message || (phase==='downloading'?`${mb(value.received || 0)}${value.total?' / '+mb(value.total):''} · 下载完成后会打开系统安装程序，请按提示授权。`:'正在检查文件完整性及发布者签名…');
  $('installProgress').hidden=!downloading;
  if(value.total)$('installProgress').value=Math.min(100,Math.round(value.received/value.total*100));else $('installProgress').removeAttribute('value');
  $('cancelDownload').hidden=!downloading;$('cancelDownload').disabled=!downloading;
  $('retryInstallCheck').hidden=phase!=='waiting';
  $('download').disabled=working || phase==='waiting';
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
    return;
  }
  const targets=state.room.host
    ? [...new Set((state.members || []).filter(m=>m.authorized).map(m=>m.address || m.id))]
        .filter(id=>id && id!==state.address)
    : [state.room.id.slice(0,10)];
  const byAddress=new Map((linkSample?.links || []).map(link=>[link.address,link]));
  const names=new Map((state.members || []).map(member=>[member.address || member.id,member.nickname]));
  $('roomLinksUpdated').textContent=linkSample
    ? `每 30 秒刷新 · 上次读取 ${new Date(linkSample.sampledAt).toLocaleTimeString('zh-CN',{hour12:false})}`
    : '每 30 秒刷新';
  $('roomLinksStatus').textContent=linkError || (!targets.length
    ? '其他成员获批后会显示在这里。'
    : state.room.host ? '' : '成员端可查看与房主的延迟。');
  $('roomLinksStatus').hidden=!$('roomLinksStatus').textContent;
  $('roomLinksTable').hidden=!targets.length;
  const rows=targets.map(address=>{
    const row=document.createElement('tr');
    const link=byAddress.get(address);
    const name=names.get(address) || address;
    const cells=[
      state.room.host ? name : `${name}（房主）`,
      link?.direct ? '直连' : '未确认',
      link && link.latency!==null ? `${Math.round(link.latency)} ms` : '暂无数据'
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
  // 本机服务可用就无需安装。尚未上线时保留授权连接入口。
  $('download').hidden=true;
  $('restartService').hidden=false;
  $('connectionActions').hidden=!!s.online;
  $('service').textContent=s.online?'ZeroTier 已连接互联网':'ZeroTier 运行中，尚未上线';
  $('dot').className='dot'+(s.online?' online':'');
  $('device').textContent=`本机设备 ID：${s.address} · ZeroTier ${s.version}`;
  $('lobby').hidden=!!s.room; $('room').hidden=!s.room;
  watchRoomLinks(s.network?.status==='OK' ? s.room.id : null);
  if(!s.room)return;
  $('discovery').hidden=!s.discovery?.available && !s.discovery?.active;
  $('discoveryHint').textContent=s.discovery?.active
    ? '找房修复已启用。请回到文明6刷新局域网列表。'
    : '游戏里看不到房间时，可让这台电脑的找房广播通过 ZeroTier 发送。';
  $('toggleDiscovery').textContent=s.discovery?.active?'关闭找房修复':'修复局域网找房';
  $('role').textContent=s.room.host?'房主 / 网络控制器':s.room.existingNetwork?'成员 / 已识别现有网络':'成员 / 已申请加入';
  $('leave').textContent=s.room.existingNetwork?'关闭房间页面':'退出房间';
  $('roomName').textContent=s.network.name || s.room.name || '好友房间';
  $('invite').textContent=s.invite || 'CIV6-'+s.room.id;
  $('networkState').textContent=labels[s.network.status] || s.network.status || '未知';
  $('ip').textContent=(s.network.assignedAddresses || []).join(', ') || '尚未分配';
  const members=s.members || [];
  $('count').textContent=s.room.host?`${members.filter(m=>m.authorized).length} / ${members.length}`:'仅房主可查看';
  $('copyApplication').hidden=s.room.host || s.network.status==='OK';
  $('pasteApplication').hidden=!s.room.host;
  $('hint').textContent=s.network.status==='OK'?'网络已配置。请在文明6中验证房间发现与连接。':s.room.host?'等待网络配置完成。若持续失败，请检查 ZeroTier 服务和网络连接。':'复制加入申请并发给房主。房主粘贴后即可核对你的昵称和设备 ID。';
  $('members').replaceChildren();
  for(const m of members){
    const id=m.address || m.id;
    const row=document.createElement('div');row.className='member';
    const text=document.createElement('div');const title=document.createElement('strong');
    const role=id===s.address?'（本机）':id===s.room.id.slice(0,10)?'（房主）':'';
    title.textContent=(m.nickname || id)+role;text.append(title,document.createElement('br'));
    const small=document.createElement('small');
    small.textContent=[m.nickname && id,m.authorized?'已批准':'待批准',...(m.ipAssignments || [])].filter(Boolean).join(' · ');
    text.append(small);row.append(text);
    if(s.room.host && id!==s.address){const button=document.createElement('button');button.textContent=m.authorized?'撤销授权':'核对后批准';button.disabled=working;button.onclick=()=>action(()=>call('member',id,!m.authorized));row.append(button);}
    $('members').append(row);
  }
}
async function refresh(){
  if(refreshing)return;
  refreshing=true;
  try {
    render(await call('snapshot'));
  } catch(e) {
    $('download').hidden=false;
    $('connectionActions').hidden=false;
    $('service').textContent='本机服务尚未连接';
    $('dot').className='dot';
    $('discovery').hidden=true;
    notice(e.message);
  } finally {
    refreshing=false;
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
$('copyApplication').onclick=()=>action(async()=>{await saveNickname();await call('copyApplication');notice('加入申请已复制，请发送给房主。');});
$('pasteApplication').onclick=()=>action(async()=>{const name=await call('pasteApplication');notice(`已读取「${name}」的加入申请，请核对后批准。`);});
$('download').onclick=()=>action(()=>call('download'));
$('cancelDownload').onclick=async()=>{try{await call('cancelDownload');}catch(e){notice(e.message);}};
$('retryInstallCheck').onclick=()=>action(()=>call('retryInstallCheck'));
$('steam').onclick=()=>action(()=>call('steam'));
$('diagnostics').onclick=()=>action(()=>call('diagnostics'));
refresh();setInterval(()=>{if(!working)refresh();},5000);
