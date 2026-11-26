const {ZEROTIER_VERSION} = require('./installer');
const {relayState} = require('./enhanced-connection');

function isConnected(status) {
  return status.version===ZEROTIER_VERSION && (status.online===true || relayState(status).active);
}

class Startup {
  constructor(dependencies) {
    this.dependencies = dependencies;
    this.state = {phase:'checking'};
  }

  show(phase, message) {
    this.state = {phase,message};
    this.dependencies.onState?.(this.state);
    return this.state;
  }

  check(retry = false) {
    if (this.pending) return this.pending;
    if (this.state.phase==='error' && !retry) return this.state;
    if (retry) {
      this.startedAt = undefined;
      this.authorizationRequested = false;
    }
    this.pending = this.advance(retry)
      .catch(error=>this.show('error',error.message))
      .finally(()=>{this.pending=undefined;});
    return this.pending;
  }

  async advance(retry) {
    const {readStatus, installedVersion, installation, install, resetInstallation, start, authorize} = this.dependencies;
    let status, failure;
    try { status=await readStatus(); } catch (error) { failure=error; }
    if (status && isConnected(status)) return this.show('nickname');

    const installing = installation();
    if (installing.reboot) return this.show('installing');
    const version = status?.version || await installedVersion();
    if (version!==ZEROTIER_VERSION) {
      if (installing.phase==='waiting' && !retry) return this.show('installing');
      if (installing.phase==='waiting') resetInstallation();
      this.show('installing');
      await install(version);
      return this.state;
    }

    if (status) return this.show('connecting','ZeroTier 已启动，正在等待上线。');
    if (!this.startedAt) {
      this.show('starting','正在启动 ZeroTier。若系统弹出管理员授权，请完成授权。');
      await start();
      this.startedAt = Date.now();
      return this.state;
    }
    if (['ZT_AUTH','ZT_TOKEN_MISSING'].includes(failure?.code) && !this.authorizationRequested) {
      this.show('authorizing','正在连接本机 ZeroTier 服务。请留意系统授权提示。');
      this.authorizationRequested = true;
      await authorize();
      return this.state;
    }
    if (Date.now()-this.startedAt<15000) return this.show('connecting','正在检测本机 ZeroTier 服务。');
    return this.show('error',failure?.message || '暂时无法连接本机 ZeroTier 服务，请重试。');
  }
}

module.exports = {Startup,isConnected};
