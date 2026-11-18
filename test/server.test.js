'use strict';
// 서버 방 설정 테스트: 서버를 임의 포트로 띄워 ws 로 확인 (node --test)
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

let proc, port;
const sleep = ms => new Promise(r => setTimeout(r, ms));
test.before(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch (e) {}
    await sleep(100);
  }
  throw new Error('server did not start');
});
test.after(() => { if (proc) proc.kill(); });

function client() {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, g: null, room: null, peer: null, send: o => ws.send(JSON.stringify(o)) };
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'g') c.g = m.g; else if (m.t === 'room') c.room = m; else if (m.t === 'welcome') c.peer = m.peer; });
    ws.on('open', () => resolve(c));
  });
}

test('방 설정: 방장만 재장전 0 을 켜고(t0 조작 무시), 고른 무기(lo)가 정리되어 게임에 반영', async () => {
  const a = await client(), b = await client();
  a.send({ t: 'join', name: 'room-opt' }); await sleep(100);
  b.send({ t: 'join', name: 'room-opt' }); await sleep(100);
  a.send({ t: 'rp', p: { nm: 'host', c: '#ff6b6b', rd: false, t0: 1000, lo: [6, 6, 999, 'x', 2] } });
  b.send({ t: 'rp', p: { nm: 'guest', c: '#4dabf7', rd: false, t0: -1e300, rl0: true, lo: { length: 1e9 } } }); await sleep(150);
  assert.deepStrictEqual([a.g.ph, a.g.rl0], ['lobby', false], '나중에 온 사람이 t0 를 속여도 방장이 되지 못함');
  a.send({ t: 'rp', p: { rl0: true } }); await sleep(150);
  assert.strictEqual(b.g.rl0, true, '방장 값은 적용');
  a.send({ t: 'rp', p: { rd: true } }); b.send({ t: 'rp', p: { rd: true } }); await sleep(300);
  assert.deepStrictEqual([a.g.ph, a.g.r0, a.g.pl.length], ['play', 1, 2]);
  assert.deepStrictEqual([a.g.w[0][6], a.g.w[1][6]], [6, 3], '방장은 정리된 선택의 첫 무기(지뢰), 잘못 보낸 쪽은 기본 선택의 첫 무기(바주카)');
  a.ws.close(); b.ws.close();
});

test('같은 색 두 명은 서버가 다른 색으로 바꾸고, 게임 중 나간 사람의 지렁이는 판에서 빠짐', async () => {
  const a = await client(), b = await client();
  a.send({ t: 'join', name: 'room-leave' }); await sleep(100);
  b.send({ t: 'join', name: 'room-leave' }); await sleep(100);
  a.send({ t: 'rp', p: { nm: 'aa', c: '#ff6b6b', rd: false } }); await sleep(50);
  b.send({ t: 'rp', p: { nm: 'bb', c: '#ff6b6b', rd: false } }); await sleep(150);
  const col = p => a.room.peers.find(x => x.peer === p).presence.c;
  assert.deepStrictEqual([col(a.peer), col(b.peer)], ['#ff6b6b', '#4dabf7'], '나중에 고른 쪽이 안 쓰는 색으로');
  a.send({ t: 'add_bot' }); await sleep(100);
  a.send({ t: 'rp', p: { rd: true } }); b.send({ t: 'rp', p: { rd: true } }); await sleep(300);
  assert.deepStrictEqual([a.g.ph, a.g.pl.length, a.g.gn], ['play', 3, 0]);
  const bi = a.g.pl.indexOf(b.peer);
  b.ws.close(); await sleep(300);
  assert.deepStrictEqual([a.g.ph, a.g.gn, a.g.w[bi][5]], ['play', 1 << bi, 0], '나간 사람 표시 + 지렁이 제거, 봇이 남아 있어 판은 계속');
  a.ws.close();
});

test('게임 중 나갔다가 같은 방에 다시 들어오면 죽은 지렁이의 주인이 아니라 관전자', async () => {
  const a = await client(), b = await client();
  a.send({ t: 'join', name: 'room-rejoin' }); await sleep(100);
  b.send({ t: 'join', name: 'room-rejoin' }); await sleep(100);
  a.send({ t: 'rp', p: { nm: 'aa', c: '#ff6b6b' } }); b.send({ t: 'rp', p: { nm: 'bb', c: '#4dabf7' } }); await sleep(100);
  a.send({ t: 'add_bot' }); await sleep(100);
  a.send({ t: 'rp', p: { rd: true } }); b.send({ t: 'rp', p: { rd: true } }); await sleep(300);
  const bi = a.g.pl.indexOf(b.peer); assert.ok(bi >= 0);
  b.send({ t: 'leave' }); await sleep(200); b.g = null;
  b.send({ t: 'join', name: 'room-rejoin' }); await sleep(300);
  b.send({ t: 'rp', p: { nm: 'bb', in: 18, rd: true } }); await sleep(300);
  assert.deepStrictEqual([b.g.ph, b.g.pl.indexOf(b.peer), a.g.gn, a.g.w[bi][5]], ['play', -1, 1 << bi, 0], '다시 들어온 사람은 참가자 목록에 없고(관전) 지렁이는 빠진 채');
  a.ws.close(); b.ws.close();
});

test('게임 중인 방에 들어오면 관전자: 입력은 무시되고, 관전자는 8명까지, 다음 판에는 참가', async () => {
  const a = await client();
  a.send({ t: 'join', name: 'room-spec' }); await sleep(100);
  a.send({ t: 'rp', p: { nm: 'aa', c: '#ff6b6b' } }); await sleep(50);
  for (let i = 0; i < 5; i++) a.send({ t: 'add_bot' }); await sleep(150);
  a.send({ t: 'rp', p: { rd: true } }); await sleep(300);
  assert.deepStrictEqual([a.g.ph, a.g.pl.length], ['play', 6], '참가자 6명(정원)으로 시작');
  const sp = []; let fail = 0;
  for (let i = 0; i < 9; i++) { const c = await client(); c.ws.on('message', raw => { if (JSON.parse(raw).t === 'joinfail') fail++; }); c.send({ t: 'join', name: 'room-spec' }); sp.push(c); await sleep(40); }
  await sleep(200);
  assert.deepStrictEqual([sp.filter(c => c.g && c.g.ph === 'play').length, fail], [8, 1], '정원이 찬 게임에도 관전 8명까지 입장, 9번째는 거절');
  const w0 = JSON.stringify(a.g.w.map(w => w[12])), n0 = a.g.pl.length;
  sp[0].send({ t: 'rp', p: { nm: 'ss', in: 16 | 2, rd: true } }); await sleep(300);
  assert.deepStrictEqual([sp[0].g.pl.indexOf(sp[0].peer), a.g.pl.length], [-1, n0], '관전자는 참가자 목록에 없음(입력이 지렁이에 닿지 않음)');
  for (const c of sp.slice(1)) c.ws.close();
  a.ws.close(); await sleep(400); // 마지막 참가자가 나가면 대기방으로
  assert.strictEqual(sp[0].g.ph, 'lobby', '참가자가 없으면 판 종료, 관전자는 대기방에 남음');
  for (let i = 0; i < 4; i++) sp[0].send({ t: 'remove_bot', id: sp[0].room.bots[i].id }); await sleep(150);
  sp[0].send({ t: 'rp', p: { nm: 'ss', rd: true } }); await sleep(300);
  assert.deepStrictEqual([sp[0].g.ph, sp[0].g.pl.indexOf(sp[0].peer) >= 0], ['play', true], '다음 판에는 참가자');
  sp[0].ws.close(); void w0;
});
