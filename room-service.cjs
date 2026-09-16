const crypto = require('crypto');

const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_PLAYERS = 4;
const MAX_MESSAGE_BYTES = 220 * 1024;

class RoomError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    this.code = code;
  }
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanName(value, fallback = '玩家') {
  return String(value || fallback).trim().slice(0, 16) || fallback;
}

function sessionToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function payloadIsValid(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  try { return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_MESSAGE_BYTES; } catch (_) { return false; }
}

class RoomService {
  constructor() {
    this.rooms = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.expiresAt <= now) this.rooms.delete(code);
    }
  }

  touch(room) {
    room.expiresAt = Date.now() + ROOM_TTL_MS;
  }

  room(code) {
    this.cleanup();
    const room = this.rooms.get(cleanCode(code));
    if (!room) throw new RoomError(404, 'ROOM_NOT_FOUND', '找不到这个房间，请确认分享链接仍然有效。');
    this.touch(room);
    return room;
  }

  lobby(room) {
    const players = [{ seat: 0, name: room.hostName, connected: true }];
    for (let seat = 1; seat < room.maxPlayers; seat += 1) {
      const player = room.players.get(seat);
      if (player) players.push({ seat, name: player.name, connected: player.connected !== false });
    }
    return { players, maxPlayers: room.maxPlayers };
  }

  inbox(room, seat) {
    if (!room.inboxes.has(seat)) room.inboxes.set(seat, []);
    return room.inboxes.get(seat);
  }

  enqueue(room, seat, message) {
    const queue = this.inbox(room, seat);
    queue.push(message);
    // A disconnected client should not be able to grow a room indefinitely.
    if (queue.length > 500) queue.splice(0, queue.length - 500);
  }

  authenticate(body) {
    const code = cleanCode(body.code);
    const seat = Number(body.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_PLAYERS || !body.token) {
      throw new RoomError(401, 'INVALID_SESSION', '房间连接已失效，请重新加入。');
    }
    const room = this.room(code);
    if (seat === 0) {
      if (room.token !== body.token) throw new RoomError(401, 'INVALID_SESSION', '房间连接已失效，请重新创建房间。');
      return { room, player: { seat: 0, name: room.hostName, connected: true } };
    }
    const player = room.players.get(seat);
    if (!player || player.token !== body.token) throw new RoomError(401, 'INVALID_SESSION', '房间连接已失效，请重新加入。');
    player.connected = true;
    player.lastSeen = Date.now();
    return { room, player };
  }

  create(body) {
    const code = cleanCode(body.code);
    if (code.length !== 6) throw new RoomError(400, 'INVALID_ROOM_CODE', '房间标识需要 6 位字母或数字。');
    if (this.rooms.has(code)) throw new RoomError(409, 'ROOM_EXISTS', '这个房间标识刚被占用，请重试。');
    const maxPlayers = Math.min(MAX_PLAYERS, Math.max(2, Number(body.maxPlayers) || 2));
    const room = {
      code,
      token: sessionToken(),
      maxPlayers,
      hostName: cleanName(body.name, '房主'),
      locked: false,
      players: new Map(),
      inboxes: new Map(),
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL_MS,
    };
    this.rooms.set(code, room);
    return { roomCode: code, token: room.token, seat: 0, lobby: this.lobby(room) };
  }

  join(body) {
    const code = cleanCode(body.code);
    if (code.length !== 6) throw new RoomError(400, 'INVALID_ROOM_CODE', '房间标识需要 6 位字母或数字。');
    const room = this.room(code);
    if (room.locked) throw new RoomError(409, 'ROOM_STARTED', '游戏已经开始，无法再加入这个房间。');
    const name = cleanName(body.name, '玩家');
    let seat = -1;
    for (let candidate = 1; candidate < room.maxPlayers; candidate += 1) {
      if (!room.players.has(candidate)) { seat = candidate; break; }
    }
    if (seat < 0) throw new RoomError(409, 'ROOM_FULL', '房间人数已满。');
    const player = { seat, token: sessionToken(), name, connected: true, joinedAt: Date.now(), lastSeen: Date.now() };
    room.players.set(seat, player);
    this.enqueue(room, 0, { kind: 'join', seat, name });
    this.touch(room);
    return { roomCode: code, token: player.token, seat, lobby: this.lobby(room) };
  }

  poll(body) {
    const { room, player } = this.authenticate(body);
    const queue = this.inbox(room, player.seat);
    const messages = queue.splice(0, queue.length);
    this.touch(room);
    return { messages, lobby: this.lobby(room), player: { seat: player.seat, name: player.name } };
  }

  send(body) {
    const { room, player } = this.authenticate(body);
    if (!payloadIsValid(body.payload)) throw new RoomError(400, 'INVALID_MESSAGE', '消息内容无效或太大。');
    const target = player.seat === 0 ? Number(body.target) : 0;
    if (!Number.isInteger(target) || target < 0 || target >= MAX_PLAYERS || target === player.seat) {
      throw new RoomError(400, 'INVALID_TARGET', '消息接收者无效。');
    }
    if (target > 0 && !room.players.has(target)) return { delivered: false };
    this.enqueue(room, target, { kind: 'app', seat: player.seat, payload: body.payload });
    return { delivered: true };
  }

  broadcast(body) {
    const { room, player } = this.authenticate(body);
    if (player.seat !== 0) throw new RoomError(403, 'HOST_ONLY', '只有房主可以广播消息。');
    if (!payloadIsValid(body.payload)) throw new RoomError(400, 'INVALID_MESSAGE', '消息内容无效或太大。');
    let delivered = 0;
    for (const [seat, participant] of room.players) {
      if (participant.connected === false) continue;
      this.enqueue(room, seat, { kind: 'app', seat: 0, payload: body.payload });
      delivered += 1;
    }
    return { delivered };
  }

  lock(body) {
    const { room, player } = this.authenticate(body);
    if (player.seat !== 0) throw new RoomError(403, 'HOST_ONLY', '只有房主可以开始游戏。');
    room.locked = true;
    this.touch(room);
    return { locked: true };
  }

  leave(body) {
    const { room, player } = this.authenticate(body);
    if (player.seat === 0) {
      this.rooms.delete(room.code);
      return { closed: true };
    }
    room.players.delete(player.seat);
    room.inboxes.delete(player.seat);
    this.enqueue(room, 0, { kind: 'leave', seat: player.seat, name: player.name });
    this.touch(room);
    return { left: true };
  }

  handle(body = {}) {
    switch (body.action) {
      case 'create': return this.create(body);
      case 'join': return this.join(body);
      case 'poll': return this.poll(body);
      case 'send': return this.send(body);
      case 'broadcast': return this.broadcast(body);
      case 'lock': return this.lock(body);
      case 'leave': return this.leave(body);
      default: throw new RoomError(400, 'INVALID_ACTION', '未知的房间操作。');
    }
  }
}

function createRoomService() {
  return new RoomService();
}

module.exports = { RoomError, RoomService, cleanCode, cleanName, createRoomService };
