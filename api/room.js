/*
 * Vercel-compatible adapter for the in-process room service.
 * PocketBay runs the same service from server.mjs, which is the preferred
 * deployment for live rooms because one Node process owns the room state.
 */
import roomModule from '../room-service.cjs';

const { createRoomService, RoomError } = roomModule;

const roomService = globalThis.__cellworksRoomService || createRoomService();
globalThis.__cellworksRoomService = roomService;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { throw new RoomError(400, 'INVALID_JSON', '请求内容无效。'); }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > 220 * 1024) throw new RoomError(413, 'PAYLOAD_TOO_LARGE', '消息太大，无法发送。');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw new RoomError(400, 'INVALID_JSON', '请求内容无效。'); }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return send(res, 200, { ok: true, configured: true, backend: 'memory' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: '不支持这个请求方式。' });
  }
  try {
    const data = roomService.handle(await readBody(req));
    return send(res, 200, { ok: true, ...data });
  } catch (error) {
    const status = Number(error.status) || 500;
    const code = error.code || 'ROOM_SERVICE_ERROR';
    const message = status >= 500 ? '房间服务暂时不可用，请稍后重试。' : error.message;
    if (status >= 500) console.error('[room-api]', error);
    return send(res, status, { ok: false, error: code, message });
  }
};

export const _test = { roomService };
