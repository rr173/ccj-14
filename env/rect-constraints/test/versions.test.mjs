// 布局版本：compareVersions 纯函数 + Store 版本操作 + 乐观并发（内存模拟服务器）。
import test from 'node:test';
import assert from 'node:assert/strict';

// Store 依赖 localStorage / fetch，先进内存模拟
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

// 内存版 /api/doc：与 server.py 相同的 rev 乐观并发语义
const server = { doc: null };
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  if (method === 'GET') {
    if (!server.doc) return { ok: false, status: 404, json: async () => ({ error: 'no-document' }) };
    return { ok: true, status: 200, json: async () => structuredClone(server.doc) };
  }
  if (method === 'PUT') {
    const body = JSON.parse(opts.body);
    const curRev = server.doc?.rev ?? 0;
    if (body.baseRev !== curRev) {
      return { ok: false, status: 409, json: async () => ({ error: 'revision-conflict', rev: curRev }) };
    }
    const doc = { ...body, rev: curRev + 1 };
    delete doc.baseRev;
    server.doc = doc;
    return { ok: true, status: 200, json: async () => ({ ok: true, rev: doc.rev }) };
  }
  throw new Error(`unexpected ${method} ${url}`);
};

const { compareVersions } = await import('../web/js/geom/versions.js');
const { Store } = await import('../web/js/geom/store.js');
const { seedModel, newRect } = await import('../web/js/geom/model.js');
const { solve } = await import('../web/js/geom/solver.js');

const mkVersion = (model, id = 'v1', name = id) => {
  const report = solve(model);
  return { id, name, createdAt: 1, published: false, model, report, hash: report.hash };
};
const freshStore = async () => {
  mem.clear();
  server.doc = null;
  const s = new Store({ base: '' });
  await s.load();
  return s;
};

/* ---------- compareVersions ---------- */

test('版本比较：矩形移动 / 尺寸变化 / 新增 / 删除', () => {
  const base = seedModel();
  const v1 = mkVersion(base, 'v1');
  const m2 = structuredClone(base);
  const rA = m2.rects.find((r) => r.name === '卡片A');
  const rB = m2.rects.find((r) => r.name === '标签B');
  const rC = m2.rects.find((r) => r.name === '按钮组C');
  const baseA = base.rects.find((r) => r.id === rA.id);
  rA.x += 100;                                // 移动（跟随它的矩形会一起重解）
  rB.w += 30;                                 // 尺寸变化
  m2.rects = m2.rects.filter((r) => r.id !== rC.id);   // 删除
  m2.constraints = m2.constraints.filter((c) => c.rect !== rC.id && c.other !== rC.id);
  m2.rects.push({ id: 'r_new', name: '新增矩形', x: 10, y: 10, w: 50, h: 40 });
  const v2 = mkVersion(m2, 'v2');

  const d = compareVersions(v1, v2);
  const mv = d.rects.moved.find((x) => x.id === rA.id);
  assert.ok(mv, '检出移动的矩形');
  assert.deepEqual(mv.from, { x: baseA.x, y: baseA.y });
  assert.deepEqual(mv.to, { x: baseA.x + 100, y: baseA.y });
  const rs = d.rects.resized.find((x) => x.id === rB.id);
  assert.deepEqual(rs.from, { w: 120, h: 100 });
  assert.deepEqual(rs.to, { w: 150, h: 100 });
  assert.deepEqual(d.rects.added.map((x) => x.id), ['r_new']);
  assert.deepEqual(d.rects.removed.map((x) => x.id), [rC.id]);
  assert.equal(d.identical, false);
});

test('版本比较：约束新增 / 删除 / 同 id 修改', () => {
  const base = seedModel();
  const v1 = mkVersion(base, 'v1');
  const m2 = structuredClone(base);
  const removedC = m2.constraints[0];
  m2.constraints.splice(0, 1);
  const changedC = m2.constraints[0];
  const oldPrio = changedC.priority;
  changedC.priority += 5;
  m2.constraints.push({ id: 'c_new', kind: 'contain', rect: m2.rects[0].id, margin: 5, priority: 10, enabled: true });
  const v2 = mkVersion(m2, 'v2');

  const d = compareVersions(v1, v2);
  assert.deepEqual(d.constraints.removed.map((x) => x.id), [removedC.id]);
  assert.deepEqual(d.constraints.added.map((x) => x.id), ['c_new']);
  const ch = d.constraints.changed.find((x) => x.id === changedC.id);
  assert.ok(ch, '检出同 id 约束的修改');
  assert.deepEqual(ch.fields, [{ field: 'priority', from: oldPrio, to: oldPrio + 5 }]);
});

test('版本比较：冲突数量与未满足项变化；自比较完全一致', () => {
  const m1 = seedModel();
  const v1 = mkVersion(m1, 'v1'); // 种子模型零冲突
  const m2 = structuredClone(m1);
  const A = m2.rects[0].id, C = m2.rects[2].id;
  m2.constraints.push({ id: 'cx1', kind: 'snap', rect: C, other: A, axis: 'x', edge: 'l', otherEdge: 'l', gap: 0, priority: 95, enabled: true });
  m2.constraints.push({ id: 'cx2', kind: 'snap', rect: C, other: A, axis: 'x', edge: 'r', otherEdge: 'l', gap: 0, priority: 5, enabled: true });
  const v2 = mkVersion(m2, 'v2');
  assert.ok(v2.report.conflicts.length >= 1, '前提：v2 有冲突');

  const d = compareVersions(v1, v2);
  assert.equal(d.conflicts.before, 0);
  assert.equal(d.conflicts.after, v2.report.conflicts.length);
  assert.equal(d.conflicts.newUnmet.length, v2.report.conflicts.length);
  assert.equal(d.conflicts.resolved.length, 0);
  assert.ok(d.conflicts.newUnmet[0].label.length > 0, '未满足项带可读描述');

  const back = compareVersions(v2, v1);
  assert.equal(back.conflicts.resolved.length, v2.report.conflicts.length, '反向比较 = 已解决');

  assert.equal(compareVersions(v1, v1).identical, true, '自比较完全一致');
  // 确定性：同样的两个版本，比较结果逐字节相同
  assert.equal(JSON.stringify(compareVersions(v1, v2)), JSON.stringify(compareVersions(v1, v2)));
});

/* ---------- Store 版本操作 ---------- */

test('Store：保存版本为只读快照，后续编辑不影响版本', async () => {
  const s = await freshStore();
  const r = s.saveVersion('基线');
  assert.equal(r.ok, true);
  assert.equal(s.currentVersionId, r.version.id, '保存后成为当前版本');
  assert.equal(r.version.published, false);
  const hash0 = r.version.hash;
  const nRects = r.version.model.rects.length;
  const nCons = r.version.model.constraints.length;

  s.commit((m) => m.rects.push(newRect(1, 1, 50, 50, '后续编辑')));
  assert.equal(r.version.model.rects.length, nRects, '版本矩形不被后续编辑影响');
  assert.equal(r.version.model.constraints.length, nCons, '版本约束不被后续编辑影响');
  assert.equal(r.version.hash, hash0, '版本指纹不变');
  assert.ok(r.version.report.conflicts, '版本保存了冲突报告');

  assert.equal(s.saveVersion('基线').ok, false, '重名版本被拒绝');
  assert.equal(s.saveVersion('   ').ok, false, '空名称被拒绝');
  await s.flushed();
});

test('Store：恢复版本生成新的当前编辑版本，原版本不被改写', async () => {
  const s = await freshStore();
  const v1 = s.saveVersion('一版').version;
  s.commit((m) => { m.rects[0].x += 200; });
  const v2 = s.saveVersion('二版').version;
  assert.equal(s.currentVersionId, v2.id);

  const res = s.restoreVersion(v1.id);
  assert.equal(res.ok, true);
  assert.equal(s.currentVersionId, v1.id, '恢复后当前版本指向被恢复的版本');
  assert.equal(s.current.hash, v1.hash, '恢复后的解与版本快照逐字节一致（确定性）');
  assert.equal(s.versions.find((v) => v.id === v1.id).hash, v1.hash, '原版本未被改写');
  assert.ok(s.canUndo, '恢复是一次可撤销的历史提交');
  s.undo();
  assert.equal(s.current.hash, v2.hash, '撤销恢复回到之前的内容');
  await s.flushed();
});

test('Store：当前版本与已发布版本不能删除；删除清理比较选择', async () => {
  const s = await freshStore();
  const v1 = s.saveVersion('一').version;
  const v2 = s.saveVersion('二').version; // 当前 = v2
  assert.equal(s.deleteVersion(v2.id).ok, false, '当前版本不能删除');
  assert.equal(s.deleteVersion(v1.id).ok, true, '普通版本可删除');

  s.setPublished(v2.id, true);
  assert.equal(s.deleteVersion(v2.id).ok, false, '已发布版本不能删除');
  s.setPublished(v2.id, false);

  const v3 = s.saveVersion('三').version; // 当前 = v3
  s.setCompare(v3.id, v2.id);
  assert.equal(s.deleteVersion(v2.id).ok, true, '取消发布后可删除');
  assert.equal(s.compare.b, null, '被删版本从比较选择中移除');
  assert.equal(s.compare.a, v3.id, '未涉及的比较选择保留');
  await s.flushed();
});

test('Store：刷新后版本列表 / 当前版本 / 发布标记 / 比较结果保持一致', async () => {
  const s = await freshStore();
  const v1 = s.saveVersion('甲').version;
  s.commit((m) => { m.rects[0].y += 60; });
  const v2 = s.saveVersion('乙').version;
  s.setPublished(v1.id, true);
  s.restoreVersion(v1.id);
  s.setCompare(v1.id, v2.id);
  await s.flushed();

  // 模拟刷新：全新 Store 从同一后端加载
  const s2 = new Store({ base: '' });
  await s2.load();
  assert.equal(s2.versions.length, 2, '版本列表一致');
  assert.equal(s2.currentVersionId, v1.id, '当前版本一致');
  assert.equal(s2.versions.find((v) => v.id === v1.id).published, true, '发布标记一致');
  assert.equal(s2.compare.a, v1.id, '比较选择 A 一致');
  assert.equal(s2.compare.b, v2.id, '比较选择 B 一致');
  assert.equal(
    JSON.stringify(s2.compareById(v1.id, v2.id)),
    JSON.stringify(s.compareById(v1.id, v2.id)),
    '比较结果逐字节一致',
  );
  await s2.flushed();
});

/* ---------- 乐观并发 ---------- */

test('Store：两个页面基于同一版本编辑，旧页面保存检测冲突且不覆盖', async () => {
  mem.clear();
  server.doc = null;
  const p1 = new Store({ base: '' });
  await p1.load();
  const p2 = new Store({ base: '' });
  await p2.load();
  assert.equal(p1.rev, p2.rev, '两个页面基于同一服务端版本号');

  p1.commit((m) => m.rects.push(newRect(10, 500, 80, 50, '页面1的矩形')));
  await p1.flushed();
  assert.equal(p1.saveConflict, false, '页面1 保存成功');

  p2.commit((m) => m.rects.push(newRect(900, 500, 80, 50, '页面2的矩形')));
  await p2.flushed();
  assert.equal(p2.saveConflict, true, '页面2 的旧版本提交被检测为冲突');
  assert.ok(p2.model.rects.some((r) => r.name === '页面2的矩形'), '页面2 的本地修改仍保留在内存中');

  // 服务器内容未被页面2覆盖
  const check = new Store({ base: '' });
  await check.load();
  assert.ok(check.model.rects.some((r) => r.name === '页面1的矩形'), '服务器保留页面1的内容');
  assert.ok(!check.model.rects.some((r) => r.name === '页面2的矩形'), '页面2的提交没有覆盖服务器');
  assert.equal(check.rev, p1.rev, '服务器版本号只被页面1推进');
  assert.equal(check.saveConflict, false, '重新加载后冲突解除');
  await check.flushed();
});

test('Store：无本地修改时检测到更新会静默跟随服务器', async () => {
  mem.clear();
  server.doc = null;
  const p1 = new Store({ base: '' });
  await p1.load();
  const p2 = new Store({ base: '' });
  await p2.load();

  p1.commit((m) => m.rects.push(newRect(10, 500, 80, 50, 'P1')));
  await p1.flushed();

  // p2 没有任何本地修改，直接尝试保存（如加载时的防御性回写）-> 应静默重载而非报冲突
  p2.persist();
  await p2.flushed();
  await new Promise((r) => setTimeout(r, 30)); // 等静默 reload 完成
  assert.equal(p2.saveConflict, false, '无本地修改时不误报冲突');
  assert.ok(p2.model.rects.some((r) => r.name === 'P1'), '静默跟随到页面1的内容');
  await p2.flushed();
});
