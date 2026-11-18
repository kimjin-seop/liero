'use strict';
// 무기·시뮬레이션 테스트: index.html 의 CORE 구간을 서버와 같은 방식으로 불러와 확인 (node --test)
// 기대값은 원작 Liero 1.33 추출 자료(analysis/orig_data) 기준. 시간은 70프레임 → 60틱 환산(FR)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const src = html.slice(html.indexOf('//CORE-START'), html.indexOf('//CORE-END'));
const C = new Function('HAS_DOM', src + '\nreturn {Sim, Terrain, Bot, WEAPONS, WEAPON_RAW, NOBJ_RAW, NOBJ, SOBJ, INST_MAX, NW, DEF_LO, LOADOUT_N, SNAP_MAX, PROJ_MAX, BOOM_TICK, SLOW_DIV, MW, MH, FR, ITEM_DEF, normLo, botLo, decodeSnap, utf8len, aimRay, B_F, B_L, B_R, B_J, B_G, B_RI, B_RO, ROPE_MAX, stickBits};')(false);
const W = n => { const i = C.WEAPONS.findIndex(w => w.n === n); assert.ok(i >= 0, '무기 없음: ' + n); return i; };
const orig = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'analysis', 'orig_data', f), 'utf8'));
const RAW = orig('weapons.json').weapons;

// 평평한 시험장: 테두리 바위, y>=300 은 흙, 나머지는 빈 공간. 지렁이는 바닥 위에 오른쪽을 보고 섬. 보너스 상자 무작위 출현은 끔
function arena(n, opts, lo) {
  const T = new C.Terrain(7);
  for (let y = 0; y < C.MH; y++) for (let x = 0; x < C.MW; x++) {
    const edge = x < 3 || y < 3 || x >= C.MW - 3 || y >= C.MH - 3;
    T.t[y * C.MW + x] = edge ? 2 : y >= 300 ? 1 : 0;
  }
  const ps = []; for (let i = 0; i < n; i++) ps.push({ name: 'p' + i, color: '#ff6b6b', lo: lo && lo.map(W) });
  const sim = new C.Sim(7, ps, 99, T, opts);
  sim.cd = 0; sim.spawnItem = () => {};
  sim.worms.forEach((w, i) => { w.x = 200 + i * 100; w.y = 295; w.vx = w.vy = 0; w.f = 1; w.aim = 0; w.hp = 100; w.alive = true; });
  return sim;
}
const inp = (sim, m) => sim.worms.map((w, i) => ({ m: i === 0 ? m : 0, sw: null, rp: null }));
function run(sim, ticks, m, hold) { for (let i = 0; i < ticks; i++) sim.step(inp(sim, (hold || i === 0) ? (m || 0) : 0)); }
const count = (sim, t) => sim.projs.filter(p => p.t === t).length;
const booms = (sim, from) => sim.ops.filter(o => o[0] > from && o[4] === 1).length;

test('무기 표: 원작 40종이 추출 자료와 같은 값으로 들어 있음 + 자체 무기 1종', () => {
  assert.strictEqual(C.NW, 41);
  RAW.forEach((r, i) => {
    const w = C.WEAPON_RAW[i];
    assert.deepStrictEqual([w.ammo, w.load, w.delay || 0, w.parts || 1, w.speed, w.dist || 0, w.recoil || 0, w.grav || 0, w.hit || 0, w.blow || 0, w.bounce || 0, w.tte || 0],
      [r.ammo, r.loadingTime, r.delay, r.parts, r.speed, r.distribution, r.recoil, r.gravity, r.hitDamage, r.blowAway, r.bounce, r.timeToExplo], r.name);
  });
  assert.ok(C.WEAPONS[40].x, '텔레포트 건은 자체 무기 표시');
});

test('무기 표: 동작 플래그·파편·궤적, 파편표(NOBJ_RAW), 폭발체표(SOBJ)도 추출 자료와 같음', () => {
  const b = v => (v ? 1 : 0), ex = v => (v == null ? -1 : v);
  const RS = orig('sobjects.json'), so = RS.sobjects || RS;
  // 궤적 폭발체가 피해·범위·지형 효과가 모두 없는 것(연기 등 화면 효과)이면 옮기지 않음
  const trail = (t, dl) => (t >= 0 && (so[t].damage || so[t].detectRange || so[t].dirtEffect >= 0) ? [t, dl] : null);
  RAW.forEach((r, i) => {
    const w = C.WEAPON_RAW[i];
    assert.deepStrictEqual(
      [w.dd || 0, b(w.wc), b(w.we), b(w.eg), b(w.abe), ex(w.ex), ex(w.dirt), w.add || 0, w.mult == null ? 100 : w.mult, w.st || 0, w.ttev || 0, b(w.abw), b(w.chain), b(w.cwo), b(w.sight),
        w.spl || [0, -1, 0], w.ot || null, w.pt || null],
      [r.detectDistance, b(r.wormCollide), b(r.wormExplode), b(r.explGround), b(r.affectByExplosions), r.createOnExp, r.dirtEffect, r.addSpeed, r.multSpeed, r.shotType, r.timeToExploV, b(r.affectByWorm), b(r.chainExplosion), b(r.collideWithObjects), b(r.laserSight),
        r.splinterAmount ? [r.splinterAmount, r.splinterType, r.splinterScatter] : [0, -1, 0], trail(r.objTrailType, r.objTrailDelay), r.partTrailObj >= 0 ? [r.partTrailObj, r.partTrailDelay, r.partTrailType] : null], r.name);
  });
  const RN = orig('nobjects.json').nobjects; assert.strictEqual(C.NOBJ_RAW.length, RN.length);
  RN.forEach((r, i) => {
    const w = C.NOBJ_RAW[i];
    assert.deepStrictEqual(
      [w.speed, w.sv || 0, w.dist || 0, w.grav || 0, w.bounce || 0, w.hit || 0, w.blow || 0, w.dd || 0, b(w.wc), b(w.we), b(w.eg), b(w.abe), ex(w.ex), ex(w.dirt), w.tte || 0, w.ttev || 0,
        w.spl ? [w.spl[0], w.spl[1]] : [0, -1], w.ot || null],
      [r.speed, r.speedV, r.distribution, r.gravity, r.bounce, r.hitDamage, r.blowAway, r.detectDistance, b(r.wormDestroy), b(r.wormExplode), b(r.explGround), b(r.affectByExplosions), r.createOnExp, r.dirtEffect, r.timeToExplo, r.timeToExploV,
        r.splinterAmount ? [r.splinterAmount, r.splinterType] : [0, -1], trail(r.leaveObj, r.leaveObjDelay)], 'N' + i + ' ' + r.name);
  });
  assert.strictEqual(C.SOBJ.length, so.length);
  so.forEach((r, i) => assert.deepStrictEqual(C.SOBJ[i], [r.damage, r.detectRange, r.detectRange ? r.blowAway : 0, r.dirtEffect], 'S' + i + ' ' + r.name)); // 범위 0 이면 밀어내기는 쓰이지 않음
});

test('바주카: 탄창 3, 자체 추진으로 가속, 직격 12 + 큰 폭발 + 파편', () => {
  const sim = arena(2, null, ['바주카']); const wp = C.WEAPONS[W('바주카')];
  assert.deepStrictEqual([wp.ammo, wp.reload, wp.delay], [3, 351, 75]); // delay 는 원작 프레임 단위 그대로
  run(sim, 2, C.B_F);
  const p = sim.projs.find(q => q.t === 2), v0 = Math.hypot(p.vx, p.vy);
  run(sim, 10); assert.ok(Math.hypot(p.vx, p.vy) > v0, '가속');
  run(sim, 60);
  assert.ok(sim.worms[1].hp <= 100 - 12 - 10, '직격+폭발 피해: ' + sim.worms[1].hp);
});

test('빅 누크: 도화선 뒤 자탄 50개로 갈라지며 슬로모션, 이후 자탄이 큰 폭발', () => {
  const sim = arena(1, null, ['빅 누크']); sim.worms[0].aim = -1;
  run(sim, 128, C.B_F); assert.strictEqual(count(sim, 20), 0);
  let split = false; for (let i = 0; i < 25 && !split; i++) { run(sim, 1); split = count(sim, 20) > 0; }
  assert.strictEqual(count(sim, 20), 50); assert.ok(sim.slow > 0, '슬로모션 시작');
  const before = sim.opId; run(sim, 150 + 180);
  assert.strictEqual(sim.slow, 0); assert.strictEqual(count(sim, 20), 0);
  assert.ok(sim.opId - before >= 50, '자탄 폭발');
});

test('부비 트랩: 전송 형식이 보너스 상자와 같고, 닿으면 폭발', () => {
  const sim = arena(2, null, ['부비 트랩']);
  run(sim, 40, C.B_F);
  const trap = sim.projs.find(p => p.t === 21); assert.ok(trap);
  const item = sim.obj(C.ITEM_DEF, 100, 100, 0, 0, -1, 1); item.k = trap.k;
  const a = sim.projEnc(trap, true), b = sim.projEnc(item, true);
  assert.deepStrictEqual([a.length, a[0], a[3]], [b.length, b[0], b[3]]);
  sim.worms[1].x = trap.x; sim.worms[1].y = trap.y; run(sim, 2);
  assert.ok(sim.worms[1].hp <= 100 - 5 - 10, '직격 5 + 큰 폭발: ' + sim.worms[1].hp);
});

test('보너스 상자: 체력 상자를 먹으면 회복, 폭발 범위에 들면 사라짐', () => {
  const sim = arena(1); const w = sim.worms[0]; w.hp = 40;
  const it = sim.obj(C.ITEM_DEF, w.x, w.y - 2, 0, 0, -1, 1); it.k = 0; it.life = 500; run(sim, 3);
  assert.ok(w.hp >= 50 && w.hp <= 100, '10~60 회복: ' + w.hp);
  const it2 = sim.obj(C.ITEM_DEF, 500, 290, 0, 0, -1, 1); it2.k = 1; it2.life = 500; run(sim, 2);
  sim.sobj(500, 292, 0, -1, 1); run(sim, 2);
  assert.strictEqual(count(sim, 21), 0);
});

test('치키타 폭탄: 지렁이에 닿아도 안 터지고 도화선 뒤 자탄 22개', () => {
  const sim = arena(2, null, ['치키타 폭탄']); sim.worms[1].x = 215;
  run(sim, 100, C.B_F); assert.strictEqual(count(sim, 6), 1, '도화선 전에는 그대로');
  let n = 0; for (let i = 0; i < 40 && !n; i++) { run(sim, 1); n = count(sim, 7); }
  assert.strictEqual(n, 22);
});

test('흙덩이: 지렁이를 통과하고 시간이 지나면 흙을 만듦(몸은 묻히지 않음)', () => {
  const sim = arena(2, null, ['흙덩이']); sim.worms[1].x = 212; const before = sim.opId;
  run(sim, 75, C.B_F);
  assert.strictEqual(sim.worms[1].hp, 100);
  assert.ok(sim.ops.filter(o => o[0] > before && o[4] === 4).length >= 2, '흙 채우기 연산');
  assert.ok(sim.worms.every(w => !sim.hit(w.x, w.y)), '몸이 묻히면 안 됨');
});

test('선풍기: 피해 없이 밀어내고 다른 탄도 밀어냄', () => {
  const sim = arena(2, null, ['선풍기']); sim.worms[1].x = 230;
  const g = sim.obj(C.WEAPONS[W('수류탄')], 215, 280, 0, 0, 1, 1); g.life = 9999; const gx = g.x;
  run(sim, 60, C.B_F, true);
  assert.strictEqual(sim.worms[1].hp, 100); assert.ok(sim.worms[1].x > 232, '밀려남: ' + sim.worms[1].x);
  assert.ok(g.x > gx + 1, '수류탄도 밀림: ' + g.x);
});

test('부유 지뢰: 공중에 떠 있다가 닿으면 폭발', () => {
  const sim = arena(2, null, ['부유 지뢰']); sim.worms[0].y = 150; sim.worms[0].aim = 0;
  run(sim, 1, C.B_F); sim.worms[0].y = 295; run(sim, 400);
  const m = sim.projs.find(p => p.t === 8); assert.ok(m, '지뢰가 남아 있음');
  assert.ok(m.y < 200 && Math.hypot(m.vx, m.vy) < .1, `공중에 멈춤 y=${m.y} v=${Math.hypot(m.vx, m.vy)}`);
  sim.worms[1].x = m.x; sim.worms[1].y = m.y; sim.worms[1].vy = 0; run(sim, 1);
  assert.ok(sim.worms[1].hp < 100 && count(sim, 8) === 0);
});

test('가우스 건: 강한 반동(재장전 0 이면 비행), 벽에 붙어 쏘면 자기도 피해, 폭발 5회분', () => {
  const sim = arena(2, null, ['가우스 건']); run(sim, 1, C.B_F);
  assert.ok(sim.worms[0].vx < -.5, '반동 0.9px/프레임: ' + sim.worms[0].vx);
  run(sim, 20); assert.ok(sim.worms[1].hp <= 60, '중간 폭발 5회 중첩: ' + sim.worms[1].hp);
  const fly = arena(1, { rl0: true }, ['가우스 건']); fly.worms[0].aim = 1.45; run(fly, 120, C.B_F, true);
  assert.ok(fly.worms[0].y < 250, '아래로 연사해 떠오름: ' + fly.worms[0].y);
  const near = arena(1, null, ['가우스 건']); near.worms[0].x = C.MW - 14; run(near, 4, C.B_F);
  assert.ok(near.worms[0].hp < 100, '근접 폭발 피해');
});

test('헬레이더: 날아가며 폭발을 남기고 끝에 자탄 10개', () => {
  const sim = arena(1, null, ['헬레이더']); sim.worms[0].aim = -1; const before = sim.opId;
  run(sim, 60, C.B_F); assert.ok(booms(sim, before) >= 6, '궤적 폭발: ' + booms(sim, before));
  let n = 0; for (let i = 0; i < 80 && !n; i++) { run(sim, 1); n = count(sim, 7); }
  assert.strictEqual(n, 10);
});

test('레이저: 탄창 80·프레임당 1 피해(원작 70발/초), 맵을 가로질러 닿고, 흙을 뚫음', () => {
  const sim = arena(2, null, ['레이저']); const wp = C.WEAPONS[W('레이저')];
  assert.deepStrictEqual([wp.ammo, wp.delay, wp.reload, wp.hit], [80, 1, 343, 1]);
  sim.worms[0].x = 20; sim.worms[1].x = 600; // 580px (예전 사거리 320 밖)
  run(sim, 10, C.B_F, true); assert.strictEqual(sim.worms[1].hp, 88); // 10틱 = 11.67프레임 → 프레임 0~11 에 12발
  const cg = arena(1, null, ['체인건']); cg.worms[0].aim = -1; run(cg, 60, C.B_F, true); // delay 3 → 3프레임 주기: 1초(70프레임)에 24발(프레임 0,3,...,69)
  assert.strictEqual(C.WEAPONS[W('체인건')].ammo - cg.worms[0].ammo[W('체인건')], 24);
  sim.worms[1].alive = false;
  assert.ok(C.aimRay(sim.T, sim.worms, 0, wp.range).x >= C.MW - 5, '맵 가장자리까지');
  sim.worms[0].aim = .5; const before = sim.opId; run(sim, 5, C.B_F, true);
  assert.ok(sim.ops.some(o => o[0] > before && o[4] === 3 && o[3] === 2), '흙에 지름 5px 구멍');
});

test('미사일: 발사 뒤 좌우 키로 방향을 바꾸고 그동안 지렁이는 걷지 않음', () => {
  const sim = arena(1, null, ['미사일']); const w = sim.worms[0];
  run(sim, 1, C.B_F); const x0 = w.x; run(sim, 25, C.B_L, true);
  const p = sim.projs.find(q => q.t === 15); assert.ok(p, '미사일 비행 중');
  assert.ok(p.vy < -1, '왼쪽 키 = 반시계로 꺾여 위로: ' + p.vy);
  assert.ok(Math.abs(w.x - x0) < 4, '조종 중 걷지 않음');
});

test('라이플: 한 발 장전, 직격 34, 지렁이에 맞으면 폭발 없음, 조준선 표시', () => {
  const sim = arena(2, null, ['라이플']); const before = sim.opId;
  run(sim, 10, C.B_F);
  assert.strictEqual(sim.worms[1].hp, 66);
  assert.strictEqual(booms(sim, before), 0);
  assert.ok(sim.worms[0].rl[W('라이플')] > 0 && C.WEAPONS[W('라이플')].sight);
});

test('스파이크볼: 8개가 깔리고, 밟으면 9 피해, 오래되면 작게 터지며 사라짐', () => {
  const sim = arena(2, null, ['스파이크볼']); sim.worms[1].x = 500;
  run(sim, 200, C.B_F); assert.strictEqual(count(sim, 16), 8);
  const s = sim.projs.find(p => p.t === 16); sim.worms[1].x = s.x; sim.worms[1].y = s.y; run(sim, 1);
  assert.ok(sim.worms[1].hp <= 91 && sim.worms[1].hp >= 100 - 9 * 8, '피해: ' + sim.worms[1].hp);
  sim.worms[1].x = 500; const before = sim.opId; run(sim, 420);
  assert.strictEqual(count(sim, 16), 0); assert.ok(booms(sim, before) >= 1);
});

test('원작 사양으로 교체한 기존 무기: 산탄총 15발, 수류탄 통과·파편 50, 화염방사기 2발·흙 태움, 블래스터 통과', () => {
  const sg = arena(1, null, ['산탄총']); run(sg, 1, C.B_F); run(sg, 1); assert.strictEqual(count(sg, 1), 15);
  const gr = arena(2, null, ['수류탄']); gr.worms[1].x = 212; run(gr, 85, C.B_F); assert.strictEqual(count(gr, 3), 1, '닿아도 안 터짐');
  let n = 0; for (let i = 0; i < 20 && !n; i++) { run(gr, 1); n = count(gr, 23); } assert.strictEqual(n, 50);
  const fl = arena(1, null, ['화염방사기']); fl.worms[0].aim = .6; const before = fl.opId; run(fl, 1, C.B_F); run(fl, 1); assert.strictEqual(count(fl, 5), 2);
  run(fl, 40, C.B_F, true); assert.ok(fl.ops.some(o => o[0] > before && o[4] === 3), '흙을 태움');
  const bl = arena(2, null, ['블래스터']); bl.worms[1].x = 215; bl.worms[0].aim = 0; run(bl, 12, C.B_F); assert.strictEqual(bl.worms[1].hp, 100, '지렁이 통과');
});

test('재장전: 들고 있는 무기만 진행, 재장전 시간 0 옵션이면 바로 채워짐', () => {
  const sim = arena(1, null, ['라이플', '레이저']); const w = sim.worms[0], ri = W('라이플');
  run(sim, 1, C.B_F); const rl = w.rl[ri]; assert.strictEqual(rl, C.WEAPONS[ri].reload);
  sim.step([{ m: 0, sw: 0, rp: null }]); sim.step([{ m: 0, sw: 1, rp: null }]); run(sim, 30);
  assert.ok(rl - w.rl[ri] <= 2, '다른 무기를 든 동안은 멈춤');
  const on = arena(1, { rl0: true }, ['라이플']); run(on, 1, C.B_F);
  assert.deepStrictEqual([on.worms[0].ammo[ri], on.worms[0].rl[ri], on.snapshot({ id: 'x', pl: ['a'] }).r0], [1, 0, 1]);
});

test('무기 선택: 고른 무기 안에서만 바뀜, 잘못된 값은 정리', () => {
  const sim = arena(1, null, ['라이플', '레이저']); const w = sim.worms[0], lo = w.lo;
  sim.step([{ m: 0, sw: 0, rp: null }]); sim.step([{ m: 0, sw: 1, rp: null }]); assert.strictEqual(w.w, lo[1]);
  sim.step([{ m: 0, sw: 2, rp: null }]); assert.strictEqual(w.w, lo[0]);
  sim.step([{ m: 0, sw: 2, rp: null, wq: 0, wd: W('수류탄') }]); sim.step([{ m: 0, sw: 2, rp: null, wq: 1, wd: W('수류탄') }]);
  assert.strictEqual(w.w, lo[0], '고르지 않은 무기로는 못 바꿈');
  assert.deepStrictEqual(C.normLo([1, 1, 999, 'x', 2, 3, 4, 5, 6]), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(C.normLo(null), C.DEF_LO); assert.strictEqual(C.botLo().length, C.LOADOUT_N);
});

test('슬로모션: 서버 시뮬레이션이 1/SLOW_DIV 속도로 진행', () => {
  const sim = arena(1); sim.worms[0].y = 100; sim.slowmo(90); run(sim, 90);
  const ref = arena(1); ref.worms[0].y = 100; run(ref, 90 / C.SLOW_DIV);
  assert.ok(Math.abs(sim.worms[0].y - ref.worms[0].y) < 1e-6);
  assert.deepStrictEqual([sim.slow, sim.tick], [0, 90]);
});

test('폭발 상한과 스냅샷 예산: 폭발·발사체가 몰려도 3700바이트 이내, 새 지형 연산은 빠짐없이', () => {
  const sim = arena(6); sim.worms.forEach((w, i) => { w.name = '가나다라마바사아자차'; w.x = 60 + i * 100; });
  const meta = { id: 'abcdefgh', pl: sim.worms.map((w, i) => 'peer' + String(i).padStart(12, '0')) };
  sim.snapshot(meta); const start = sim.opId;
  for (let i = 0; i < 30; i++) sim.sobj(40 + i * 18, 320, 2, -1, 1); // 같은 틱에 30번
  assert.strictEqual(sim.opId - start, C.BOOM_TICK, '틱당 폭발 수 상한');
  for (let i = 0; i < 700; i++) { const p = sim.obj(C.WEAPONS[W(i % 3 ? '수류탄' : '집속탄')], 10 + (i * 37) % 620, 10 + (i * 53) % 280, 0, 0, i % 6, 1); p.life = 99999; }
  const seen = new Set(); let maxLen = 0, sent = 0;
  for (let t = 0; t < 6; t++) { run(sim, 1); if (t % 2) { const g = sim.snapshot(meta); maxLen = Math.max(maxLen, C.utf8len(JSON.stringify(g))); for (const o of g.o) seen.add(o[0]); sent = C.decodeSnap(g).projs.length; } }
  assert.ok(maxLen <= C.SNAP_MAX, '스냅샷 크기 ' + maxLen);
  for (let id = start + 1; id <= start + 30; id++) assert.ok(seen.has(id), '지형 연산 누락: ' + id);
  assert.ok(sim.projs.length <= C.PROJ_MAX, '발사체 총 상한: ' + sim.projs.length);
  assert.ok(sent >= 150, '스냅샷에 실린 발사체 수 ' + sent);
  console.log(`    스냅샷 최대 ${maxLen}바이트, 발사체 ${sim.projs.length}개 중 ${sent}개 전송`);
});

test('전 무기 스모크: 41종을 봇 4명이 재장전 0 으로 쏴도 오류·NaN 없이 예산 이내', () => {
  let worst = 0;
  for (let wi = 0; wi < C.NW; wi++) {
    const T = new C.Terrain(31 + wi), ps = [0, 1, 2, 3].map(i => ({ name: 'b' + i, color: '#ff6b6b', lo: [wi] }));
    const sim = new C.Sim(31 + wi, ps, 999, T, { rl0: true }); sim.cd = 0; const bots = ps.map(() => new C.Bot());
    for (let t = 0; t < 500; t++) {
      sim.step(sim.worms.map((w, j) => { const o = bots[j].think(sim, w); o.m |= C.B_F; return o; }));
      if (t % 2 === 0) worst = Math.max(worst, C.utf8len(JSON.stringify(sim.snapshot({ id: 'abcdefgh', pl: ['a', 'b', 'c', 'd'] }))));
    }
    assert.ok(sim.projs.length <= C.PROJ_MAX, C.WEAPONS[wi].n);
    for (const w of sim.worms) assert.ok(Number.isFinite(w.x + w.y + w.vx + w.vy + w.hp), 'NaN: ' + C.WEAPONS[wi].n);
    for (const p of sim.projs) assert.ok(Number.isFinite(p.x + p.y), 'NaN 탄: ' + C.WEAPONS[wi].n);
  }
  assert.ok(worst <= C.SNAP_MAX, '스냅샷 최대 ' + worst);
});

test('재장전 0 으로 6명이 계속 쏴도: 남의 탄을 밀어내지 않고, 도화선 무기가 터지고, 슬로모션이 계속되지 않음', () => {
  const guns = ['지뢰', '수류탄', '빅 누크', '집속탄', '크래클러', '치키타 폭탄'];
  const T = new C.Terrain(7);
  for (let y = 0; y < C.MH; y++) for (let x = 0; x < C.MW; x++) T.t[y * C.MW + x] = (x < 3 || y < 3 || x >= C.MW - 3 || y >= C.MH - 3) ? 2 : y >= 300 ? 1 : 0;
  const sim = new C.Sim(7, guns.map((g, i) => ({ name: 'p' + i, color: '#ff6b6b', lo: [W(g)] })), 9999, T, { rl0: true }); sim.cd = 0; sim.spawnItem = () => {};
  const done = new Map(), burst = sim.burst.bind(sim); sim.burst = p => { done.set(p.def, (done.get(p.def) || 0) + 1); burst(p); };
  let slow = 0, mines = 0; const N = 1800;
  for (let t = 0; t < N; t++) {
    sim.worms.forEach(w => { w.aim = -1; });
    sim.step(sim.worms.map(() => ({ m: C.B_F, sw: null, rp: null })));
    if (sim.slow > 0) slow++;
    mines = Math.max(mines, sim.projs.filter(p => p.owner === 0 && p.t === 8).length);
    assert.ok(sim.projs.length <= C.PROJ_MAX);
  }
  for (const g of guns.slice(1)) assert.ok(done.get(C.WEAPONS[W(g)]) > 0, g + ' 본체가 도화선까지 가서 터짐');
  for (const [n, nm] of [[9, '누크 자탄'], [8, '집속탄 자탄'], [14, '치키타 자탄']]) assert.ok(done.get(C.NOBJ[n]) > 0, nm + '이 터짐');
  assert.ok(mines <= C.INST_MAX, '소유자당 지뢰 상한: ' + mines);
  assert.ok(slow / N < .35, '슬로모션 비율: ' + (slow / N).toFixed(2));
});

// ---- 3단계: 지렁이 기본 물리(원작 constants.json 기준, 60틱 환산) ----
test('지렁이 물리: 점프 높이 약 16px, 걷기 정속 약 31px/초 이하, 벽에 빠르게 부딪히면 1/3 로 튕김', () => {
  const sim = arena(1); const w = sim.worms[0]; run(sim, 60); const y0 = w.y; // 바닥에 내려앉은 뒤
  let top = w.y; sim.step(inp(sim, C.B_J)); for (let i = 0; i < 160; i++) { sim.step(inp(sim, C.B_J)); top = Math.min(top, w.y); } // 착지 때 작은 되튐(원작 MinBounce)까지 가라앉은 뒤
  assert.ok(y0 - top > 13 && y0 - top < 19, '점프 높이: ' + (y0 - top));
  assert.ok(Math.abs(w.y - y0) < 1.5, '누르고 있어도 다시 뛰지 않음');
  const x0 = w.x; run(sim, 120, C.B_R, true);
  const v = (w.x - x0) / 120 * 60; assert.ok(v > 18 && v < 32, '걷기 속도(px/초): ' + v);
  w.x = C.MW - 30; w.y = 200; w.vx = 3; w.vy = 0; run(sim, 12);
  assert.ok(w.vx < -.5 && w.vx > -1.2, '벽 반사: ' + w.vx);
});

test('닌자 로프: 붙으면 줄 길이 28px 로 갈고리 쪽으로 끌려가고, 점프 키로 놓음', () => {
  const sim = arena(1); const w = sim.worms[0]; w.aim = -1.2; w.y = 200; // 공중에서 위쪽 천장(바위)으로
  sim.step([{ m: 0, sw: null, rp: 0 }]); sim.step([{ m: 0, sw: null, rp: 1 }]);
  for (let i = 0; i < 200 && !(w.rope && w.rope.st === 2); i++) sim.step([{ m: 0, sw: null, rp: 1 }]);
  assert.ok(w.rope && w.rope.st === 2, '천장에 붙음'); assert.ok(Math.abs(w.rope.len - 450 / 16) < 1e-9);
  const y0 = w.y; for (let i = 0; i < 120; i++) sim.step([{ m: 0, sw: null, rp: 1 }]);
  assert.ok(w.y < y0 - 60, '끌려 올라감: ' + (y0 - w.y));
  sim.step([{ m: C.B_J, sw: null, rp: 1 }]); assert.strictEqual(w.rope, null);
});

test('파기: 누를 때 조준 방향 앞에 구멍을 내고 몸을 밀어 주지 않음', () => {
  const sim = arena(1); const w = sim.worms[0]; w.aim = 1.2; run(sim, 3); const before = sim.opId, x0 = w.x, y0 = w.y;
  sim.step(inp(sim, C.B_G));
  assert.ok(sim.ops.some(o => o[0] > before && o[4] === 0 && o[3] === 3), '지름 7px 파기 연산');
  assert.ok(Math.abs(w.vx) < .01 && Math.abs(w.x - x0) < .5 && w.y - y0 < 4, '추진 없음');
  // 원작 ableToDig: 누르고 있으면 반복하지 않고, 뗐다 다시 누르면(좌+우 동시 포함) 1회
  const digs = () => sim.ops.filter(o => o[4] === 0 && o[3] === 3).length;
  const d0 = digs(); run(sim, 40, C.B_G, true); assert.strictEqual(digs(), d0, '누르고 있는 동안 반복 없음');
  sim.step(inp(sim, 0)); sim.step(inp(sim, C.B_L | C.B_R)); assert.ok(digs() > d0, '다시 누르면 1회');
});

test('닌자 로프: 날아가는 갈고리가 250px 를 넘어도 사라지지 않고 지렁이 쪽으로 돌아옴', () => {
  const sim = arena(1); const w = sim.worms[0]; w.x = 100; w.aim = -.5;
  sim.step([{ m: 0, sw: null, rp: 0 }]); let far = 0, d = 0;
  for (let i = 0; i < 134; i++) { sim.step([{ m: 0, sw: null, rp: 1 }]); assert.ok(w.rope && w.rope.st === 1, '갈고리 유지: ' + i); d = Math.hypot(w.rope.x - w.x, w.rope.y - w.y); far = Math.max(far, d); }
  assert.ok(far > 250 && d < 250, '최대 ' + far.toFixed(1) + ' → ' + d.toFixed(1));
});

test('봇: 봇끼리만 두어도 멈추지 않고 교전이 이어짐(예전에 영구 정지하던 지형 2개, 5분씩)', () => {
  const rnd = Math.random;
  try {
    for (const seed of [1000, 8919]) {
      let a = seed ^ 0x5bd1e995; // 고정 난수(재현용)
      Math.random = () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      const T = new C.Terrain(seed), ps = [0, 1, 2, 3].map(i => ({ name: 'b' + i, color: '#ff6b6b', lo: C.botLo() }));
      const sim = new C.Sim(seed, ps, 9999, T, {}); sim.cd = 0; const bots = ps.map(() => new C.Bot());
      let lastDeath = 0, gap = 0, deaths = 0;
      for (let t = 1; t <= 18000; t++) {
        sim.step(sim.worms.map((w, j) => bots[j].think(sim, w)));
        const d = sim.worms.reduce((x, w) => x + w.deaths, 0); if (d !== deaths) { deaths = d; lastDeath = t; }
        gap = Math.max(gap, t - lastDeath);
      }
      assert.ok(gap < 120 * 60, '아무도 죽지 않은 가장 긴 구간 ' + (gap / 60 | 0) + '초 (지형 ' + seed + ')');
      assert.ok(deaths >= 15, '5분 동안 사망 ' + deaths + '회 (지형 ' + seed + ')');
    }
  } finally { Math.random = rnd; }
});

test('퇴장: 나간 사람이 남긴 탄으로는 킬·승리가 오르지 않고 맞은 쪽 데스만 기록', () => {
  const sim = arena(3, null, ['라이플']); sim.k = 1; sim.worms[1].hp = 10;
  const hold = () => sim.worms.forEach((w, i) => { if (w.alive) { w.x = 200 + i * 100; w.y = 295; w.vx = w.vy = 0; } });
  let fired = false;
  for (let t = 0; t < 300 && sim.worms[1].deaths === 0; t++) {
    sim.step([{ m: fired ? 0 : C.B_F, sw: null, rp: null }, null, null]); hold();
    if (!fired && sim.projs.some(p => p.owner === 0)) { fired = true; sim.drop(0); }
  }
  assert.deepStrictEqual([sim.worms[1].deaths, sim.worms.map(w => w.kills), sim.over, sim.winner], [1, [0, 0, 0], false, -1]);
});

test('킬 집계: 자폭·가해자 없는 사망은 킬 불변(데스만 +1), 타인에게 죽으면 가해자 킬 +1 (원작 worm.cpp 448~451행)', () => {
  const sim = arena(2);
  sim.hurt(sim.worms[0], 999, 0, -1);  // 자폭
  sim.worms[0].alive = true; sim.worms[0].hp = 100;
  sim.hurt(sim.worms[0], 999, -1, -1); // 가해자 없음
  assert.deepStrictEqual([sim.worms.map(w => w.kills), sim.worms.map(w => w.deaths)], [[0, 0], [2, 0]]);
  sim.hurt(sim.worms[1], 999, 0, -1);  // 0번이 1번을 죽임
  assert.deepStrictEqual([sim.worms.map(w => w.kills), sim.worms.map(w => w.deaths)], [[1, 0], [2, 1]]);
});

test('끼임: 몸 안쪽에 바위 1px 이 있어도 갇히지 않고, 예전에 봇이 갇히던 지형(32676)에서 10분 동안 60초 넘게 제자리인 봇이 없음', () => {
  const sim = arena(1); const w = sim.worms[0];
  for (let y = 300; y < C.MH; y++) for (let x = 0; x < C.MW; x++) sim.T.t[y * C.MW + x] = 2;
  w.x = 320.5; w.y = 296.5; sim.T.t[296 * C.MW + 321] = 2; // 몸 중심 바로 옆 바위 1px
  run(sim, 300, C.B_R, true); assert.ok(w.x > 380, '걸어서 빠져나옴: x ' + w.x.toFixed(1));
  const rnd = Math.random;
  try {
    const seed = 32676; let a = seed ^ 0x5bd1e995;
    Math.random = () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const T = new C.Terrain(seed), ps = [0, 1, 2, 3].map(i => ({ name: 'b' + i, color: '#ff6b6b', lo: C.botLo() }));
    const g = new C.Sim(seed, ps, 9999, T, {}); g.cd = 0; const bots = ps.map(() => new C.Bot());
    const an = g.worms.map(o => ({ x: o.x, y: o.y, t: 0 })); let idle = 0;
    for (let t = 1; t <= 36000; t++) {
      g.step(g.worms.map((o, j) => bots[j].think(g, o)));
      g.worms.forEach((o, i) => { const p = an[i]; if (!o.alive || Math.hypot(o.x - p.x, o.y - p.y) > 12) an[i] = { x: o.x, y: o.y, t }; else idle = Math.max(idle, t - p.t); });
    }
    assert.ok(idle < 3600, '가장 오래 제자리였던 시간 ' + (idle / 60 | 0) + '초');
  } finally { Math.random = rnd; }
});

test('봇 추적 모드: ① 20초 무교전이면 가장 가까운 사람(사람 정보가 없으면 가장 가까운 상대) ② 사람이 20초 넘게 혼자 있으면 교전 중이 아닌 가장 가까운 봇이 찾아감', () => {
  // eng: 매 틱 봇의 마지막 교전 시각을 '지금 - eng 틱'으로 덮어씀(null 이면 그대로 둠). 1200틱 미만이면 ①은 일어나지 않음
  const mk = (hum, eng) => { const sim = arena(3); const [h, b, o] = sim.worms; h.x = 100; b.x = 400; o.x = 440; const bot = new C.Bot(); bot.hum = hum;
    for (let t = 0; t < 1300; t++) { if (eng != null && bot.hunt < 0) bot.eng = bot.n - eng; bot.think(sim, b); sim.worms.forEach(w => { w.hp = 100; w.alive = true; }); } return bot; };
  const bot = mk([0], null); assert.deepStrictEqual([bot.hunt, bot.tg], [0, 0], '①: 더 가까운 봇을 두고도 사람을 목표로 고정');
  assert.strictEqual(mk(null, null).hunt, 2, '①: 사람 정보가 없으면 가장 가까운 상대를 추적');
  const b2 = mk([0], 400); assert.deepStrictEqual([b2.hunt, b2.tg], [0, 0], '②: ①이 막힌 상태(마지막 교전 400틱 전)에서도 혼자 있는 사람을 찾아감');
  assert.strictEqual(mk([0], 0).hunt, -1, '②: 방금까지 교전하던 봇은 빼내지 않음');
});

test('발사 간격은 무기별: 산탄총을 쏜 직후 다른 무기로 바꾸면 다음 틱에 바로 나가고, 들고 있지 않은 무기의 간격도 계속 줄어듦', () => {
  const sim = arena(1, null, ['산탄총', '권총']); const w = sim.worms[0], sg = W('산탄총'), hg = W('권총');
  sim.step([{ m: 0, sw: 0, rp: null }]); sim.step([{ m: C.B_F, sw: 0, rp: null }]);
  assert.strictEqual(w.ammo[sg], C.WEAPONS[sg].ammo - 1, '산탄총 1발');
  sim.step([{ m: 0, sw: 1, rp: null }]); assert.strictEqual(w.w, hg); // 전환
  sim.step([{ m: C.B_F, sw: 1, rp: null }]);
  assert.strictEqual(w.ammo[hg], C.WEAPONS[hg].ammo - 1, '전환 다음 틱에 권총 발사(산탄총의 남은 간격을 물려받지 않음)');
  assert.ok(w.cd[sg] > 40, '산탄총 간격은 따로 남아 있음: ' + w.cd[sg]);
  sim.step([{ m: C.B_F, sw: 2, rp: null }]); assert.strictEqual(w.ammo[sg], C.WEAPONS[sg].ammo - 1, '되돌아와도 산탄총은 자기 간격(57프레임)이 끝나기 전에는 안 나감');
  run(sim, Math.ceil(57 / C.FR)); assert.strictEqual(w.cd[hg], 0, '들고 있지 않은 권총의 간격도 줄어듦');
  sim.step([{ m: C.B_F, sw: 2, rp: null }]); assert.strictEqual(w.ammo[sg], C.WEAPONS[sg].ammo - 2, '간격이 끝나면 발사');
});

test('파기 누름 카운터(dg): 눌림 비트 없이 카운터만 바뀌어도 1회, 슬로모션으로 건너뛴 틱의 탭도 다음 진행 틱에 반영 / 갈고리 비행 중 감기', () => {
  const sim = arena(1); const w = sim.worms[0]; w.aim = 1.2; run(sim, 3);
  const digs = () => sim.ops.filter(o => o[4] === 0 && o[3] === 3).length, st = (m, dg) => sim.step([{ m, sw: null, rp: null, dg }]);
  st(0, 0); let d0 = digs(); st(0, 1); assert.ok(digs() > d0, '같은 틱 안에 눌렀다 뗀 탭(비트 0, 카운터 +1)');
  d0 = digs(); st(C.B_G, 2); const d1 = digs(); assert.ok(d1 > d0); st(C.B_G, 2); assert.strictEqual(digs(), d1, '비트와 카운터가 함께 와도 1회, 누르고 있으면 반복 없음');
  st(0, 2); sim.slow = 30; d0 = digs(); let n = 0;
  while (n < 6) { st(0, 3); n++; if (!sim.skip) break; assert.strictEqual(digs(), d0); } // 건너뛰는 틱에 탭(이미 뗀 상태)
  assert.ok(!sim.skip && digs() > d0, '슬로모션 중 탭 반영');
  const rs = arena(1); const r = rs.worms[0]; r.x = 100; r.aim = -.5;
  rs.step([{ m: 0, sw: null, rp: 0 }]); rs.step([{ m: 0, sw: null, rp: 1 }]); for (let i = 0; i < 10; i++) rs.step([{ m: C.B_RI, sw: null, rp: 1 }]);
  assert.ok(r.rope && r.rope.st === 1 && r.rope.len < C.ROPE_MAX - 10, '날아가는 중에도 줄 길이가 줄어듦: ' + (r.rope && r.rope.len));
});

test('모바일 스틱: 갈고리가 날아가는 중 스틱 위는 감기이고 점프가 아니어서 로프를 놓지 않음(나가 있지 않으면 점프)', () => {
  assert.deepStrictEqual([C.stickBits(0, -1, true), C.stickBits(0, 1, true), C.stickBits(0, -1, false)], [C.B_RI, C.B_RO, C.B_J]);
  const sim = arena(1); const w = sim.worms[0]; w.x = 100; w.aim = -.5;
  sim.step([{ m: 0, sw: null, rp: 0 }]); sim.step([{ m: 0, sw: null, rp: 1 }]);
  for (let i = 0; i < 10; i++) sim.step([{ m: C.stickBits(0, -1, !!w.rope), sw: null, rp: 1 }]);
  assert.ok(w.rope && w.rope.st === 1 && w.rope.len < C.ROPE_MAX - 10, '비행 중 스틱 위: 로프 유지 + 감김: ' + (w.rope && w.rope.len));
});
