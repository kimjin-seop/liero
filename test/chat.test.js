'use strict';
// 채팅 테스트: 서버를 임의 포트로 띄워서 ws 로 확인 (node --test test/)
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

let proc, port;
test.before(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => { if (proc) proc.kill(); });

function client(room, nm) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got = [];
    const waiters = [];
    ws.on('message', raw => {
      const m = JSON.parse(raw); got.push(m);
      for (const w of [...waiters]) if (w.f(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
    });
    const api = {
      ws, got,
      send: o => ws.send(JSON.stringify(o)),
      wait: (f, ms = 1500) => new Promise((r, j) => {
        const hit = got.find(f); if (hit) return r(hit);
        waiters.push({ f, r }); setTimeout(() => j(new Error('timeout')), ms);
      }),
    };
    ws.on('open', async () => {
      if (room) {
        api.send({ t: 'join', name: room });
        await api.wait(m => m.t === 'joined');
        api.send({ t: 'rp', p: { nm, c: '#ff6b6b', t0: Date.now() } });
      }
      resolve(api);
    });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('채팅 왕복 + 정리(제어문자/공백/120자) + 방 격리 + 입장 시 기록', async () => {
  const a = await client('room-a', 'alice'), b = await client('room-a', 'bob'), x = await client('room-x', 'eve');
  a.send({ t: 'chat', text: '  안녕\n\t  하세요\u0007  ' });
  const m = await b.wait(m => m.t === 'chat');
  assert.strictEqual(m.msg.text, '안녕 하세요');
  assert.strictEqual(m.msg.nm, 'alice'); // 닉네임은 서버가 붙임
  await a.wait(m => m.t === 'chat'); // 보낸 사람도 받음
  await sleep(450); // 최소 간격(400ms)
  a.send({ t: 'chat', text: 'x'.repeat(300), nm: 'spoof' });
  await sleep(500);
  const long = b.got.filter(m => m.t === 'chat').pop();
  assert.strictEqual(long.msg.text.length, 120);
  assert.strictEqual(long.msg.nm, 'alice');
  a.send({ t: 'chat', text: ' \n ' }); // 빈 메시지 무시
  await sleep(500);
  assert.strictEqual(b.got.filter(m => m.t === 'chat').length, 2);
  assert.strictEqual(x.got.filter(m => m.t === 'chat').length, 0); // 다른 방엔 안 감
  const late = await client(null);
  late.send({ t: 'join', name: 'room-a' });
  const h = await late.wait(m => m.t === 'chathist');
  assert.strictEqual(h.msgs.length, 2);
  late.send({ t: 'chat', text: 'hi' }); await sleep(300);
  assert.ok(late.got.some(m => m.t === 'chat')); // 입장 직후 닉 미설정이어도 동작
  for (const c of [a, b, x, late]) c.ws.close();
});

test('방 밖 채팅 거부 + rate limit', async () => {
  const o = await client(null);
  o.send({ t: 'chat', text: 'hello' });
  assert.strictEqual((await o.wait(m => m.t === 'chatfail')).reason, 'no room');
  const a = await client('room-r', 'rate');
  for (let i = 0; i < 12; i++) { a.send({ t: 'chat', text: 'spam ' + i }); await sleep(30); }
  await a.wait(m => m.t === 'chatfail' && m.reason === 'rate');
  assert.ok(a.got.filter(m => m.t === 'chat').length <= 5);
  a.ws.close(); o.ws.close();
});
