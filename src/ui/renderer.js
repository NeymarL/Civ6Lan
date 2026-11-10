const $ = id => document.getElementById(id);
let state, working=false, refreshing=false, installation={phase:'idle'};
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
function render(s){
  state=s;
  $('connectionActions').hidden=!!s.online;
  $('service').textContent=s.online?'ZeroTier 已连接互联网':'ZeroTier 运行中，尚未上线';
  $('dot').className='dot'+(s.online?' online':'');
  $('device').textContent=`本机设备 ID：${s.address} · ZeroTier ${s.version}`;
  $('lobby').hidden=!!s.room; $('room').hidden=!s.room;
  if(!s.room)return;
  $('role').textContent=s.room.host?'房主 / 网络控制器':'成员 / 已申请加入';
  $('roomName').textContent=s.network.name || s.room.name || '好友房间';
  $('invite').textContent='CIV6-'+s.room.id;
  $('networkState').textContent=labels[s.network.status] || s.network.status || '未知';
  $('ip').textContent=(s.network.assignedAddresses || []).join(', ') || '尚未分配';
  const members=s.members || [];
  $('count').textContent=s.room.host?`${members.filter(m=>m.authorized).length} / ${members.length}`:'仅房主可查看';
  $('hint').textContent=s.network.status==='OK'?'网络已配置。请在文明6中验证房间发现与连接；检查虚拟 IP 是否与本地其他网络冲突。':s.room.host?'等待网络配置完成。若持续失败，请检查 ZeroTier 服务和网络连接。':`请将本机设备 ID ${s.address} 发给房主，请他核对后批准。`;
  $('members').replaceChildren();
  for(const m of members){
    const id=m.address || m.id;
    const row=document.createElement('div');row.className='member';
    const text=document.createElement('div');const code=document.createElement('code');code.textContent=id+(id===s.address?'（本机）':'');text.append(code,document.createElement('br'));
    const small=document.createElement('small');small.textContent=(m.authorized?'已批准':'待批准')+' · '+((m.ipAssignments || []).join(', ') || '尚无 IP');text.append(small);row.append(text);
    if(id!==s.address){const button=document.createElement('button');button.textContent=m.authorized?'撤销授权':'核对后批准';button.disabled=working;button.onclick=()=>action(()=>call('member',id,!m.authorized));row.append(button);}
    $('members').append(row);
  }
  $('peers').textContent=(s.peers || []).map(p=>`${p.address} · ${p.direct?'存在直连路径':'尚无活跃直连路径，可能中继或尚未建立连接'} · ${p.latency>=0?p.latency+' ms':'延迟未知'}`).join(' / ');
}
async function refresh(){if(refreshing)return;refreshing=true;try{render(await call('snapshot'));}catch(e){$('connectionActions').hidden=false;$('service').textContent='本机服务尚未连接';$('dot').className='dot';notice(e.message);}finally{refreshing=false;}}
$('authorize').onclick=()=>action(async()=>{
  const button=$('authorize');button.textContent='正在连接…';
  notice('正在检测本机服务；如系统弹出授权窗口，请完成授权。');
  try{await call('authorize');notice('已连接本机 ZeroTier 服务。');}
  finally{button.textContent='授权连接';}
});
$('saveToken').onclick=()=>action(async()=>{const value=$('token').value;$('token').value='';await call('token',value);});
$('create').onclick=()=>action(()=>call('create',$('name').value));
$('join').onclick=()=>action(()=>call('join',$('code').value));
$('leave').onclick=()=>action(()=>call('leave'));
$('copy').onclick=()=>action(()=>call('copy'));
$('download').onclick=()=>action(()=>call('download'));
$('cancelDownload').onclick=async()=>{try{await call('cancelDownload');}catch(e){notice(e.message);}};
$('retryInstallCheck').onclick=()=>action(()=>call('retryInstallCheck'));
$('steam').onclick=()=>action(()=>call('steam'));
$('diagnostics').onclick=()=>action(()=>call('diagnostics'));
refresh();setInterval(()=>{if(!working)refresh();},5000);
