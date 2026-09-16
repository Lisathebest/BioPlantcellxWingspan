const crypto = require('crypto');

const ROOM_TTL_SECONDS = 4 * 60 * 60;
const MAX_BODY_BYTES = 220 * 1024;
const ROOM_PREFIX = 'cellworks:room:';

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redis(command) {
  const config = redisConfig();
  if (!config) throw Object.assign(new Error('Redis is not configured.'), { code: 'REDIS_NOT_CONFIGURED' });
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`Redis request failed (${response.status}).`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function pipeline(commands) {
  const config = redisConfig();
  if (!config) throw Object.assign(new Error('Redis is not configured.'), { code: 'REDIS_NOT_CONFIGURED' });
  const response = await fetch(`${config.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error(`Redis request failed (${response.status}).`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Redis returned an invalid response.');
  const failure = data.find(item => item?.error);
  if (failure) throw new Error(failure.error);
  return data.map(item => item?.result);
}

function roomKey(code) { return `${ROOM_PREFIX}${code}`; }
function seatKey(code, seat) { return `${ROOM_PREFIX}${code}:seat:${seat}`; }
function inboxKey(code, seat) { return `${ROOM_PREFIX}${code}:inbox:${seat}`; }
function cleanCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
function cleanName(value, fallback) { return String(value || fallback).trim().slice(0, 16) || fallback; }
function parseJson(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}
function sessionToken() { return crypto.randomBytes(24).toString('base64url'); }

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw fail(413, 'PAYLOAD_TOO_LARGE', '消息太大，无法发送。');
    try { return JSON.parse(req.body); } catch (_) { throw fail(400, 'INVALID_JSON', '请求内容无效。'); }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw fail(413, 'PAYLOAD_TOO_LARGE', '消息太大，无法发送。');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw fail(400, 'INVALID_JSON', '请求内容无效。'); }
}

async function readRoom(code) {
  const room = parseJson(await redis(['GET', roomKey(code)]));
  if (!room) throw fail(404, 'ROOM_NOT_FOUND', '找不到这个房间，请确认房间码。');
  return room;
}

async function authenticate(code, seat, token) {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3 || !token) throw fail(401, 'INVALID_SESSION', '房间连接已失效，请重新加入。');
  const room = await readRoom(code);
  if (seat === 0) {
    if (room.token !== token) throw fail(401, 'INVALID_SESSION', '房间连接已失效，请重新创建房间。');
    return { room, player: { seat: 0, name: room.hostName, connected: true } };
  }
  const player = parseJson(await redis(['GET', seatKey(code, seat)]));
  if (!player || player.token !== token) throw fail(401, 'INVALID_SESSION', '房间连接已失效，请重新加入。');
  return { room, player };
}

async function getLobby(code, room) {
  const values = await redis(['MGET', seatKey(code, 1), seatKey(code, 2), seatKey(code, 3)]);
  const players = [{ seat: 0, name: room.hostName, connected: true }];
  (Array.isArray(values) ? values : []).forEach(value => {
    const player = parseJson(value);
    if (player) players.push({ seat: player.seat, name: player.name, connected: true });
  });
  players.sort((a, b) => a.seat - b.seat);
  return { players, maxPlayers: room.maxPlayers };
}

async function enqueue(code, seat, message) {
  const key = inboxKey(code, seat);
  await pipeline([
    ['RPUSH', key, JSON.stringify(message)],
    ['EXPIRE', key, ROOM_TTL_SECONDS]
  ]);
}

async function handleCreate(body) {
  const code = cleanCode(body.code);
  if (code.length !== 6) throw fail(400, 'INVALID_ROOM_CODE', '房间码需要 6 位字母或数字。');
  const maxPlayers = Math.min(4, Math.max(2, Number(body.maxPlayers) || 2));
  const hostName = cleanName(body.name, '房主');
  const token = sessionToken();
  const room = { token, maxPlayers, hostName, createdAt: Date.now(), locked: false };
  const created = await redis(['SET', roomKey(code), JSON.stringify(room), 'NX', 'EX', ROOM_TTL_SECONDS]);
  if (created !== 'OK') throw fail(409, 'ROOM_EXISTS', '这个房间码刚被占用，请重试。');
  return { roomCode: code, token, seat: 0, lobby: await getLobby(code, room) };
}

async function handleJoin(body) {
  const code = cleanCode(body.code);
  if (code.length !== 6) throw fail(400, 'INVALID_ROOM_CODE', '房间码需要 6 位字母或数字。');
  const room = await readRoom(code);
  if (room.locked) throw fail(409, 'ROOM_STARTED', '游戏已经开始，无法再加入这个房间。');
  const name = cleanName(body.name, '玩家');
  let joined = null;
  for (let seat = 1; seat < room.maxPlayers; seat += 1) {
    const token = sessionToken();
    const player = { token, seat, name, connected: true, joinedAt: Date.now() };
    const reserved = await redis(['SET', seatKey(code, seat), JSON.stringify(player), 'NX', 'EX', ROOM_TTL_SECONDS]);
    if (reserved === 'OK') { joined = player; break; }
  }
  if (!joined) throw fail(409, 'ROOM_FULL', '房间人数已满。');
  await enqueue(code, 0, { kind: 'join', seat: joined.seat, name: joined.name });
  return { roomCode: code, token: joined.token, seat: joined.seat, lobby: await getLobby(code, room) };
}

async function handlePoll(body) {
  const code = cleanCode(body.code);
  const seat = Number(body.seat);
  const { room, player } = await authenticate(code, seat, body.token);
  const popScript = "local v=redis.call('LRANGE',KEYS[1],0,-1); redis.call('DEL',KEYS[1]); return v";
  const commands = [
    ['EVAL', popScript, '1', inboxKey(code, seat)],
    ['EXPIRE', roomKey(code), ROOM_TTL_SECONDS]
  ];
  if (seat > 0) commands.push(['EXPIRE', seatKey(code, seat), ROOM_TTL_SECONDS]);
  const results = await pipeline(commands);
  const messages = (Array.isArray(results[0]) ? results[0] : []).map(parseJson).filter(Boolean);
  return { messages, lobby: await getLobby(code, room), player: { seat: player.seat, name: player.name } };
}

async function handleSend(body) {
  const code = cleanCode(body.code);
  const seat = Number(body.seat);
  await authenticate(code, seat, body.token);
  if (!body.payload || typeof body.payload !== 'object') throw fail(400, 'INVALID_MESSAGE', '消息内容无效。');
  const target = seat === 0 ? Number(body.target) : 0;
  if (!Number.isInteger(target) || target < 0 || target > 3 || target === seat) throw fail(400, 'INVALID_TARGET', '消息接收者无效。');
  if (seat === 0 && !parseJson(await redis(['GET', seatKey(code, target)]))) return { delivered: false };
  await enqueue(code, target, { kind: 'app', seat, payload: body.payload });
  return { delivered: true };
}

async function handleBroadcast(body) {
  const code = cleanCode(body.code);
  const seat = Number(body.seat);
  const { room } = await authenticate(code, seat, body.token);
  if (seat !== 0) throw fail(403, 'HOST_ONLY', '只有房主可以广播消息。');
  if (!body.payload || typeof body.payload !== 'object') throw fail(400, 'INVALID_MESSAGE', '消息内容无效。');
  const lobby = await getLobby(code, room);
  const targets = lobby.players.filter(player => player.seat > 0);
  await Promise.all(targets.map(player => enqueue(code, player.seat, { kind: 'app', seat: 0, payload: body.payload })));
  return { delivered: targets.length };
}

async function handleLock(body) {
  const code = cleanCode(body.code);
  const seat = Number(body.seat);
  const { room } = await authenticate(code, seat, body.token);
  if (seat !== 0) throw fail(403, 'HOST_ONLY', '只有房主可以开始游戏。');
  room.locked = true;
  await redis(['SET', roomKey(code), JSON.stringify(room), 'XX', 'EX', ROOM_TTL_SECONDS]);
  return { locked: true };
}

async function handleLeave(body) {
  const code = cleanCode(body.code);
  const seat = Number(body.seat);
  const { room, player } = await authenticate(code, seat, body.token);
  if (seat === 0) {
    const keys = [roomKey(code)];
    for (let index = 0; index < room.maxPlayers; index += 1) keys.push(seatKey(code, index), inboxKey(code, index));
    await redis(['DEL', ...keys]);
    return { closed: true };
  }
  await pipeline([
    ['DEL', seatKey(code, seat)],
    ['DEL', inboxKey(code, seat)]
  ]);
  await enqueue(code, 0, { kind: 'leave', seat, name: player.name });
  return { left: true };
}

async function route(body) {
  switch (body.action) {
    case 'create': return handleCreate(body);
    case 'join': return handleJoin(body);
    case 'poll': return handlePoll(body);
    case 'send': return handleSend(body);
    case 'broadcast': return handleBroadcast(body);
    case 'lock': return handleLock(body);
    case 'leave': return handleLeave(body);
    default: throw fail(400, 'INVALID_ACTION', '未知的房间操作。');
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return send(res, 200, { ok: true, configured: Boolean(redisConfig()) });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: '不支持这个请求方式。' });
  }
  try {
    const body = await readBody(req);
    const data = await route(body);
    return send(res, 200, { ok: true, ...data });
  } catch (error) {
    const status = Number(error.status) || (error.code === 'REDIS_NOT_CONFIGURED' ? 503 : 500);
    const code = error.code || 'ROOM_SERVICE_ERROR';
    const message = error.code === 'REDIS_NOT_CONFIGURED' ? '房间服务尚未配置，请联系网站管理员。' : (status >= 500 ? '房间服务暂时不可用，请稍后重试。' : error.message);
    if (status >= 500) console.error('[room-api]', error);
    return send(res, status, { ok: false, error: code, message });
  }
};

module.exports._test = { cleanCode, cleanName, parseJson, route, redisConfig };
