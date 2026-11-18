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
const MAX_SPECT = 8; // 게임 중인 방에 관전으로 들어올 수 있는 사람 수(정원 6 은 참가자 기준)
const TICK_MS = 1000 / 60;
const BOT_NAMES = ['봇 감자', '봇 두더지', '봇 지렁이', '봇 고구마', '봇 도토리', '봇 굼벵이'];

// ---------- index.html 읽기 + 게임 코어 불러오기 ----------
const HTML_PATH = path.join(__dirname, 'public', 'index.html');
const OG_PATH = path.join(__dirname, 'public', 'assets', 'og.png');
let PAGE = '';
let Core = null;
function loadPage() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const a = html.indexOf('//CORE-START'), b = html.indexOf('//CORE-END');
  if (a < 0 || b < 0) throw new Error('index.html에서 CORE 구간을 찾을 수 없습니다');
  const src = html.slice(a, b);
  Core = new Function('HAS_DOM', src + '\nreturn {Sim, Terrain, COLORS, safeColor, NW, Bot, WEAPONS, normLo, botLo};')(false);
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
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  // 링크 미리보기 이미지(og:image). 정해진 파일 하나만 서빙(경로 입력을 파일 경로로 쓰지 않음)
  if (url === '/assets/og.png') {
    fs.readFile(OG_PATH, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
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
const CHAT_MAX = 120, CHAT_KEEP = 50, CHAT_BURST = 5, CHAT_WINDOW_MS = 8000, CHAT_GAP_MS = 400;
// 채팅 정리: 제어문자·보이지 않는 문자 제거 -> 공백 하나로 -> 앞뒤 제거 -> 120자(코드포인트) 제한
const cleanChat = s => Array.from(String(s).replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim()).slice(0, CHAT_MAX).join('').trim();
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const newId = () => crypto.randomBytes(8).toString('hex');
let lastStamp = 0;
const joinStamp = () => (lastStamp = Math.max(lastStamp + 1, Date.now())); // 입장 시각(같은 밀리초에도 순서가 갈리게 항상 증가)
const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// ---------- 상태 ----------
const clients = new Map(); // peer -> client
const rooms = new Map();   // name -> Room

class Room {
  constructor(name) {
    this.name = name;
    this.members = new Map(); // peer -> client
    this.g = { ph: 'lobby', k: 10, pull: true, rl0: false };
    this.sim = null; this.meta = null; this.overAt = 0;
    this.bots = []; // [{id, nm, c}] 봇 슬롯 (대기실에서 유지됨)
    this.brain = null; // 게임 중 peer id -> Bot
    this.chat = [];    // 최근 채팅 (CHAT_KEEP개)
  }
  total() { return this.members.size + this.bots.length; }
  // 게임 중: 참가자(사람+봇, 나간 자리 제외) 수와 관전자(방에 있지만 이번 판 참가자가 아닌 사람) 수
  playing() { return this.meta ? this.meta.pl.filter(p => p).length : 0; }
  spectators() { if (!this.meta) return 0; let n = 0; for (const p of this.members.keys()) if (!this.meta.pl.includes(p)) n++; return n; }
  players() {
    return [...this.members.values()]
      .filter(c => typeof c.p.nm === 'string' && typeof c.p.t0 === 'number')
      .sort((a, b) => a.p.t0 - b.p.t0 || (a.peer < b.peer ? -1 : 1));
  }
  sendG() { const s = JSON.stringify({ t: 'g', g: this.g }); for (const c of this.members.values()) send(c, s); }
  sendPeers() {
    const peers = [...this.members.values()].map(c => ({
      peer: c.peer,
      presence: { nm: c.p.nm, c: c.p.c, rd: !!c.p.rd, t0: c.p.t0, k: c.p.k, pull: c.p.pull, rl0: c.p.rl0 },
    }));
    const bots = this.bots.map(b => ({ id: b.id, nm: b.nm, c: b.c, isBot: true, rd: true }));
    const s = JSON.stringify({ t: 'room', name: this.name, peers, bots, max: MAX_PLAYERS });
    for (const c of this.members.values()) send(c, s);
  }
  check() {
    if (this.g.ph !== 'lobby') return;
    const ps = this.players();
    const leader = ps[0];
    const k = leader && [5, 10, 15].includes(leader.p.k) ? leader.p.k : 10;
    const pull = !(leader && leader.p.pull === false);
    const rl0 = !!(leader && leader.p.rl0 === true); // 재장전 시간 0 (기본 끔, 방장 값 적용)
    if (k !== this.g.k || pull !== this.g.pull || rl0 !== this.g.rl0) { this.g = { ph: 'lobby', k, pull, rl0 }; this.sendG(); }
    // 방장(ps[0])의 준비가 시작 버튼. 봇은 항상 준비 상태이므로 사람 전원 준비 + (사람+봇) >= 2 면 시작
    if (ps.length >= 1 && ps.length + this.bots.length >= 2 && ps.every(c => c.p.rd)) this.start(ps.slice(0, MAX_PLAYERS - this.bots.length));
  }
  addBot() {
    if (this.g.ph !== 'lobby' || this.total() >= MAX_PLAYERS || this.bots.length >= MAX_PLAYERS - 1) return false;
    const used = new Set([...this.members.values()].map(c => c.p.c).concat(this.bots.map(b => b.c)));
    const c = Core.COLORS.find(x => !used.has(x)) || Core.COLORS[0];
    const names = new Set(this.bots.map(b => b.nm));
    const nm = BOT_NAMES.find(x => !names.has(x)) || ('봇 ' + (this.bots.length + 1));
    this.bots.push({ id: 'bot:' + newId().slice(0, 6), nm, c });
    return true;
  }
  // 색 중복 정리: 원하는 색을 방의 다른 사람·봇이 쓰고 있으면 안 쓰는 색을 줌(모두 쓰는 중이면 그대로)
  pickColor(c, want) {
    const used = new Set(this.bots.map(b => b.c));
    for (const o of this.members.values()) if (o !== c && o.p.c) used.add(o.p.c);
    if (!used.has(want)) return want;
    return Core.COLORS.find(x => !used.has(x)) || want;
  }
  // 게임 중 퇴장: 그 지렁이를 판에서 빼고(점수 변동 없음) 바로 알림. 남은 참가자가 1명 이하면 시뮬레이션이 판을 끝냄
  dropPlayer(peer) {
    if (!this.sim || !this.meta) return;
    const i = this.meta.pl.indexOf(peer);
    if (i < 0) return;
    this.meta.pl[i] = null; // 자리를 비움: 같은 연결로 다시 들어와도 그 지렁이의 주인이 되지 않고 관전자가 됨
    if (this.sim.drop(i)) { this.g = this.sim.snapshot(this.meta); this.sendG(); }
  }
  removeBot(id) {
    if (this.g.ph !== 'lobby') return false;
    const i = this.bots.findIndex(b => b.id === id);
    if (i < 0) return false;
    this.bots.splice(i, 1);
    return true;
  }
  start(ps) {
    const seed = crypto.randomInt(1, 1e9);
    const T = new Core.Terrain(seed);
    const all = ps.map(c => ({ peer: c.peer, name: c.p.nm, color: Core.safeColor(c.p.c), lo: Core.normLo(c.p.lo) }))
      .concat(this.bots.map(b => ({ peer: b.id, name: b.nm, color: Core.safeColor(b.c), lo: Core.botLo() })));
    this.sim = new Core.Sim(seed, all.map(a => ({ name: a.name, color: a.color, lo: a.lo })), this.g.k, T, { pull: this.g.pull !== false, rl0: this.g.rl0 === true });
    this.meta = { id: newId().slice(0, 8), pl: all.map(a => a.peer) };
    this.brain = new Map(this.bots.map(b => [b.id, new Core.Bot()]));
    const hum = ps.map((_, i) => i); for (const b of this.brain.values()) b.hum = hum; // 봇 추적 모드용: 사람 지렁이 번호(참가자 목록 앞쪽이 사람)
    this.overAt = 0;
    this.g = this.sim.snapshot(this.meta);
    this.sendG();
    scheduleLobby();
    log(`방 ${this.name}: 게임 시작 (사람 ${ps.length}+봇 ${this.bots.length}, ${this.g.k}킬)`);
  }
  toLobby() {
    if (this.sim && this.sim.bqDrop) log(`방 ${this.name}: 폭발 대기열 초과로 버린 폭발 ${this.sim.bqDrop}건`);
    this.sim = null; this.meta = null; this.overAt = 0; this.brain = null;
    this.g = { ph: 'lobby', k: this.g.k || 10, pull: this.g.pu !== 0, rl0: this.g.r0 === 1 };
    for (const c of this.members.values()) c.p.rd = false;
    this.sendG(); this.sendPeers(); scheduleLobby();
  }
  tick(now) {
    const sim = this.sim; if (!sim) return;
    const inputs = this.meta.pl.map((peer, i) => {
      const bot = this.brain && this.brain.get(peer);
      if (bot) { // 봇 입력은 서버가 직접 생성 (클라이언트 입력 경로와 무관)
        const o = bot.think(sim, sim.worms[i]);
        return { m: (o.m | 0) & 511, sw: num(o.sw), rp: num(o.rp), dg: num(o.dg) };
      }
      const c = this.members.get(peer);
      if (!c) return { m: 0, sw: null, rp: null };
      const p = c.p;
      const ta = num(p.ta);
      return {
        m: (p.in | 0) & 511, sw: num(p.sw), rp: num(p.rp), dg: num(p.dg), // dg: 파기 누름 횟수(sw·rp 와 같은 카운터). 없으면(null) 눌림 비트만으로 판정
        ta: ta === null ? null : Math.max(-4, Math.min(4, ta)),
        wd: num(p.wd) === null ? null : (p.wd | 0), wq: num(p.wq),
      };
    });
    sim.step(inputs);
    // 스냅샷: 평소 2틱에 1번. 슬로모션 중에는 시뮬레이션이 실제로 진행한 틱(3틱에 1번)에만 보내 화면 갱신 간격을 고르게 함(같은 장면 재전송 없음)
    if (sim.slow > 0 && !sim.over ? !sim.skip : sim.tick % 2 === 0) { this.g = sim.snapshot(this.meta); this.sendG(); }
    if (sim.over && !this.overAt) this.overAt = now;
    if (this.overAt && now - this.overAt > 6000) { this.toLobby(); return; }
    // 플레이어가 모두 나가면 대기방으로
    if (!this.meta.pl.some(peer => peer && this.members.has(peer))) this.toLobby(); // 참가 중인 사람이 없으면(봇·관전자만 남으면) 종료
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
  // 게임 중인 방의 인원은 참가자 기준(관전자는 spec 로 따로). smax 가 있으면 클라이언트가 게임 중에도 입장(관전) 버튼을 켬
  const rl = [...rooms.values()].map(r => r.sim
    ? { name: r.name, humans: r.playing() - r.bots.length, bots: r.bots.length, total: r.playing(), max: MAX_PLAYERS, st: 'play', spec: r.spectators(), smax: MAX_SPECT }
    : { name: r.name, humans: r.members.size, bots: r.bots.length, total: r.total(), max: MAX_PLAYERS, st: 'wait', spec: 0, smax: MAX_SPECT });
  return JSON.stringify({ t: 'lobby', peers, rooms: rl });
}
function sendLobby() {
  lobbyTimer = null;
  const s = lobbyPayload();
  for (const c of clients.values()) if (!c.room) send(c, s); // 방 안에 있는 사람에겐 필요 없음
}

function leaveRoom(c) {
  const r = c.room; if (!r) return;
  r.members.delete(c.peer); c.room = null; c.p = {};
  r.dropPlayer(c.peer);
  if (r.members.size === 0) { rooms.delete(r.name); log(`방 ${r.name}: 닫힘`); }
  else { r.sendPeers(); r.check(); }
  scheduleLobby();
  send(c, lobbyPayload());
}

// ---------- 웹소켓 ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const ALLOWED_RP = new Set(['nm', 'c', 'rd', 't0', 'k', 'in', 'sw', 'rp', 'dg', 'ta', 'wd', 'wq', 'g', 'pull', 'rl0', 'lo']);

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
      // 대기 중인 방은 정원(사람+봇 6)까지. 게임 중인 방은 관전으로 들어오므로 관전자 상한(MAX_SPECT)만 봄. 관전자의 입력은 쓰이지 않고(참가자 목록에 없음) 다음 판부터 입장 순서대로 참가
      if (r.sim ? r.spectators() >= MAX_SPECT : r.total() >= MAX_PLAYERS) return send(c, { t: 'joinfail', reason: 'full' });
      // 입장 순서(t0)는 서버 시각으로 확정한다. 클라이언트가 보낸 t0 는 받지 않음(방장 자리를 가로채지 못하게)
      r.members.set(c.peer, c); c.room = r; c.p = { t0: joinStamp() };
      send(c, { t: 'joined', name });
      send(c, { t: 'g', g: r.g });
      send(c, { t: 'chathist', msgs: r.chat });
      r.sendPeers(); scheduleLobby();
    } else if ((m.t === 'add_bot' || m.t === 'remove_bot') && c.room) {
      const r = c.room;
      const leader = r.players()[0];
      if (!leader || leader !== c) return send(c, { t: 'botfail', reason: 'not host', legacy: 'not allowed' });
      if (r.g.ph !== 'lobby') return send(c, { t: 'botfail', reason: 'in game', legacy: 'not allowed' });
      const ok = m.t === 'add_bot' ? r.addBot() : r.removeBot(String(m.id || ''));
      if (!ok) return send(c, { t: 'botfail', reason: m.t === 'add_bot' ? 'full' : 'no such bot' });
      c.p.rd = false; // 구성이 바뀌면 방장 준비 해제(의도치 않은 즉시 시작 방지)
      r.sendPeers(); scheduleLobby();
    } else if (m.t === 'chat') {
      const r = c.room;
      if (!r) return send(c, { t: 'chatfail', reason: 'no room' });
      if (typeof m.text !== 'string') return;
      const text = cleanChat(m.text);
      if (!text) return;
      const t2 = Date.now();
      c.chatTs = (c.chatTs || []).filter(x => t2 - x < CHAT_WINDOW_MS);
      if (c.chatTs.length >= CHAT_BURST || (c.chatTs.length && t2 - c.chatTs[c.chatTs.length - 1] < CHAT_GAP_MS)) return send(c, { t: 'chatfail', reason: 'rate' });
      c.chatTs.push(t2);
      const msg = { id: newId().slice(0, 8), peer: c.peer, nm: cleanName(c.p.nm || c.lp.nm), c: Core.safeColor(c.p.c || c.lp.c), text, ts: t2 };
      r.chat.push(msg); if (r.chat.length > CHAT_KEEP) r.chat.splice(0, r.chat.length - CHAT_KEEP);
      const out = JSON.stringify({ t: 'chat', msg });
      for (const mc of r.members.values()) send(mc, out);
    } else if (m.t === 'leave') {
      leaveRoom(c);
    } else if (m.t === 'rp' && c.room && m.p && typeof m.p === 'object') {
      const p = m.p, r = c.room;
      let changed = false;
      for (const key of Object.keys(p)) {
        if (!ALLOWED_RP.has(key) || key === 'g' || key === 't0') continue;
        let v = p[key];
        if (key === 'nm') v = cleanName(v);
        else if (key === 'c') v = r.pickColor(c, Core.safeColor(v)); // 같은 방에서 색이 겹치면 서버가 다른 색으로
        else if (key === 'rd' || key === 'pull' || key === 'rl0') v = !!v;
        else if (key === 'lo') v = Core.normLo(v); // 무기 선택: 범위·중복·개수 정리
        else if (key === 'k') v = [5, 10, 15].includes(v) ? v : 10;
        else if (v !== null && typeof v !== 'number') continue;
        if (['nm', 'c', 'rd', 'k', 'pull', 'rl0'].includes(key) && c.p[key] !== v) changed = true;
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
