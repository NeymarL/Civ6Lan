class RoomDiscovery {
  constructor(backend) {
    this.backend = backend;
  }

  useRoom(id) {
    if (id === this.roomId) return;
    this.pending?.abort();
    this.pending = undefined;
    this.roomId = id;
    this.attempted = false;
    this.error = undefined;
  }

  async update(room, network, autoStart) {
    const id = room?.id;
    this.useRoom(id);
    const state = await this.backend.update(room, network);
    if (id !== this.roomId) return state;
    if (autoStart && id && state.available && !state.active && !this.attempted) {
      void this.enable(network, id).catch(()=>{});
    }
    return {...state, starting:Boolean(this.pending), error:this.error};
  }

  async enable(network, id) {
    this.useRoom(id);
    if (this.pending) throw new Error('正在等待系统授权。');
    const controller = new AbortController();
    this.pending = controller;
    this.attempted = true;
    this.error = undefined;
    try {
      return await this.backend.enable(network,id,controller.signal);
    } catch (error) {
      if (this.pending === controller) this.error = error.message;
      throw error;
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  async disable() {
    this.attempted = true;
    this.error = undefined;
    this.pending?.abort();
    this.pending = undefined;
    await this.backend.disable();
  }
}

module.exports = {RoomDiscovery};
