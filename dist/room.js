/* Lightweight no-login room transport for the static Cellworks site. */
(() => {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
      this.peer = null;
      this.role = 'local';
      this.roomCode = '';
      this.maxPlayers = 4;
      this.hostName = '';
      this.hostConnection = null;
      this.connectionTimer = null;
      this.connections = new Map();
      this.players = [];
    }

    emit(name, payload) {
      const callback = this.callbacks[name];
      if (typeof callback === 'function') callback(payload);
    }

    create(hostName, maxPlayers) {
      this.close();
      if (typeof window.Peer !== 'function') {
        this.emit('error', { message: 'PeerJS 尚未加载，请检查网络后重试。' });
        return;
      }
      this.role = 'host';
      this.roomCode = makeRoomCode();
      this.maxPlayers = Math.min(4, Math.max(2, Number(maxPlayers) || 2));
      this.hostName = String(hostName || '房主').trim().slice(0, 16) || '房主';
      this.players = [{ seat: 0, name: this.hostName, connected: true }];
      try {
        this.peer = new window.Peer(`cellworks-${this.roomCode.toLowerCase()}`, { debug: 0 });
      } catch (error) {
        this.emit('error', { message: error?.message || '无法创建房间。' });
        return;
      }
      this.peer.on('open', id => this.emit('hostReady', { roomCode: this.roomCode, peerId: id }));
      this.peer.on('connection', connection => this.attachHostConnection(connection));
      this.peer.on('error', error => this.emit('error', { message: this.peerError(error), error }));
      this.peer.on('disconnected', () => this.emit('status', { message: '房间连接暂时中断，正在重连…' }));
    }

    attachHostConnection(connection) {
      let joinedSeat = null;
      const onData = message => {
        if (!message || typeof message !== 'object') return;
        if (joinedSeat === null && message.type === 'join') {
          const requestedName = String(message.name || '玩家').trim().slice(0, 16) || '玩家';
          const seat = this.findOpenSeat();
          if (seat < 0) {
            this.safeSend(connection, { type: 'room-full' });
            connection.close();
            return;
          }
          joinedSeat = seat;
          this.connections.set(seat, connection);
          this.players[seat] = { seat, name: requestedName, connected: true };
          this.safeSend(connection, { type: 'seat', seat, roomCode: this.roomCode, maxPlayers: this.maxPlayers });
          this.emit('playerJoin', { seat, name: requestedName, connection });
          this.emitLobby();
          return;
        }
        if (joinedSeat !== null) this.emit('message', { message, seat: joinedSeat, connection });
      };
      connection.on('open', () => {});
      connection.on('data', onData);
      connection.on('close', () => {
        if (joinedSeat === null) return;
        this.connections.delete(joinedSeat);
        if (this.players[joinedSeat]) this.players[joinedSeat].connected = false;
        this.emit('playerLeave', { seat: joinedSeat, player: this.players[joinedSeat] });
        this.emitLobby();
      });
      connection.on('error', error => this.emit('error', { message: this.peerError(error), error }));
    }

    findOpenSeat() {
      for (let seat = 1; seat < this.maxPlayers; seat += 1) if (!this.players[seat] || !this.players[seat].connected) return seat;
      return -1;
    }

    join(roomCode, playerName) {
      this.close();
      if (typeof window.Peer !== 'function') {
        this.emit('error', { message: 'PeerJS 尚未加载，请检查网络后重试。' });
        return;
      }
      this.role = 'client';
      this.roomCode = normalizeCode(roomCode);
      this.hostName = String(playerName || '玩家').trim().slice(0, 16) || '玩家';
      if (this.roomCode.length !== 6) {
        this.emit('error', { message: '房间码需要 6 位字母或数字。' });
        return;
      }
      try {
        this.peer = new window.Peer(undefined, { debug: 0 });
      } catch (error) {
        this.emit('error', { message: error?.message || '无法加入房间。' });
        return;
      }
      this.peer.on('open', () => {
        this.hostConnection = this.peer.connect(`cellworks-${this.roomCode.toLowerCase()}`, { reliable: true });
        this.hostConnection.on('open', () => { if (this.connectionTimer) clearTimeout(this.connectionTimer); this.connectionTimer = null; this.safeSend(this.hostConnection, { type: 'join', name: this.hostName }); });
        this.hostConnection.on('data', message => this.emit('message', { message }));
        this.hostConnection.on('close', () => this.emit('disconnected', { message: '房主已离开房间。' }));
        this.hostConnection.on('error', error => this.emit('error', { message: this.peerError(error), error }));
        this.connectionTimer = setTimeout(() => { if (!this.hostConnection?.open) this.emit('error', { message: '连接房间超时，请确认房间码或重试。' }); }, 10000);
      });
      this.peer.on('error', error => this.emit('error', { message: this.peerError(error), error }));
      this.peer.on('disconnected', () => this.emit('status', { message: '房间连接暂时中断，正在重连…' }));
    }

    emitLobby() {
      const lobby = { players: this.players.filter(Boolean).map(player => ({ ...player })), maxPlayers: this.maxPlayers };
      this.emit('lobby', lobby);
      if (this.role === 'host') this.broadcast({ type: 'lobby', ...lobby });
    }

    getLobby() {
      return { players: this.players.filter(Boolean).map(player => ({ ...player })), maxPlayers: this.maxPlayers };
    }

    sendToHost(payload) {
      if (this.role === 'client' && this.hostConnection) this.safeSend(this.hostConnection, payload);
    }

    sendToSeat(seat, payload) {
      const connection = this.connections.get(seat);
      if (connection) this.safeSend(connection, payload);
    }

    broadcast(payload) {
      if (this.role !== 'host') return;
      this.connections.forEach(connection => this.safeSend(connection, payload));
    }

    safeSend(connection, payload) {
      try {
        if (connection && connection.open) connection.send(payload);
      } catch (_) {}
    }

    peerError(error) {
      const type = error?.type || '';
      if (type === 'peer-unavailable' || type === 'server-error') return '找不到这个房间，请确认房间码。';
      if (type === 'unavailable-id') return '这个房间码刚刚被占用，请重新创建。';
      return error?.message || '房间连接失败，请重试。';
    }

    close() {
      this.connections.forEach(connection => { try { connection.close(); } catch (_) {} });
      this.connections.clear();
      if (this.hostConnection) { try { this.hostConnection.close(); } catch (_) {} }
      this.hostConnection = null;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
      if (this.peer) { try { this.peer.destroy(); } catch (_) {} }
      this.peer = null;
      this.role = 'local';
      this.roomCode = '';
      this.players = [];
    }
  }

  window.CellworksRoom = CellworksRoom;
})();
