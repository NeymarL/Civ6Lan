const $ = id => document.getElementById(id);
const titles = {
  checking:'正在检查 ZeroTier',
  starting:'正在启动 ZeroTier',
  authorizing:'正在授权连接',
  connecting:'正在连接 ZeroTier',
  error:'启动检查未完成'
};
const installTitles = {
  downloading:'正在下载 ZeroTier',
  verifying:'正在校验安装包',
  replacing:'正在切换 ZeroTier 版本',
  waiting:'等待系统安装完成'
};
let state={phase:'checking'}, installation={phase:'idle'}, timer, checking=false, working=false;

async function call(name,...args) {
  const result=await window.lan[name](...args);
  if(!result.ok) throw new Error(result.error);
  return result.data;
}

function showError(message='') {
  $('startupError').textContent=message;
  $('startupError').hidden=!message;
}

function render() {
  const nickname=state.phase==='nickname';
  if (nickname && $('nicknamePage').hidden) {
    void call('nickname').then(name=>{
      const input=$('startupNickname');
      if (!input.value) input.value=name;
      input.focus();
    }).catch(error=>showError(error.message));
  }
  $('nicknamePage').hidden=!nickname;
  $('servicePage').hidden=nickname;
  if (nickname) return;

  const installing=state.phase==='installing';
  const download=installing && installation.phase==='downloading';
  const waiting=installing && installation.phase==='waiting';
  $('startupTitle').textContent=installing
    ? installTitles[installation.phase] || '正在准备安装 ZeroTier'
    : titles[state.phase];
  const megabytes=bytes=>(bytes/1024/1024).toFixed(1)+' MB';
  const downloadSize=download && installation.received!==undefined
    ? megabytes(installation.received)+(installation.total ? ' / '+megabytes(installation.total) : '')
    : '';
  $('startupMessage').textContent=installing
    ? installation.message || downloadSize || '正在准备官方安装包。'
    : state.message || '检查本机版本和服务状态。';
  const progress=$('startupProgress');
  progress.hidden=state.phase==='error' || waiting;
  if (download && installation.total) progress.value=100*installation.received/installation.total;
  else progress.removeAttribute('value');
  $('startupCancel').hidden=!download;
  $('startupRetry').hidden=state.phase!=='error' && (!waiting || installation.reboot);
  $('startupRetry').textContent=waiting?'安装程序已关闭，重新检查':'重试';
  $('startupRestart').hidden=state.phase!=='connecting';
  $('startupToken').hidden=state.phase!=='error';
}

async function check(retry=false) {
  if (checking || working) return;
  clearTimeout(timer);
  checking=true;
  try {
    state=await call('startupCheck',retry);
  } catch(error) {
    state={phase:'error',message:error.message};
  } finally {
    checking=false;
    render();
    if (!['nickname','error'].includes(state.phase)) timer=setTimeout(check,1500);
  }
}

async function recover(action) {
  if (working) return;
  clearTimeout(timer);
  showError();
  working=true;
  try {
    await action();
  } catch(error) {
    showError(error.message);
  } finally {
    working=false;
    void check(true);
  }
}

window.lan.onStartupProgress(value=>{state=value;render();});
window.lan.onInstallProgress(value=>{installation=value;render();});
$('startupRetry').onclick=()=>{showError();void check(true);};
$('startupCancel').onclick=()=>{
  $('startupCancel').disabled=true;
  void call('cancelDownload').catch(error=>showError(error.message)).finally(()=>{$('startupCancel').disabled=false;});
};
$('startupRestart').onclick=()=>recover(async()=>{
  state={phase:'starting',message:'请留意系统管理员授权。'};
  render();
  await call('restartService');
});
$('tokenForm').onsubmit=event=>{
  event.preventDefault();
  const input=$('tokenValue'), value=input.value;
  input.value='';
  void recover(()=>call('token',value));
};
$('startupNicknameForm').onsubmit=async event=>{
  event.preventDefault();
  const button=$('confirmNickname');
  button.disabled=true;
  showError();
  try {
    await call('confirmStartupNickname',$('startupNickname').value);
  } catch(error) {
    showError(error.message);
    button.disabled=false;
    if(state.phase==='checking') void check();
  }
};
render();
void check();
