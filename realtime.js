/*
 * 오늘의 바리스타 · 실시간 연결부
 *
 * 카페 코드는 claude.use('room') 로 "지금 매장에 있는 사람"을 받아요.
 * 이 파일은 그 자리를 대신 채워줍니다.
 *
 *  - config.js 에 Supabase 주소와 키를 넣으면: 인터넷으로 친구들과 같은 매장에 앉아요.
 *  - 비워두면: 같은 브라우저의 다른 탭끼리만 연결돼요(테스트용).
 *
 * 매장 이름은 주소 뒤 ?room=우리반 처럼 바꿀 수 있어요. 같은 room 끼리만 만나요.
 */
(function () {
  const CFG = window.CAFE_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const ROOM = (params.get('room') || CFG.room || 'main').replace(/[^\w가-힣-]/g, '').slice(0, 40) || 'main';
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 16);
  // one id per browser, so refreshing or opening another tab is still the same person
  let DEVICE_ID = null;
  try { DEVICE_ID = localStorage.getItem('barista.device'); if (!DEVICE_ID) { DEVICE_ID = newId(); localStorage.setItem('barista.device', DEVICE_ID); } } catch (e) {}
  let MY_ID = newId(); // per tab; switched to DEVICE_ID when a server connection is used

  /* ---------- a tiny presence room with the same shape the café code expects ---------- */
  function makeRoom(transport) {
    let mine = {};
    const others = new Map(); // id -> {presence, updatedAt}
    const listeners = new Set();
    let snapshot = Object.freeze([]);
    let connected = false;

    function build() {
      const me = Object.freeze({ peer: MY_ID, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false,
        presence: Object.freeze({ ...mine }), updatedAt: Date.now() });
      const list = [me];
      for (const [id, o] of others) list.push(Object.freeze({ peer: id, by: null, isMe: false, sameTab: false,
        kind: 'viewer', guest: false, presence: o.presence, updatedAt: o.updatedAt }));
      return Object.freeze(list);
    }
    function emitChange(joined, left, updated) {
      snapshot = build();
      const change = { peers: snapshot, joined: joined || [], left: left || [], updated: updated || [] };
      for (const fn of listeners) { try { fn(change); } catch (e) { console.error(e); } }
    }
    const api = {
      peers: () => snapshot,
      connected: () => connected,
      presence(patch) {
        for (const k in patch) { if (patch[k] === null) delete mine[k]; else mine[k] = patch[k]; }
        transport.send(mine);
        emitChange();
        return Promise.resolve();
      },
      onPeers(fn) { listeners.add(fn); setTimeout(() => fn({ peers: snapshot, joined: snapshot, left: [], updated: [] }), 0); return () => listeners.delete(fn); },
      onConnection(fn) { setTimeout(() => fn(connected), 0); return () => {}; },
      emit: () => Promise.resolve(),
      on: () => () => {},
      // shared world (AI guests, cat) — only when our own server is connected
      onWorld(fn) { worldFns.add(fn); if (lastWorld) setTimeout(() => fn(lastWorld), 0); return () => worldFns.delete(fn); },
      act(msg) { return transport.act ? transport.act(msg) : false; },
      onChat(fn) { chatFns.add(fn); return () => chatFns.delete(fn); },
      // 매장 정보(meta)와 알바생 명부(roster): 서버 연결일 때만 와요
      onStore(fn) { storeFns.add(fn); for (const m of lastStore.values()) setTimeout(() => fn(m), 0); return () => storeFns.delete(fn); },
      server: () => !!transport.act,
    };
    const storeFns = new Set(), lastStore = new Map();
    api._store = (m) => { lastStore.set(m.t, m); for (const fn of storeFns) { try { fn(m); } catch (e) { console.error(e); } } };
    let lastWorld = null; const worldFns = new Set(); const chatFns = new Set();
    api._chat = (m) => { for (const fn of chatFns) { try { fn(m); } catch (e) { console.error(e); } } };
    api._world = (w) => { lastWorld = w; for (const fn of worldFns) { try { fn(w); } catch (e) { console.error(e); } } };
    // called by the transport
    api._set = (all) => {
      const joined = [], updated = [], left = [];
      const seen = new Set();
      for (const [id, presence] of Object.entries(all)) {
        if (id === MY_ID) continue;
        seen.add(id);
        const prev = others.get(id);
        const frozen = Object.freeze({ ...presence });
        if (!prev) { others.set(id, { presence: frozen, updatedAt: Date.now() }); joined.push(id); }
        else if (JSON.stringify(prev.presence) !== JSON.stringify(frozen)) { others.set(id, { presence: frozen, updatedAt: Date.now() }); updated.push(id); }
      }
      for (const id of [...others.keys()]) if (!seen.has(id)) { others.delete(id); left.push(id); }
      if (joined.length || updated.length || left.length) {
        snapshot = build();
        const pick = ids => snapshot.filter(p => ids.includes(p.peer));
        const change = { peers: snapshot, joined: pick(joined), left: [], updated: pick(updated) };
        for (const fn of listeners) { try { fn(change); } catch (e) { console.error(e); } }
      }
    };
    api._connected = (v) => { connected = v; };
    snapshot = build();
    return api;
  }

  /* ---------- transport 1: Supabase Realtime presence (friends over the internet) ---------- */
  function supabaseTransport() {
    let room, channel, pending = null, timer = 0, ready = false;
    const flush = () => { timer = 0; if (ready && pending) { channel.track({ s: JSON.stringify(pending) }); pending = null; } };
    const t = {
      send(state) { pending = { ...state }; if (!timer) timer = setTimeout(flush, 250); },
      start(r) {
        room = r;
        const client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
        channel = client.channel('cafe:' + ROOM, { config: { presence: { key: MY_ID } } });
        channel.on('presence', { event: 'sync' }, () => {
          const st = channel.presenceState(), all = {};
          for (const [id, metas] of Object.entries(st)) {
            const last = metas[metas.length - 1];
            try { all[id] = JSON.parse(last.s || '{}'); } catch (e) { all[id] = {}; }
          }
          room._set(all);
        });
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') { ready = true; room._connected(true); pending = pending || {}; flush(); }
          else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { room._connected(false); }
        });
      },
    };
    return t;
  }

  /* ---------- transport 2: BroadcastChannel (other tabs of this browser, for testing) ---------- */
  function tabTransport() {
    let room, bc, mine = {}; const seen = new Map();
    const post = (type) => bc.postMessage({ type, id: MY_ID, room: ROOM, state: mine });
    const publish = () => { const all = {}; for (const [id, o] of seen) all[id] = o.state; room._set(all); };
    return {
      send(state) { mine = { ...state }; if (bc) post('state'); },
      start(r) {
        room = r; bc = new BroadcastChannel('cafe-room');
        bc.onmessage = (ev) => {
          const m = ev.data || {}; if (m.room !== ROOM || m.id === MY_ID) return;
          if (m.type === 'bye') seen.delete(m.id); else seen.set(m.id, { state: m.state || {}, at: Date.now() });
          if (m.type === 'hello') post('state');
          publish();
        };
        post('hello'); room._connected(true);
        setInterval(() => { post('state'); const now = Date.now(); let gone = false;
          for (const [id, o] of seen) if (now - o.at > 9000) { seen.delete(id); gone = true; }
          if (gone) publish(); }, 3000);
        addEventListener('pagehide', () => post('bye'));
      },
    };
  }

  function showRetired() {
    if (document.getElementById('cafe-retired')) return;
    const d = document.createElement('div'); d.id = 'cafe-retired';
    d.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99;background:#2A211B;color:#FBF8F2;padding:10px 14px;border-radius:12px;font:14px system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:calc(100% - 32px)';
    const t = document.createElement('span'); t.textContent = '다른 창에서 카페를 열어서 이 창은 매장 연결을 멈췄어요.';
    const b = document.createElement('button'); b.textContent = '이 창으로 다시 연결';
    b.style.cssText = 'border:0;border-radius:99px;padding:5px 12px;background:#86C9AC;color:#10201A;font:inherit;cursor:pointer;white-space:nowrap';
    b.onclick = () => location.reload();
    d.append(t, b); document.body.appendChild(d);
  }

  /* ---------- transport 3: our own server.js on Render (/ws) ---------- */
  function wsTransport() {
    let room, ws, mine = {}, retry = 0, everOpen = false, stopped = false;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const t = {
      send(state) { mine = { ...state }; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', state: mine })); },
      act(msg) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ ...msg, t: 'act' })); return true; } return false; },
      start(r, onOpen, onFail) {
        room = r;
        const connect = () => {
          let opened = false;
          ws = new WebSocket(url);
          const giveUp = setTimeout(() => { if (!opened && !everOpen) { try { ws.close(); } catch (e) {} } }, 20000);
          ws.onopen = () => {
            opened = true; clearTimeout(giveUp); retry = 0; room._connected(true);
            ws.send(JSON.stringify({ t: 'join', room: ROOM, id: MY_ID, state: mine }));
            if (!everOpen) { everOpen = true; onOpen && onOpen(); }
          };
          ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.t === 'peers') room._set(m.all || {});
            if (m.t === 'world') room._world(m);
            if (m.t === 'chat' || m.t === 'chatlog') room._chat(m);
            if (m.t === 'meta' || m.t === 'roster') room._store(m);
            if (m.t === 'replaced') { stopped = true; room._set({}); showRetired(); }
          };
          ws.onclose = () => {
            clearTimeout(giveUp); room._connected(false);
            if (stopped) return;                               // another window took over
            if (!everOpen) { onFail && onFail(); return; }   // no server here: fall back
            room._set({});                                     // lost connection: show only me until back
            setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
          };
        };
        connect();
        addEventListener('pagehide', () => { try { ws.close(); } catch (e) {} });
      },
    };
    return t;
  }

  let roomPromise = null;
  function getRoom() {
    if (roomPromise) return roomPromise;
    roomPromise = new Promise((resolve) => {
      const useSupabase = CFG.supabaseUrl && CFG.supabaseAnonKey;
      const go = (transport) => { const r = makeRoom(transport); transport.start(r); resolve(r); };
      const tryServer = location.protocol.startsWith('http') && 'WebSocket' in window && CFG.server !== false;
      if (!useSupabase && tryServer) {
        if (DEVICE_ID) MY_ID = DEVICE_ID;
        const t = wsTransport(), r = makeRoom(t);
        t.start(r, () => resolve(r), () => { if ('BroadcastChannel' in window) go(tabTransport()); else resolve(null); });
      } else if (useSupabase) {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
        s.onload = () => go(supabaseTransport());
        s.onerror = () => { console.warn('Supabase를 불러오지 못해서 탭 연결로 바꿨어요.'); go(tabTransport()); };
        document.head.appendChild(s);
      } else if ('BroadcastChannel' in window) go(tabTransport());
      else resolve(null);
    });
    return roomPromise;
  }

  // the café code asks for capabilities by name; only "room" exists outside Claude
  window.claude = window.claude || { use: async (name) => (name === 'room' ? getRoom() : null) };
  window.CAFE_ROOM = ROOM;
})();
