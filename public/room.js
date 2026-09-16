/* No-login room transport backed by the site's Vercel API and Redis. */
(() => {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const POLL_INTERVAL = 900;
  const API_URL = '/api/room';

  function makeRoomCode() {
    let code = '';
    for (let index = 0; index < 6; index += 1) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
  }

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  class CellworksRoom {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.role = 'local';
      this.roomCode = '';
      this.maxPlayers = 4;
      this.hostName = '';
      this.token = '';
      this.seat = 0;
      this.connections = new Map();
      this.players = [];
      this.pollTimer = null;
      this.polling = false;
      this.closed = false;
      this.failures = 0;
      this.outbound = Promise.resolve();
      this.lobbySignature = '';
    }

    emit(name, payload) {
      const callback = this.callbacks[name];
      if (typeof callback === 'function') callback(payload);
    }

    async request(action, extra = {}, options = {}) {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
        cache: 'no-store',
        keepalive: Boolean(options.keepalive)
      });
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok || !data?.ok) {
        const error = new Error(data?.message || `房间服务请求失败（${response.status}）。`);
        error.code = data?.error || 'ROOM_SERVICE_ERROR';
        throw error;
      }
      return data;
    }

    session() {
      return { code: this.roomCode, seat: this.seat, token: this.token };
    }

    async create(hostName, maxPlayers) {
      this.reset(false);
      this.role = 'host';
      this.maxPlayers = Math.min(4, Math.max(2, Number(maxPlayers) || 2));
      this.hostName = String(hostName || '房主').trim().slice(0, 16) || '房主';
      this.closed = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = makeRoomCode();
        try {
          const data = await this.request('create', { code, name: this.hostName, maxPlayers: this.maxPlayers });
          if (this.closed) return;
          this.roomCode = data.roomCode;
          this.token = data.token;
          this.seat = 0;
          this.applyLobby(data.lobby, true);
          this.emit('hostReady', { roomCode: this.roomCode });
          this.startPolling();
          return;
        } catch (error) {
          if (error.code === 'ROOM_EXISTS') continue;
          this.emit('error', { message: this.friendlyError(error), error });
          return;
        }
      }
      this.emit('error', { message: '暂时无法生成房间码，请重试。' });
    }

    async join(roomCode, playerName) {
      this.reset(false);
      this.role = 'client';
      this.roomCode = normalizeCode(roomCode);
      this.hostName = String(playerName || '玩家').trim().slice(0, 16) || '玩家';
      this.closed = false;
      if (this.roomCode.length !== 6) {
        this.emit('error', { message: '房间码需要 6 位字母或数字。' });
        return;
      }
      try {
        const data = await this.request('join', { code: this.roomCode, name: this.hostName });
        if (this.closed) return;
        this.token = data.token;
        this.seat = data.seat;
        this.maxPlayers = data.lobby?.maxPlayers || 4;
        this.applyLobby(data.lobby, true);
        this.emit('message', { message: { type: 'seat', seat: this.seat, roomCode: this.roomCode, maxPlayers: this.maxPlayers } });
        this.startPolling();
      } catch (error) {
        this.emit('error', { message: this.friendlyError(error), error });
      }
    }

    applyLobby(lobby, force = false) {
      if (!lobby || !Array.isArray(lobby.players)) return;
      this.maxPlayers = Number(lobby.maxPlayers) || this.maxPlayers;
      const nextPlayers = lobby.players.map(player => ({ seat: Number(player.seat), name: String(player.name || '玩家'), connected: player.connected !== false }));
      const signature = JSON.stringify(nextPlayers.map(player => [player.seat, player.name, player.connected]));
      this.players = nextPlayers;
      if (this.role === 'host') {
        this.connections.clear();
        nextPlayers.filter(player => player.seat > 0 && player.connected).forEach(player => this.connections.set(player.seat, true));
      }
      if (force || signature !== this.lobbySignature) {
        this.lobbySignature = signature;
        this.emit('lobby', this.getLobby());
      }
    }

    startPolling() {
      this.stopPolling();
      const schedule = delay => {
        if (!this.closed && this.token) this.pollTimer = setTimeout(() => this.poll(schedule), delay);
      };
      schedule(0);
    }

    async poll(schedule) {
      if (this.polling || this.closed || !this.token) return;
      this.polling = true;
      try {
        const data = await this.request('poll', this.session());
        this.failures = 0;
        this.applyLobby(data.lobby);
        for (const item of data.messages || []) this.handleRelayMessage(item);
        schedule(POLL_INTERVAL);
      } catch (error) {
        this.failures += 1;
        if (['ROOM_NOT_FOUND', 'INVALID_SESSION'].includes(error.code)) {
          this.stopPolling();
          this.emit('disconnected', { message: this.role === 'client' ? '房主已离开，房间已经关闭。' : '房间已失效，请重新创建。' });
        } else {
          if (this.failures === 3) this.emit('status', { message: '网络暂时不稳定，正在重新连接房间…' });
          schedule(Math.min(5000, POLL_INTERVAL * this.failures));
        }
      } finally {
        this.polling = false;
      }
    }

    handleRelayMessage(item) {
      if (!item || typeof item !== 'object') return;
      if (item.kind === 'join' && this.role === 'host') {
        const player = { seat: Number(item.seat), name: String(item.name || '玩家'), connected: true };
        this.emit('playerJoin', { seat: player.seat, name: player.name });
        return;
      }
      if (item.kind === 'leave' && this.role === 'host') {
        const player = { seat: Number(item.seat), name: String(item.name || '玩家'), connected: false };
        this.emit('playerLeave', { seat: player.seat, player });
        return;
      }
      if (item.kind === 'app' && item.payload && typeof item.payload === 'object') {
        this.emit('message', { message: item.payload, seat: Number(item.seat) });
      }
    }

    queue(action, extra = {}) {
      if (this.closed || !this.token) return;
      this.outbound = this.outbound
        .then(() => this.request(action, { ...this.session(), ...extra }))
        .catch(error => {
          if (['ROOM_NOT_FOUND', 'INVALID_SESSION'].includes(error.code)) this.emit('disconnected', { message: '房间连接已经失效。' });
          else this.emit('status', { message: this.friendlyError(error) });
        });
    }

    getLobby() {
      return { players: this.players.map(player => ({ ...player })), maxPlayers: this.maxPlayers };
    }

    sendToHost(payload) {
      if (this.role === 'client') this.queue('send', { payload });
    }

    sendToSeat(seat, payload) {
      if (this.role === 'host') this.queue('send', { target: Number(seat), payload });
    }

    broadcast(payload) {
      if (this.role === 'host') this.queue('broadcast', { payload });
    }

    lock() {
      if (this.role === 'host') this.queue('lock');
    }

    friendlyError(error) {
      if (error?.code === 'ROOM_NOT_FOUND') return '找不到这个房间，请确认房间码。';
      if (error?.code === 'ROOM_FULL') return '房间人数已满。';
      if (error?.code === 'ROOM_STARTED') return '游戏已经开始，无法再加入这个房间。';
      return error?.message || '房间连接失败，请重试。';
    }

    stopPolling() {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    reset(notify = true) {
      this.stopPolling();
      if (notify && this.token && this.roomCode) {
        const body = JSON.stringify({ action: 'leave', ...this.session() });
        let sent = false;
        try {
          if (navigator.sendBeacon) sent = navigator.sendBeacon(API_URL, new Blob([body], { type: 'application/json' }));
        } catch (_) {}
        if (!sent) fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
      }
      this.closed = true;
      this.role = 'local';
      this.roomCode = '';
      this.token = '';
      this.seat = 0;
      this.players = [];
      this.connections.clear();
      this.lobbySignature = '';
      this.failures = 0;
      this.polling = false;
      this.outbound = Promise.resolve();
    }

    close() {
      this.reset(true);
    }
  }

  window.CellworksRoom = CellworksRoom;
})();
