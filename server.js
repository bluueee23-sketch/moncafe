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
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg',
};
const PRIVATE = new Set(['stats.json', 'server.js', 'index.js', 'package.json', 'render.yaml', '.gitignore']);

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400).end(); return; }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  if (p === '/stats') {
    // 이용 지표. STATS_KEY 환경변수를 정해 두면 /stats?key=그값 으로만 볼 수 있어요
    let key = ''; try { key = new URL(req.url, 'http://x').searchParams.get('key') || ''; } catch (e) {}
    if (process.env.STATS_KEY && key !== process.env.STATS_KEY) { res.writeHead(403).end('forbidden'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(statsReport(), null, 2)); return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || PRIVATE.has(path.basename(file)) || path.basename(file).startsWith('.')) {
    res.writeHead(404).end('not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file);
    if (path.basename(file) === 'index.html') data = Buffer.from(previewTags(data.toString('utf8'), req));
    const fresh = ext === '.html' || path.basename(file) === 'sw.js' || path.basename(file) === 'config.js';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* 카톡 등에 초대 링크를 붙이면 "○○ 매장에 알바생으로 초대됐어요" 미리보기가 뜨게 해요 */
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function previewTags(html, req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  const host = String(req.headers.host || '').replace(/[^\w.:-]/g, '');
  html = html.replace('content="/og.png"', `content="${proto}://${host}/og.png"`);
  let room = ''; try { room = clean(new URL(req.url, 'http://x').searchParams.get('room'), 40); } catch (e) {}
  const meta = room && metas.get(room);
  if (meta) {
    html = html.replace('<meta property="og:title" content="오늘의 바리스타">', `<meta property="og:title" content="${escHtml(meta.title)}에 알바생으로 초대됐어요 ☕">`)
      .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escHtml((meta.ownerName ? '점장 ' + meta.ownerName + '님의 매장 · ' : '') + '내가 만든 커피 한 잔 들고 같이 출근해서 공부해요')}">`);
  }
  return html;
}

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


/* ---------- the shared café world: AI guests and the shop cat, the same for everyone in a room ---------- */
const SEATS = 12;
const NPC_POOL = [
  { name: '단골 하은', look: { h: 1, hc: 1, sc: 1, pc: 1, sk: 0, ts: 2, ac: 6, ey: 0 }, d: 'vl', lines: ['오늘도 바닐라 라떼 최고', '과제 마감 3시간 전…', '여기 노래 좋다'] },
  { name: '대학생', look: { h: 0, hc: 0, sc: 5, pc: 2, sk: 1, ts: 1, ac: 1, ey: 1 }, d: 'ia', lines: ['밤샐 각이다', '이 단원만 끝내자…', '커피 수혈 완료'] },
  { name: '직장인', look: { h: 0, hc: 1, sc: 0, pc: 2, sk: 0, ts: 3, ac: 0, ey: 0 }, d: 'ha', lines: ['회의 10분 전', '메일 37개…', '잠깐만 쉬자'] },
  { name: '작가님', look: { h: 7, hc: 0, sc: 6, pc: 3, sk: 0, ts: 0, ac: 3, ey: 1 }, d: 'cb', lines: ['한 문장만 더', '영감이 안 와', '콘센트 명당 찾음'] },
  { name: '산책 손님', look: { h: 6, hc: 3, sc: 4, pc: 0, sk: 1, ts: 2, ac: 2, ey: 0 }, d: 'le', lines: ['댕댕이가 밖에서 기다려요', '레몬에이드 상큼해', '날씨 좋다'] },
  { name: '첫 손님', look: { h: 5, hc: 2, sc: 7, pc: 1, sk: 2, ts: 0, ac: 0, ey: 0 }, d: 'ml', lines: ['여기 분위기 좋네요', '말차 진하다!', '또 와야지'] },
  { name: '헤드폰 손님', look: { h: 0, hc: 6, sc: 2, pc: 2, sk: 0, ts: 1, ac: 4, ey: 1 }, d: 'es', lines: ['노동요 재생 중', '집중 모드 ON', '…'] },
  { name: '뜨개 할머니', look: { h: 3, hc: 7, sc: 3, pc: 3, sk: 1, ts: 2, ac: 1, ey: 0 }, d: 'hc', lines: ['손녀 목도리 뜨는 중', '핫초코가 달달하네', '젊은이 화이팅'] },
  { name: '진돌이 팬', look: { h: 4, hc: 5, sc: 0, pc: 1, sk: 0, ts: 0, ac: 5, ey: 2 }, d: 'cl', lines: ['진돌이 언제 와요?', '광고 보고 왔어요', '냥냥'] },
];
const DRINKS = new Set(['ia', 'ha', 'cl', 'vl', 'ml', 'es', 'cb', 'le', 'hc', 'jc']);
const CAT_LINES = ['냐옹', '츄르 줘', '골골골…', '공부해라냥', '(빤히)', '냥?', '꾹꾹이 중'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const worlds = new Map();
const chats = new Map(); // room -> recent speech bubbles [{id, name, t, at}]

/* ---------- 매장 정보(이름, 점장, 주간 목표)와 알바생 명부(이번 주 근무 기록) ----------
   서버가 잠들면 사라지지만, 각자 브라우저가 사본을 갖고 있다가 다시 들어올 때 돌려줘요(채팅과 같은 방식) */
const metas = new Map();   // room -> {title, owner, ownerName, goal, at}
const rosters = new Map(); // room -> Map(id -> {id, name, look, wk, seen})
const GOALS = new Set([0, 5, 10, 15, 20, 25, 30, 40]);
const cleanTitle = (t) => String(t || '').replace(/[<>&"\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanName = (t) => String(t || '').replace(/[<>&"\\]/g, '').trim().slice(0, 12);
function validWk(w) {
  if (!w || typeof w !== 'object' || typeof w.k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.k) || !Array.isArray(w.m) || w.m.length !== 7) return null;
  const m = w.m.map((x) => Math.max(0, Math.min(1440, Math.round(+x || 0))));
  const s = Array.isArray(w.s) && w.s.length === 7 ? w.s.map((x) => (x ? 1 : 0)) : m.map((x) => (x > 0 ? 1 : 0));
  return { k: w.k, m, s };
}
function validLook(l) {
  if (!l || typeof l !== 'object') return null;
  const o = {}; for (const k of Object.keys(l).slice(0, 16)) if (/^\w{1,4}$/.test(k) && Number.isInteger(l[k]) && l[k] >= 0 && l[k] < 64) o[k] = l[k];
  return o;
}
function metaMsg(room) { return JSON.stringify({ t: 'meta', meta: metas.get(room) || null }); }
function rosterMsg(room) { const r = rosters.get(room); return JSON.stringify({ t: 'roster', list: r ? [...r.values()] : [] }); }
function toRoom(room, msg) { for (const x of (rooms.get(room) || new Map()).values()) x.conn.send(msg); }
const rosterTimers = new Map();
function broadcastRoster(room) {
  if (rosterTimers.has(room)) return;
  rosterTimers.set(room, setTimeout(() => { rosterTimers.delete(room); toRoom(room, rosterMsg(room)); }, 1500));
}
function pruneRoster(r) {
  const now = Date.now();
  for (const [id, e] of r) if (now - e.seen > 35 * 864e5) r.delete(id);
  if (r.size > 60) [...r.values()].sort((a, b) => a.seen - b.seen).slice(0, r.size - 60).forEach((e) => r.delete(e.id));
}
function touchRoster(room, id, st) {
  if (room === 'main') return; // 공개 매장은 명부를 안 남겨요
  if (!rosters.has(room)) rosters.set(room, new Map());
  const r = rosters.get(room), prev = r.get(id), wk = validWk(st.wk) || (prev && prev.wk) || null;
  const e = { id, name: cleanName(st.nick) || (prev && prev.name) || '', look: validLook(st.look) || (prev && prev.look) || null, wk, seen: Date.now() };
  const changed = !prev || prev.name !== e.name || JSON.stringify(prev.look) !== JSON.stringify(e.look) || JSON.stringify(prev.wk) !== JSON.stringify(e.wk);
  r.set(id, e); pruneRoster(r);
  if (changed) broadcastRoster(room);
}

/* ---------- 이용 지표 (/stats) ----------
   이름이나 대화 내용은 안 남기고 숫자만 세요. 날짜는 한국 시간 기준.
   data/stats.json 에도 저장하지만, Render 무료 플랜은 재배포하면 파일이 지워져요 */
const STATS_FILE = path.join(ROOT, 'data', 'stats.json');
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const EVENTS = new Set(['create', 'invite', 'card', 'autobrew', 'roster', 'member_view', 'member_want', 'price_0', 'price_1900', 'price_2900', 'price_4900']);
let stats = { days: {}, devices: {}, stores: {} }; // devices: id -> [첫날, 마지막날], stores: room -> {made, last, members}
try { stats = Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch (e) {}
function statDay(d = kstDay()) {
  if (!stats.days[d]) stats.days[d] = { dev: [], stores: [], ev: {}, focus: 0 };
  const keys = Object.keys(stats.days).sort(); while (keys.length > 120) delete stats.days[keys.shift()];
  return stats.days[d];
}
const addOnce = (arr, v) => { if (v && !arr.includes(v) && arr.length < 5000) arr.push(v); };
function statSeen(room, id) {
  const d = kstDay(), sd = statDay(d); addOnce(sd.dev, id);
  const dv = stats.devices[id]; stats.devices[id] = [dv ? dv[0] : d, d];
  if (room !== 'main') {
    addOnce(sd.stores, room);
    const s = stats.stores[room] || (stats.stores[room] = { made: d, last: d, members: [] });
    s.last = d; addOnce(s.members, id);
  }
  statsDirty = true;
}
function statEvent(e) { if (!EVENTS.has(e)) return; const sd = statDay(); sd.ev[e] = (sd.ev[e] || 0) + 1; statsDirty = true; }
const lastFocus = new Map(); // id -> 오늘 공부한 분 (presence에서 늘어난 만큼만 더해요)
function statFocus(id, st) {
  const f = Math.max(0, Math.min(1440, Math.round(+st.focus || 0))), k = id + '|' + kstDay(), prev = lastFocus.get(k);
  if (prev != null && f > prev) { statDay().focus += f - prev; statsDirty = true; }
  lastFocus.set(k, prev == null ? f : Math.max(prev, f));
  if (lastFocus.size > 5000) lastFocus.clear();
}
let statsDirty = false;
setInterval(() => {
  if (!statsDirty) return; statsDirty = false;
  fs.mkdir(path.dirname(STATS_FILE), { recursive: true }, () => fs.writeFile(STATS_FILE, JSON.stringify(stats), () => {}));
}, 60000);
function statsReport() {
  const today = kstDay(), ago = (n) => kstDay(Date.now() - n * 864e5);
  const days = Object.keys(stats.days).sort().slice(-14).reverse().map((d) => {
    const x = stats.days[d]; return { 날짜: d, 방문자: x.dev.length, 출근한매장: x.stores.length, 공부한시간: Math.round(x.focus / 6) / 10, 행동: x.ev };
  });
  const devs = Object.values(stats.devices), stores = Object.entries(stats.stores);
  // 일주일 전에 처음 온 사람 중에서 그 뒤로 다시 온 사람 비율
  const cohort = devs.filter(([a]) => a <= ago(7)), back = cohort.filter(([a, b]) => b > a);
  const total = (e) => Object.values(stats.days).reduce((s, x) => s + (x.ev[e] || 0), 0);
  return {
    지금: { 접속자: [...rooms.values()].reduce((s, r) => s + r.size, 0), 열린매장: [...rooms.keys()].filter((k) => k !== 'main').length },
    누적: {
      방문자: devs.length, 매장: stores.length,
      '7일 안에 출근한 매장': stores.filter(([, s]) => s.last >= ago(6)).length,
      '2명 이상 매장': stores.filter(([, s]) => s.members.length >= 2).length,
      '일주일 뒤에도 살아있는 매장': stores.filter(([, s]) => s.made <= ago(7) && s.last >= ago(6)).length + ' / ' + stores.filter(([, s]) => s.made <= ago(7)).length,
      '재방문율(7일 이상 된 사람)': cohort.length ? Math.round((back.length / cohort.length) * 100) + '%' : '아직 데이터 부족',
    },
    '점장 멤버십 수요': {
      '소개를 본 점장': total('member_view'), '쓸래요': total('member_want'),
      '낼 수 있는 가격': { '1,900원': total('price_1900'), '2,900원': total('price_2900'), '4,900원': total('price_4900'), '무료면 쓸래요': total('price_0') },
    },
    최근14일: days, 기준: today + ' (한국 시간)',
  };
}

/* ---------- 슬립 방지 ----------
   Render 무료 플랜은 15분 동안 아무 요청이 없으면 잠들어요. 10분마다 내 주소로 노크해서 깨어 있게 해요.
   (무료 시간이 한 달 750시간이라 서비스 하나는 하루 종일 켜 둬도 돼요. KEEPALIVE=0 이면 꺼요) */
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL && process.env.KEEPALIVE !== '0' && typeof fetch === 'function') {
  setInterval(() => { fetch(SELF_URL.replace(/\/$/, '') + '/healthz').catch(() => {}); }, 10 * 60 * 1000);
}

function getWorld(room) {
  if (!worlds.has(room)) {
    const now = Date.now();
    worlds.set(room, { npcs: [], seeded: false,
      cat: { mode: 'sit', at: { u: 0.35, v: 0.4 }, dur: 0, until: now + 4000, say: null, likes: {}, fav: null, v: 1 } });
  }
  return worlds.get(room);
}
// the same seating rule the page uses: people first, sorted by id, then AI guests
function humanSeats(room) {
  const members = [...(rooms.get(room) || new Map()).entries()]
    .filter(([, m]) => !(m.state && (m.state.st === 'making' || m.state.st === 'done')))
    .sort((a, b) => {
      const v = (m) => (Number.isInteger(m.state && m.state.seat) && m.state.seat >= 0 && m.state.seat < SEATS ? 1 : 0);
      const t = (m) => +(m.state && m.state.sa) || 9e15;
      return (v(b[1]) - v(a[1])) || (t(a[1]) - t(b[1])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });
  const taken = {}, seatOf = {};
  for (const [id, m] of members) {
    let s = Number.isInteger(m.state && m.state.seat) && m.state.seat >= 0 && m.state.seat < SEATS ? m.state.seat : -1;
    if (s < 0 || taken[s] != null) { s = -1; for (let i = 0; i < SEATS; i++) if (taken[i] == null) { s = i; break; } }
    if (s >= 0) { taken[s] = id; seatOf[id] = s; }
  }
  return { taken, seatOf, count: (rooms.get(room) || new Map()).size };
}
function npcSay(n, t) { n.say = { t: String(t || pick(n.lines)).slice(0, 20), at: Date.now() }; }
function spawnNpc(w, name, d) {
  const here = (nm) => w.npcs.some((x) => x.name === nm);
  let p = name ? NPC_POOL.find((x) => x.name === name) : null;
  if (p && here(p.name)) { const n = w.npcs.find((x) => x.name === p.name); n.d = DRINKS.has(d) ? d : n.d; n.left = 1; n.st = 'hold'; n.leaveAt = 0; npcSay(n, '잘 마실게요!'); return; }
  if (!p) { const free = NPC_POOL.filter((x) => !here(x.name)); if (!free.length) return; p = pick(free); }
  const n = { name: p.name, look: p.look, lines: p.lines, d: DRINKS.has(d) ? d : p.d, key: 'npc:' + p.name, left: 1, st: 'hold',
    seat: null, drain: 1 / (240 + Math.random() * 300), say: null, leaveAt: 0 };
  if (Math.random() < 0.35) npcSay(n, '안녕하세요~');
  w.npcs.push(n);
}
function catWalk(cat, to, now) { cat.mode = 'walk'; cat.at = to; cat.dur = 7 + Math.random() * 5; cat.until = now + cat.dur * 1000; cat.v++; }
function catRest(cat, kind, ms, now) { cat.mode = kind; cat.dur = 0; cat.until = now + ms; cat.v++; if (kind === 'sleep') cat.say = { t: 'Zzz…', at: now }; }

function tickWorld(room) {
  const w = getWorld(room), now = Date.now(), { taken, seatOf, count } = humanSeats(room);
  if (!w.seeded) { w.seeded = true; for (let i = 0; i < 3; i++) spawnNpc(w); w.npcs.forEach((n) => { n.left = 0.45 + Math.random() * 0.55; n.say = null; }); }
  // seats: people always win; a guest in the way moves somewhere free (or leaves)
  for (const n of w.npcs) {
    if (n.leaveAt && n.st === 'finished' && n.seat == null) continue;
    const clash = n.seat == null || taken[n.seat] != null || w.npcs.some((o) => o !== n && o.seat === n.seat);
    if (!clash) continue;
    const used = new Set([...Object.keys(taken).map(Number), ...w.npcs.filter((o) => o !== n && o.seat != null).map((o) => o.seat)]);
    const free = []; for (let i = 0; i < SEATS; i++) if (!used.has(i)) free.push(i);
    const had = n.seat != null;
    if (free.length) { n.seat = pick(free); if (had) npcSay(n, '자리 비켜드릴게요'); } else { n.seat = null; n.leaveAt = now; }
  }
  for (const n of w.npcs) {
    if (n.st === 'hold') { n.left = Math.max(0.1, n.left - n.drain * 2); if (n.left <= 0.1) { n.st = 'finished'; n.leaveAt = now + 25000; if (Math.random() < 0.35) npcSay(n, '잘 마셨어요!'); } }
    // 혼잣말은 매장 전체에서 5분에 한 번 이하, 한 사람은 12분에 한 번 이하로만(평균 8분쯤에 한 마디)
    if (now - (w.lastChatter || 0) > 300000 && (!n.say || now - n.say.at > 720000) && Math.random() < 0.004) { npcSay(n); w.lastChatter = now; }
  }
  w.npcs = w.npcs.filter((n) => !(n.leaveAt && now > n.leaveAt));
  const target = Math.max(0, Math.min(4, SEATS - count - 3));
  if (w.npcs.length < target && Math.random() < 0.12) spawnNpc(w);
  if (w.npcs.length > target + 1) { const n = w.npcs.find((x) => x.st !== 'finished'); if (n) { n.st = 'finished'; n.leaveAt = now + 6000; npcSay(n, '자리 비켜드릴게요'); } }
  // the cat
  const cat = w.cat;
  if (now >= cat.until) {
    const favSeat = cat.fav != null ? seatOf[cat.fav] : undefined;
    if (cat.mode === 'walk') {
      const nearFav = cat.at && cat.at.seat != null && cat.at.seat === favSeat;
      if (nearFav) { catRest(cat, 'sit', 15000 + Math.random() * 15000, now); cat.say = { t: '골골골…', at: now }; }
      else catRest(cat, Math.random() < 0.25 ? 'sleep' : 'sit', 10000 + Math.random() * 12000, now);
    } else {
      const r = Math.random();
      if (favSeat != null && r < 0.55) catWalk(cat, { seat: favSeat }, now);
      else if (r < 0.12) catRest(cat, 'sleep', 15000 + Math.random() * 20000, now);
      else catWalk(cat, { u: Math.random(), v: Math.random() }, now);
    }
  }
  broadcastWorld(room);
}
function worldMsg(room) {
  const w = getWorld(room), now = Date.now(), c = w.cat;
  return JSON.stringify({ t: 'world',
    npcs: w.npcs.filter((n) => n.seat != null).map((n) => ({ key: n.key, name: n.name, look: n.look, d: n.d, left: Math.round(n.left * 100) / 100, st: n.st, seat: n.seat, say: n.say })),
    cat: { mode: c.mode, at: c.at, rem: Math.max(0, c.until - now), dur: c.dur, v: c.v, say: c.say, fav: c.fav, likes: c.likes } });
}
function broadcastWorld(room) {
  const r = rooms.get(room); if (!r) return;
  const msg = worldMsg(room);
  for (const m of r.values()) m.conn.send(msg);
}
function handleAct(room, id, m) {
  const w = getWorld(room), now = Date.now();
  if (m.a === 'pet') {
    const c = w.cat; c.likes[id] = (c.likes[id] || 0) + 1;
    if (c.mode === 'sleep') { catRest(c, 'sit', 5000, now); c.say = { t: '…냥? (깼다)', at: now }; }
    else c.say = { t: pick(CAT_LINES), at: now };
    if (c.likes[id] >= 5 && c.fav !== id && c.likes[id] > (c.likes[c.fav] || 0)) {
      c.fav = id; c.say = { t: '{fav} 옆이 제일 좋다냥', at: now };
      const s = humanSeats(room).seatOf[id]; if (s != null) catWalk(c, { seat: s }, now);
    }
    c.v++;
  } else if (m.a === 'npcSay' || m.a === 'refill') {
    const n = w.npcs.find((x) => x.key === m.key); if (!n) return;
    if (m.a === 'refill') { n.left = 1; n.st = 'hold'; n.leaveAt = 0; npcSay(n, '감사해요! 여기 팁'); } else npcSay(n);
  } else if (m.a === 'chatseed' && Array.isArray(m.list)) {
    // the server forgets chat when it sleeps; browsers keep a copy and hand back what is missing
    const log = chats.get(room) || [], seen = new Set(log.map((e) => e.id + '|' + e.at + '|' + e.t));
    let added = 0;
    for (const x of m.list.slice(-200)) {
      if (!x || typeof x.t !== 'string' || typeof x.at !== 'number' || x.at > now + 60000 || x.at < now - 30 * 864e5) continue;
      const e = { id: clean(String(x.id || ''), 32) || 'guest', name: String(x.name || '').slice(0, 12), t: x.t.trim().slice(0, 100), at: x.at };
      const k = e.id + '|' + e.at + '|' + e.t; if (!e.t || seen.has(k)) continue;
      seen.add(k); log.push(e); added++;
    }
    if (!added) return;
    log.sort((p, q) => p.at - q.at); if (log.length > 200) log.splice(0, log.length - 200);
    chats.set(room, log);
    const msg = JSON.stringify({ t: 'chatlog', list: log });
    for (const x of (rooms.get(room) || new Map()).values()) x.conn.send(msg);
    return;
  } else if (m.a === 'meta') {
    if (room === 'main') return;
    // 처음 보내는 사람이 점장이 되고, 그다음부터는 점장만 이름과 목표를 바꿀 수 있어요
    const cur = metas.get(room), goal = GOALS.has(+m.goal) ? +m.goal : null;
    const member = rooms.get(room) && rooms.get(room).get(id), myName = cleanName(member && member.state && member.state.nick);
    if (!cur) metas.set(room, { title: cleanTitle(m.title) || '우리 매장', owner: id, ownerName: myName, goal: goal == null ? 10 : goal, at: now, guess: m.guess ? 1 : 0 });
    else if (cur.owner === id) { if (cleanTitle(m.title)) cur.title = cleanTitle(m.title); if (goal != null) cur.goal = goal; if (myName) cur.ownerName = myName; }
    else return;
    toRoom(room, metaMsg(room)); return;
  } else if (m.a === 'metaseed') {
    if (room === 'main') return;
    const x = m.meta;
    // 서버가 잠에서 깬 뒤 주소만 아는 사람이 먼저 와서 임시 점장이 됐더라도, 원래 매장 정보를 가진 사람이 오면 되돌려요
    if ((metas.has(room) && !metas.get(room).guess) || !x || typeof x !== 'object' || !clean(x.owner, 32)) return;
    metas.set(room, { title: cleanTitle(x.title) || '우리 매장', owner: clean(x.owner, 32), ownerName: cleanName(x.ownerName), goal: GOALS.has(+x.goal) ? +x.goal : 10, at: +x.at || now });
    toRoom(room, metaMsg(room)); return;
  } else if (m.a === 'rosterseed' && Array.isArray(m.list)) {
    if (!rosters.has(room)) rosters.set(room, new Map());
    const r = rosters.get(room); let added = 0;
    for (const x of m.list.slice(0, 60)) {
      if (!x || typeof x !== 'object') continue;
      const xid = clean(x.id, 32), seen = +x.seen;
      if (!xid || !(seen > now - 35 * 864e5) || seen > now + 60000) continue;
      const prev = r.get(xid); if (prev && prev.seen >= seen) continue;
      r.set(xid, { id: xid, name: cleanName(x.name), look: validLook(x.look), wk: validWk(x.wk), seen }); added++;
    }
    if (added) { pruneRoster(r); broadcastRoster(room); }
    return;
  } else if (m.a === 'ev') {
    statEvent(String(m.e || '')); return;
  } else if (m.a === 'guest') {
    spawnNpc(w, String(m.name || '').slice(0, 20), String(m.d || ''));
  } else return;
  broadcastWorld(room);
}
setInterval(() => { for (const room of rooms.keys()) tickWorld(room); }, 2000);

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
      // 한 사람은 한 매장에만 있어요: 다른 매장에 남아 있던 예전 창은 그 매장에서 빼요
      for (const [rk, rm] of rooms) {
        if (rk === room || !rm.has(id)) continue;
        const old = rm.get(id); rm.delete(id);
        const meta = metas.get(room);
        try { old.conn.send(JSON.stringify({ t: 'replaced', to: room, title: room === 'main' ? '공개 매장' : (meta && meta.title) || '' })); old.conn.close(); } catch (e) {}
        if (!rm.size) rooms.delete(rk); else broadcast(rk);
      }
      broadcast(room);
      if (!getWorld(room).seeded) tickWorld(room); else conn.send(worldMsg(room));
      conn.send(JSON.stringify({ t: 'chatlog', list: chats.get(room) || [] }));
      conn.send(metaMsg(room)); conn.send(rosterMsg(room));
      touchRoster(room, id, rooms.get(room).get(id).state);
      statSeen(room, id); statFocus(id, rooms.get(room).get(id).state);
    } else if (m.t === 'act' && me) {
      handleAct(me.room, me.id, m);
    } else if (m.t === 'state' && me) {
      const entry = rooms.get(me.room) && rooms.get(me.room).get(me.id);
      if (entry && m.state && typeof m.state === 'object') {
        const before = entry.state && entry.state.say, said = m.state.say;
        entry.state = m.state; broadcast(me.room); touchRoster(me.room, me.id, m.state); statFocus(me.id, m.state);
        // keep what people say so others can read it later
        if (said && typeof said.t === 'string' && said.t.trim() && (!before || before.at !== said.at)) {
          const e = { id: me.id, name: String(m.state.nick || '').slice(0, 12), t: said.t.trim().slice(0, 100), at: Date.now() };
          if (!chats.has(me.room)) chats.set(me.room, []);
          const log = chats.get(me.room); log.push(e); if (log.length > 200) log.splice(0, log.length - 200);
          const msg = JSON.stringify({ t: 'chat', e });
          for (const x of rooms.get(me.room).values()) x.conn.send(msg);
        }
      }
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
