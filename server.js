'use strict';
/*
 * 리에로 포에버 - 게임 서버
 * - public/index.html 을 서비스하고 (서버 모드 표시를 넣어서)
 * - /ws 웹소켓으로 방 목록, 대기방, 게임 진행을 처리합니다.
 * - 게임 계산(물리, 무기, 판정)은 index.html 안의 CORE 코드를 그대로 불러와 서버에서 돌립니다.
 *   (클라이언트와 서버가 같은 코드를 쓰므로 index.html만 고치면 둘 다 반영됩니다)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 300;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 60;
const MAX_PLAYERS = 6;
const TICK_MS = 1000 / 60;

// ---------- index.html 읽기 + 게임 코어 불러오기 ----------
const HTML_PATH = path.join(__dirname, 'public', 'index.html');
let PAGE = '';
let Core = null;
function loadPage() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const a = html.indexOf('//CORE-START'), b = html.indexOf('//CORE-END');
  if (a < 0 || b < 0) throw new Error('index.html에서 CORE 구간을 찾을 수 없습니다');
  const src = html.slice(a, b);
  Core = new Function('HAS_DOM', src + '\nreturn {Sim, Terrain, COLORS, safeColor, NW};')(false);
  if (!html.includes('</head>')) throw new Error('index.html에 </head>가 없습니다');
  PAGE = html.replace('</head>', '<script>window.LF_WS=true;</script>\n</head>');
}
loadPage();

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(PAGE);
    return;
  }
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, rooms: rooms.size }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// ---------- 유틸 ----------
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿-]/g;
const cleanName = s => (String(s || '').replace(BAD_CHARS, '').trim().slice(0, 10)) || '플레이어';
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const newId = () => crypto.randomBytes(8).toString('hex');
const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// ---------- 상태 ----------
const clients = new Map(); // peer -> client
const rooms = new Map();   // name -> Room

class Room {
  constructor(name) {
    this.name = name;
    this.members = new Map(); // peer -> client
    this.g = { ph: 'lobby', k: 10 };
    this.sim = null; this.meta = null; this.overAt = 0;
  }
  players() {
    return [...this.members.values()]
      .filter(c => typeof c.p.nm === 'string' && typeof c.p.t0 === 'number')
      .sort((a, b) => a.p.t0 - b.p.t0 || (a.peer < b.peer ? -1 : 1));
  }
  sendG() { const s = JSON.stringify({ t: 'g', g: this.g }); for (const c of this.members.values()) send(c, s); }
  sendPeers() {
    const peers = [...this.members.values()].map(c => ({
      peer: c.peer,
      presence: { nm: c.p.nm, c: c.p.c, rd: !!c.p.rd, t0: c.p.t0, k: c.p.k },
    }));
    const s = JSON.stringify({ t: 'room', name: this.name, peers });
    for (const c of this.members.values()) send(c, s);
  }
  check() {
    if (this.g.ph !== 'lobby') return;
    const ps = this.players();
    const leader = ps[0];
    const k = leader && [5, 10, 15].includes(leader.p.k) ? leader.p.k : 10;
    if (k !== this.g.k) { this.g = { ph: 'lobby', k }; this.sendG(); }
    if (ps.length >= 2 && ps.every(c => c.p.rd)) this.start(ps.slice(0, MAX_PLAYERS));
  }
  start(ps) {
    const seed = crypto.randomInt(1, 1e9);
    const T = new Core.Terrain(seed);
    this.sim = new Core.Sim(seed, ps.map(c => ({ name: c.p.nm, color: Core.safeColor(c.p.c) })), this.g.k, T);
    this.meta = { id: newId().slice(0, 8), pl: ps.map(c => c.peer) };
    this.overAt = 0;
    this.g = this.sim.snapshot(this.meta);
    this.sendG();
    scheduleLobby();
    log(`방 ${this.name}: 게임 시작 (${ps.length}명, ${this.g.k}킬)`);
  }
  toLobby() {
    this.sim = null; this.meta = null; this.overAt = 0;
    this.g = { ph: 'lobby', k: this.g.k || 10 };
    for (const c of this.members.values()) c.p.rd = false;
    this.sendG(); this.sendPeers(); scheduleLobby();
  }
  tick(now) {
    const sim = this.sim; if (!sim) return;
    const inputs = this.meta.pl.map(peer => {
      const c = this.members.get(peer);
      if (!c) return { m: 0, sw: null, rp: null };
      const p = c.p;
      const ta = num(p.ta);
      return {
        m: (p.in | 0) & 511, sw: num(p.sw), rp: num(p.rp),
        ta: ta === null ? null : Math.max(-4, Math.min(4, ta)),
        wd: num(p.wd) === null ? null : (p.wd | 0), wq: num(p.wq),
      };
    });
    sim.step(inputs);
    if (sim.tick % 2 === 0) { this.g = sim.snapshot(this.meta); this.sendG(); }
    if (sim.over && !this.overAt) this.overAt = now;
    if (this.overAt && now - this.overAt > 6000) { this.toLobby(); return; }
    // 플레이어가 모두 나가면 대기방으로
    if (!this.meta.pl.some(peer => this.members.has(peer))) this.toLobby();
  }
}

// ---------- 방 목록(로비) 전송: 최대 초당 5번 ----------
let lobbyTimer = null;
function scheduleLobby() { if (!lobbyTimer) lobbyTimer = setTimeout(sendLobby, 200); }
function lobbyPayload() {
  const peers = [];
  for (const c of clients.values()) {
    if (typeof c.lp.nm !== 'string') continue;
    const r = c.room;
    peers.push({ peer: c.peer, presence: { nm: c.lp.nm, c: c.lp.c, rm: r ? r.name : null, st: r && r.sim ? 'play' : 'wait', t0: r ? c.p.t0 : null } });
  }
  return JSON.stringify({ t: 'lobby', peers });
}
function sendLobby() {
  lobbyTimer = null;
  const s = lobbyPayload();
  for (const c of clients.values()) if (!c.room) send(c, s); // 방 안에 있는 사람에겐 필요 없음
}

function leaveRoom(c) {
  const r = c.room; if (!r) return;
  r.members.delete(c.peer); c.room = null; c.p = {};
  if (r.members.size === 0) { rooms.delete(r.name); log(`방 ${r.name}: 닫힘`); }
  else { r.sendPeers(); r.check(); }
  scheduleLobby();
  send(c, lobbyPayload());
}

// ---------- 웹소켓 ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const ALLOWED_RP = new Set(['nm', 'c', 'rd', 't0', 'k', 'in', 'sw', 'rp', 'ta', 'wd', 'wq', 'g']);

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'server full'); return; }
  const c = { ws, peer: newId(), lp: {}, p: {}, room: null, alive: true, msgs: 0, winStart: Date.now() };
  clients.set(c.peer, c);
  send(c, { t: 'welcome', peer: c.peer });
  send(c, lobbyPayload());
  ws.on('pong', () => { c.alive = true; });

  ws.on('message', raw => {
    // 간단한 도배 방지: 1초에 240개 초과는 버림
    const now = Date.now();
    if (now - c.winStart > 1000) { c.winStart = now; c.msgs = 0; }
    if (++c.msgs > 240) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'lp' && m.p && typeof m.p === 'object') {
      if ('nm' in m.p) c.lp.nm = cleanName(m.p.nm);
      if ('c' in m.p) c.lp.c = Core.safeColor(m.p.c);
      scheduleLobby();
    } else if (m.t === 'join') {
      const name = String(m.name || '');
      if (!ROOM_RE.test(name)) return send(c, { t: 'joinfail', reason: 'bad name' });
      if (c.room) leaveRoom(c);
      let r = rooms.get(name);
      if (!r) {
        if (rooms.size >= MAX_ROOMS) return send(c, { t: 'joinfail', reason: 'too many rooms' });
        r = new Room(name); rooms.set(name, r);
      }
      if (r.members.size >= MAX_PLAYERS) return send(c, { t: 'joinfail', reason: 'full' });
      r.members.set(c.peer, c); c.room = r; c.p = {};
      send(c, { t: 'joined', name });
      send(c, { t: 'g', g: r.g });
      r.sendPeers(); scheduleLobby();
    } else if (m.t === 'leave') {
      leaveRoom(c);
    } else if (m.t === 'rp' && c.room && m.p && typeof m.p === 'object') {
      const p = m.p, r = c.room;
      let changed = false;
      for (const key of Object.keys(p)) {
        if (!ALLOWED_RP.has(key) || key === 'g') continue;
        let v = p[key];
        if (key === 'nm') v = cleanName(v);
        else if (key === 'c') v = Core.safeColor(v);
        else if (key === 'rd') v = !!v;
        else if (key === 'k') v = [5, 10, 15].includes(v) ? v : 10;
        else if (v !== null && typeof v !== 'number') continue;
        if (['nm', 'c', 'rd', 't0', 'k'].includes(key) && c.p[key] !== v) changed = true;
        c.p[key] = v;
      }
      if (changed) { r.check(); r.sendPeers(); }
    }
  });

  ws.on('close', () => {
    leaveRoom(c);
    clients.delete(c.peer);
    scheduleLobby();
  });
  ws.on('error', () => {});
});

// 끊긴 연결 정리 (30초마다 ping)
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 30000);

// ---------- 게임 루프 (60틱) ----------
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(250, now - last); last = now;
  let n = 0;
  while (acc >= TICK_MS && n < 8) {
    for (const r of rooms.values()) {
      try { r.tick(Date.now()); } catch (e) { console.error('room tick error', r.name, e); r.toLobby(); }
    }
    acc -= TICK_MS; n++;
  }
}, 4);

function log(msg) { console.log(new Date().toISOString(), msg); }

server.listen(PORT, HOST, () => log(`리에로 포에버 서버 실행 중: http://${HOST}:${PORT}`));

// 종료 신호 처리
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('종료합니다'); server.close(); process.exit(0); });
