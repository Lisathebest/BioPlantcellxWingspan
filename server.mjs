import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRoomService, RoomError } = require('./room-service.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 4173);
const host = '0.0.0.0';
const roomService = createRoomService();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > 220 * 1024) {
        reject(new RoomError(413, 'PAYLOAD_TOO_LARGE', '消息太大，无法发送。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new RoomError(400, 'INVALID_JSON', '请求内容无效。')); }
    });
    req.on('error', reject);
  });
}

async function handleRoom(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, configured: true, backend: 'memory' });
    return true;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: '不支持这个请求方式。' });
    return true;
  }
  try {
    const data = roomService.handle(await readBody(req));
    sendJson(res, 200, { ok: true, ...data });
  } catch (error) {
    const status = Number(error.status) || 500;
    const code = error.code || 'ROOM_SERVICE_ERROR';
    const message = status >= 500 ? '房间服务暂时不可用，请稍后重试。' : error.message;
    if (status >= 500) console.error('[room-api]', error);
    sendJson(res, status, { ok: false, error: code, message });
  }
  return true;
}

function staticPath(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const candidate = path.resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (candidate !== publicDir && !candidate.startsWith(`${publicDir}${path.sep}`)) return null;
  return candidate;
}

function serveStatic(req, res, url) {
  let candidate;
  try { candidate = staticPath(url.pathname); } catch (_) { candidate = null; }
  if (!candidate) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    res.writeHead(200, {
      'Cache-Control': candidate.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': MIME_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream',
    });
    fs.createReadStream(candidate).pipe(res);
    return true;
  }
  // The app is a small SPA. Share links such as /join?room=... should still
  // load the same document while keeping asset paths strict.
  const fallback = path.join(publicDir, 'index.html');
  if (fs.existsSync(fallback)) {
    res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': MIME_TYPES['.html'] });
    fs.createReadStream(fallback).pipe(res);
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/room') {
    await handleRoom(req, res);
    return;
  }
  if (!serveStatic(req, res, url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`Cellworks running on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
