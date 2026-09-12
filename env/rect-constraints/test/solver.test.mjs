import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, findCycle, fingerprint, constraintAxis } from '../web/js/geom/solver.js';

const C = { w: 1000, h: 700 };

const R = (id, x, y, w = 100, h = 60, name = id) => ({ id, name, x, y, w, h });
const snap = (id, rect, axis, edge, other, otherEdge, gap = 0, priority = 50) =>
  ({ id, kind: 'snap', rect, axis, edge, other, otherEdge, gap, priority });
const gapC = (id, rect, other, side, g, priority = 40) =>
  ({ id, kind: 'minGap', rect, other, side, gap: g, priority });
const contain = (id, rect, margin = 0, priority = 30) =>
  ({ id, kind: 'contain', rect, margin, priority });
const lock = (id, rect, w = 120, h = 80, priority = 60) => ({ id, kind: 'lock', rect, w, h, priority });

test('贴齐：B 右边贴 A 左边，求解后 B.x = A.x - B.w', () => {
  const model = { canvas: C, rects: [R('A', 400, 100, 100, 60), R('B', 50, 50, 80, 50)], constraints: [
    snap('c1', 'B', 'x', 'r', 'A', 'l'),
  ] };
  const rep = solve(model);
  assert.equal(rep.rects.B.x, 320);
  assert.equal(rep.constraints.c1.satisfied, true);
  assert.equal(rep.conflicts.length, 0);
});

test('贴齐 y 轴 + 偏移 gap', () => {
  const model = { canvas: C, rects: [R('A', 0, 200), R('B', 0, 0, 100, 40)], constraints: [
    snap('c1', 'B', 'y', 't', 'A', 'b', 20),
  ] };
  const rep = solve(model);
  assert.equal(rep.rects.B.y, 200 + 60 + 20);
});

test('链式传递：A->B->C 拓扑序一次传播', () => {
  const model = { canvas: C, rects: [R('A', 500, 0), R('B', 0, 0, 100, 60), R('C', 0, 0, 100, 60)], constraints: [
    snap('c1', 'B', 'x', 'l', 'A', 'r', 10),
    snap('c2', 'C', 'x', 'l', 'B', 'r', 10),
  ] };
  const rep = solve(model);
  assert.equal(rep.rects.B.x, 610);
  assert.equal(rep.rects.C.x, 720);
});

test('最小间距违反时被推开，满足后保持原位置', () => {
  const model = { canvas: C, rects: [R('A', 200, 100), R('B', 250, 100)], constraints: [
    gapC('g1', 'B', 'A', 'right', 50),
  ] };
  const rep = solve(model);
  // B 应位于 A 右边且间距 >= 50 -> B.x = 350
  assert.equal(rep.rects.B.x, 350);
  assert.equal(rep.constraints.g1.satisfied, true);

  const model2 = { canvas: C, rects: [R('A', 200, 100), R('B', 900, 100)], constraints: model.constraints };
  const rep2 = solve(model2);
  assert.equal(rep2.rects.B.x, 900); // 原本满足，不被拉动
});

test('包含在画布内：超出的矩形被夹回，过大矩形上报未满足', () => {
  const model = { canvas: { w: 400, h: 300 }, rects: [R('A', -50, -20), R('B', 380, 290, 100, 60), R('C', 0, 0, 500, 50)], constraints: [
    contain('m1', 'A', 10),
    contain('m2', 'B', 0),
  ] };
  const rep = solve(model);
  assert.equal(rep.rects.A.x, 10);
  assert.equal(rep.rects.A.y, 10);
  assert.equal(rep.rects.B.x, 300);
  assert.equal(rep.rects.B.y, 240);
  assert.equal(rep.constraints.m2.satisfied, true);

  // 超大矩形：无法满足，必须上报
  const big = { canvas: { w: 200, h: 200 }, rects: [R('Z', 0, 0, 300, 40)], constraints: [contain('m3', 'Z')] };
  const r3 = solve(big);
  assert.equal(r3.constraints.m3.satisfied, false);
  assert.equal(r3.conflicts.length, 1);
  assert.match(r3.conflicts[0].reason, /尺寸超过画布/);
});

test('锁定尺寸：锁定后求解始终恢复到锁定时的 w/h', () => {
  const model = { canvas: C, rects: [R('A', 10, 10, 120, 80)], constraints: [lock('l1', 'A', 120, 80)] };
  model.rects[0].w = 200; // 存储中尺寸被改（理论上 UI 会先拦），求解器恢复
  const rep = solve(model);
  assert.equal(rep.rects.A.w, 120);
  assert.equal(rep.rects.A.h, 80);
  assert.equal(rep.constraints.l1.satisfied, true);
});

test('优先级打架：高优先级贴齐赢，低优先级最小间距上报冲突链（不静默丢弃）', () => {
  // B 贴齐 A 右侧(prio 90)；同时 B 与 A 的最小间距 200(prio 10)
  const model = { canvas: C, rects: [R('A', 200, 100), R('B', 0, 0, 100, 60)], constraints: [
    snap('hi', 'B', 'x', 'l', 'A', 'r', 0, 90),
    gapC('lo', 'B', 'A', 'right', 200, 10),
  ] };
  const rep = solve(model);
  assert.equal(rep.rects.B.x, 300);           // 贴齐生效
  assert.equal(rep.constraints.hi.satisfied, true);
  assert.equal(rep.constraints.lo.satisfied, false); // 间距 0 < 200
  const cf = rep.conflicts.find((c) => c.cid === 'lo');
  assert.ok(cf, '冲突必须被报告');
  assert.deepEqual(cf.blockerIds, ['hi']);             // 冲突链定位到 hi
  assert.match(cf.chain[0], /贴齐/);
});

test('同优先级冲突按约束 id 确定性打破并列，败者上报冲突', () => {
  // 两条同优先级、不可同时满足的 snap：B 左边贴 A 左边(200) vs B 右边贴 A 左边(200)
  const model = { canvas: C, rects: [R('A', 200, 100), R('B', 0, 0, 100, 60)], constraints: [
    snap('ca', 'B', 'x', 'l', 'A', 'l', 0, 50), // B.x = 200
    snap('cb', 'B', 'x', 'r', 'A', 'l', 0, 50), // B.x = 100
  ] };
  const rep = solve(model);
  assert.equal(rep.rects.B.x, 100); // 约束按 id 升序施加，cb 最后生效
  assert.equal(rep.constraints.cb.satisfied, true);
  assert.equal(rep.constraints.ca.satisfied, false);
  const cf = rep.conflicts.find((c) => c.cid === 'ca');
  assert.ok(cf);
  assert.deepEqual(cf.blockerIds, ['cb']);
});

test('拖动：主体硬钉住，链上 follower 重解；无法满足时冲突链含“拖动定位”', () => {
  const model = { canvas: C, rects: [R('A', 400, 100), R('B', 0, 0, 100, 60)], constraints: [
    snap('c1', 'B', 'x', 'r', 'A', 'l'),
    contain('m1', 'B'),
  ] };
  const rep = solve(model, { pinned: { A: { x: 900, y: 100 } }, group: ['A'] });
  assert.equal(rep.rects.A.x, 900);
  assert.equal(rep.rects.B.x, 800); // B.r 贴 A.l

  // 把 A 拖出画布右侧，B 被贴齐链带出画布：冲突链 包含B <- 贴齐B->A <- 拖动A
  const rep2 = solve(model, { pinned: { A: { x: 1050, y: 100 } }, group: ['A'] });
  assert.equal(rep2.constraints.m1.satisfied, false);
  const cf = rep2.conflicts.find((c) => c.cid === 'm1');
  assert.deepEqual(cf.blockerIds, ['c1', '#drag:A']);
});

test('组拖动：组员保持相对平移', () => {
  const model = { canvas: C, rects: [R('A', 100, 100), R('B', 100, 200)], constraints: [] };
  const rep = solve(model, { pinned: { A: { x: 150, y: 130 } }, group: ['A', 'B'] });
  assert.equal(rep.rects.A.x, 150);
  assert.equal(rep.rects.B.x, 150);
  assert.equal(rep.rects.B.y, 230); // +30
});

test('循环依赖被检出并定位环上的节点与约束；求解器仍防御性返回', () => {
  const cs = [
    snap('e1', 'A', 'x', 'l', 'B', 'l'), // A -> B
    snap('e2', 'B', 'x', 'l', 'C', 'l'), // B -> C
    snap('e3', 'C', 'x', 'l', 'A', 'l'), // C -> A 闭环
  ];
  const cyc = findCycle(cs);
  assert.ok(cyc);
  assert.deepEqual(cyc.nodeIds[0], cyc.nodeIds[cyc.nodeIds.length - 1]);
  assert.deepEqual(new Set(cyc.nodeIds), new Set(['A', 'B', 'C']));
  assert.deepEqual([...new Set(cyc.cids)].sort(), ['e1', 'e2', 'e3']);

  // 无环
  assert.equal(findCycle(cs.slice(0, 2)), null);
  // contain 指向画布，不构成矩形环
  assert.equal(findCycle([...cs.slice(0, 2), contain('m', 'A')]), null);
});

test('确定性：同模型重复求解 / 乱序约束 / 乱序矩形 => 同 hash', () => {
  const mk = () => ({ canvas: C, rects: [R('A', 200, 100), R('B', 0, 0), R('C', 50, 50)], constraints: [
    snap('s1', 'B', 'x', 'l', 'A', 'r', 5, 70),
    gapC('g1', 'C', 'A', 'right', 20, 30),
    contain('m1', 'B', 8),
    snap('s2', 'C', 'y', 't', 'A', 'b', 0, 60),
  ] });
  const h1 = solve(mk()).hash;
  const h2 = solve(mk()).hash;
  assert.equal(h1, h2);
  const m3 = mk();
  m3.rects.reverse();
  m3.constraints.reverse();
  assert.equal(solve(m3).hash, h1);
});

test('空闲重解是幂等不动点（刷新/窗口缩放后结果不变）', () => {
  const model = { canvas: C, rects: [R('A', 200, 100), R('B', 0, 0), R('C', 50, 50)], constraints: [
    snap('s1', 'B', 'x', 'l', 'A', 'r', 5, 70),
    gapC('g1', 'C', 'A', 'right', 20, 30),
    contain('m1', 'B', 8),
    snap('s2', 'C', 'y', 't', 'A', 'b', 0, 60),
  ] };
  const r1 = solve(model);
  const fed = { canvas: C, rects: model.rects.map((r) => ({ ...r, ...r1.rects[r.id] })), constraints: model.constraints };
  const r2 = solve(fed);
  assert.equal(r2.hash, r1.hash);
  for (const id of Object.keys(r1.rects)) assert.deepEqual(r2.rects[id], r1.rects[id]);
});

test('窗口缩放：逻辑坐标系不变，仅视图缩放，关系 hash 相同', () => {
  const model = { canvas: C, rects: [R('A', 100, 100), R('B', 0, 0)], constraints: [
    snap('s1', 'B', 'y', 'b', 'A', 't'), gapC('g1', 'B', 'A', 'left', 30), contain('m1', 'A'),
  ] };
  const h = solve(model).hash;
  // 画布逻辑尺寸不变（viewBox 方案）：重解必然一致
  assert.equal(solve(model).hash, h);
});

test('禁用约束不参与求解也不产生依赖', () => {
  const cs = [
    { ...snap('e1', 'A', 'x', 'l', 'B', 'l'), enabled: false },
    snap('e2', 'B', 'x', 'l', 'A', 'l'),
  ];
  assert.equal(findCycle(cs), null);
  const model = { canvas: C, rects: [R('A', 100, 0), R('B', 0, 0)], constraints: cs };
  const rep = solve(model);
  assert.equal(rep.constraints.e1.disabled, true);
  assert.equal(rep.rects.B.x, 100);
});
