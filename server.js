/*
 * 오늘의 바리스타 서버 (설치할 패키지 없음, Node 18+)
 *
 *  - 이 폴더의 파일(index.html 등)을 웹으로 보여줘요.
 *  - /ws 로 들어온 사람들을 같은 매장(room)끼리 묶어서
 *    "지금 누가 어디 앉아서 뭘 하는지"를 서로에게 실시간으로 전해줘요.
 *
 *  실행: node server.js   (PORT 환경변수가 없으면 8000번)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};
const PRIVATE = new Set(['server.js', 'index.js', 'package.json', 'render.yaml', '.gitignore']);

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400).end(); return; }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || PRIVATE.has(path.basename(file)) || path.basename(file).startsWith('.')) {
    res.writeHead(404).end('not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file);
    const fresh = ext === '.html' || path.basename(file) === 'sw.js' || path.basename(file) === 'config.js';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* ---------- a minimal WebSocket implementation (RFC 6455, text frames) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function wrap(socket, onText, onClose) {
  let buf = Buffer.alloc(0), parts = [], closed = false;
  const conn = {
    alive: true,
    send(text) { if (!closed && socket.writable) socket.write(frame(0x1, Buffer.from(text))); },
    ping() { if (!closed && socket.writable) socket.write(frame(0x9, Buffer.alloc(0))); },
    close() { if (closed) return; closed = true; try { socket.write(frame(0x8, Buffer.alloc(0))); } catch (e) {} socket.end(); onClose(); },
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) { conn.close(); return; } len = Number(big); off = 10; }
      if (len > MAX_PAYLOAD || !masked) { conn.close(); return; } // browsers always mask
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) { conn.close(); return; }
      if (op === 0x9) { if (socket.writable) socket.write(frame(0xA, data)); continue; }
      if (op === 0xA) { conn.alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        parts.push(data);
        if (parts.reduce((a, b) => a + b.length, 0) > MAX_PAYLOAD) { conn.close(); return; }
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; try { onText(text); } catch (e) { console.error(e); } }
      }
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => { if (!closed) { closed = true; onClose(); } });
  return conn;
}

/* ---------- rooms: who is in which café, and what they are doing ---------- */
const rooms = new Map(); // room -> Map(id -> {conn, state})
const timers = new Map();

function broadcast(roomName) {
  if (timers.has(roomName)) return;
  timers.set(roomName, setTimeout(() => {
    timers.delete(roomName);
    const room = rooms.get(roomName); if (!room) return;
    const all = {}; for (const [id, m] of room) all[id] = m.state;
    const msg = JSON.stringify({ t: 'peers', all });
    for (const m of room.values()) m.conn.send(msg);
  }, 120));
}
const clean = (s, n) => String(s || '').replace(/[^\w가-힣-]/g, '').slice(0, n);

server.on('upgrade', (req, socket) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) {}
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  let me = null; // {room, id}
  const conn = wrap(socket, (text) => {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (m.t === 'join' && !me) {
      const room = clean(m.room, 40) || 'main', id = clean(m.id, 32);
      if (!id) return;
      if (!rooms.has(room)) rooms.set(room, new Map());
      // same browser opened again (new tab, refresh): keep one person, retire the older window
      const prev = rooms.get(room).get(id);
      if (!prev && rooms.get(room).size >= 40) { conn.send(JSON.stringify({ t: 'full' })); conn.close(); return; }
      me = { room, id };
      rooms.get(room).set(id, { conn, state: m.state && typeof m.state === 'object' ? m.state : {} });
      // the new window takes the seat first, then the older one is told to stop
      if (prev && prev.conn !== conn) { prev.conn.send(JSON.stringify({ t: 'replaced' })); prev.conn.close(); }
      broadcast(room);
    } else if (m.t === 'state' && me) {
      const entry = rooms.get(me.room) && rooms.get(me.room).get(me.id);
      if (entry && m.state && typeof m.state === 'object') { entry.state = m.state; broadcast(me.room); }
    }
  }, () => {
    if (!me) return;
    const room = rooms.get(me.room);
    if (room && room.get(me.id) && room.get(me.id).conn === conn) { room.delete(me.id); if (!room.size) rooms.delete(me.room); else broadcast(me.room); }
  });
  conns.add(conn);
  socket.on('close', () => conns.delete(conn));
});

// drop connections that stopped answering (closed laptops, lost Wi-Fi)
const conns = new Set();
setInterval(() => {
  for (const c of conns) { if (!c.alive) { c.close(); conns.delete(c); continue; } c.alive = false; c.ping(); }
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`오늘의 바리스타 열림 → port ${PORT}`));
process.on('uncaughtException', (e) => console.error('오류:', e));
