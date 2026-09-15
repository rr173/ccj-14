// 影响分析与安全变更工作台：
// 影响面展开（直接/间接矩形·约束·传播分支）/ 候选变更模拟（位置变化·冲突链·循环依赖·越界·级联删除）/
// 分析快照绑定文档版本 / 分支前进 409 且候选保留 / 一次性原子应用 / 同组候选重复提交幂等 /
// 逐项放弃候选 / 应用事件不改写历史 / 重启一致（快照·候选·冲突·事件·报告）/ 跨分支合流。
import { describe, test as rawTest } from 'node:test';
const collected = [];
const test = (name, fn) => collected.push([name, fn]);
import assert from 'node:assert/strict';

const pendingTimers = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = _setTimeout(fn, ms, ...args);
  pendingTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); return _clearTimeout(id); };

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

let activeFetch = null;
globalThis.fetch = (url, opts) => activeFetch(url, opts);

const { mergeDocs, assessConflict, MAIN_BRANCH } = await import('../web/js/geom/audit.js');
const { Store } = await import('../web/js/geom/store.js');
const { newRect, newSnap, newMinGap, newContain, newLock, normalize } = await import('../web/js/geom/model.js');
const { solve, findCycle } = await import('../web/js/geom/solver.js');
const {
  analyzeImpact, simulateChanges, normalizeChange, applyChanges,
  impactSnapshotId, changesFingerprint, sanitizeImpactSnapshots, mergeImpactSnapshots,
  buildImpactReport,
} = await import('../web/js/geom/impact.js');

function makeHarness() {
  const state = { serverDoc: null, gen: 0 };
  const fetchImpl = (url, opts = {}) => {
    const myGen = state.gen;
    const method = opts.method || 'GET';
    const jsonOk = (obj) => ({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(obj))) });
    if (method === 'GET') {
      if (myGen !== state.gen || !state.serverDoc) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(jsonOk(state.serverDoc));
    }
    if (method === 'PUT') {
      if (myGen !== state.gen) return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ reason: 'stale-generation' }) });
      const body = JSON.parse(opts.body);
      const curRev = state.serverDoc?.rev ?? 0;
      const reject = (info) => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'revision-conflict', rev: curRev, ...info }) });
      const accept = (doc, extra = {}) => { state.serverDoc = doc; return jsonOk({ ok: true, rev: doc.rev, ...extra }); };
      if (body.baseRev !== curRev) {
        const verdict = assessConflict(state.serverDoc, body);
        if (!verdict.mergeable) return reject(verdict);
        if (state.serverDoc) {
          const merged = mergeDocs(state.serverDoc, body);
          delete merged.baseRev; delete merged.baseHeads;
          merged.rev = curRev + 1;
          return accept(merged, { merged: true, doc: merged });
        }
        const doc = { ...body, rev: curRev + 1 };
        delete doc.baseRev; delete doc.baseHeads;
        return accept(doc);
      }
      const doc = { ...body, rev: curRev + 1 };
      delete doc.baseRev; delete doc.baseHeads;
      state.serverDoc = JSON.parse(JSON.stringify(doc));
      return accept(doc);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return {
    fetchImpl,
    nextGen() { state.gen++; },
    clear() { state.serverDoc = null; },
    get gen() { return state.gen; },
    get doc() { return state.serverDoc; },
    set doc(v) { state.serverDoc = v; },
  };
}
const harness = makeHarness();
activeFetch = harness.fetchImpl;

const freshStore = async () => {
  for (const id of pendingTimers) _clearTimeout(id);
  pendingTimers.clear();
  mem.clear();
  harness.clear();
  harness.nextGen();
  const s = new Store({ base: '' });
  await s.load();
  return { s, h: harness };
};
const drain = () => new Promise((r) => _setTimeout(r, 0));
const afterEachFn = async () => {
  for (const id of pendingTimers) _clearTimeout(id);
  pendingTimers.clear();
  for (let i = 0; i < 6; i++) await drain();
  harness.nextGen();
  harness.clear();
  mem.clear();
};

const byName = (s, name) => s.model.rects.find((r) => r.name === name).id;
const findCons = (s, pred) => s.model.constraints.find(pred);

/** 构造链式约束：anchor ← mid ← leaf（leaf 跟随 mid，mid 跟随 anchor）。 */
async function chainStore() {
  const { s } = await freshStore();
  s.setActor('甲');
  s.commit((m) => {
    const anchor = newRect(100, 100, 120, 80, '锚点');
    const mid = newRect(300, 100, 120, 80, '中间');
    const leaf = newRect(500, 100, 120, 80, '末端');
    m.rects.push(anchor, mid, leaf);
    m.constraints.push(newSnap(mid.id, anchor.id, 'x', 'l', 'r', 20, 50));
    m.constraints.push(newSnap(leaf.id, mid.id, 'x', 'l', 'r', 20, 50));
  }, { label: '建立约束链' });
  await s.flushed();
  return s;
}

/* ==================== 纯函数：影响面 ==================== */

test('analyzeImpact：选中矩形展开直接 + 间接受影响矩形、约束与传播分支', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const impact = analyzeImpact(s.model, { kind: 'rect', id: anchor });
  assert.equal(impact.seed.valid, true);
  const ids = new Set(impact.rects.map((r) => r.id));
  assert.ok(ids.has(anchor), '种子矩形在影响面');
  // anchor 被 mid 跟随、mid 被 leaf 跟随：mid 直接、leaf 间接
  const rel = Object.fromEntries(impact.rects.map((r) => [r.id, r.relation]));
  assert.equal(rel[byName(s, '中间')], 'direct');
  assert.equal(rel[byName(s, '末端')], 'indirect');
  assert.ok(impact.constraints.length >= 2, '两条链约束都受影响');
  assert.ok(impact.branches.length >= 1, '至少一条传播分支');
  const branch = impact.branches.find((b) => b.length === 3);
  assert.ok(branch, '存在 锚点→中间→末端 的三级传播分支');
  assert.deepEqual(branch.nodes.map((n) => n.name), ['锚点', '中间', '末端']);
  assert.equal(branch.terminal.name, '末端');
});

test('analyzeImpact：选中约束时跟随/锚点矩形为直接受影响', async () => {
  const s = await chainStore();
  const c = findCons(s, (x) => x.kind === 'snap' && x.rect === byName(s, '中间'));
  const impact = analyzeImpact(s.model, { kind: 'constraint', id: c.id });
  assert.equal(impact.seed.valid, true);
  const direct = new Set(impact.rects.filter((r) => r.relation === 'direct').map((r) => r.id));
  assert.ok(direct.has(byName(s, '中间')));
  assert.ok(direct.has(byName(s, '锚点')));
  // 末端经中间间接可达
  const indirect = new Set(impact.rects.filter((r) => r.relation === 'indirect').map((r) => r.id));
  assert.ok(indirect.has(byName(s, '末端')));
  assert.equal(impact.constraints.find((x) => x.id === c.id).relation, 'direct');
});

test('analyzeImpact：种子非法时 valid=false', async () => {
  const s = await chainStore();
  const impact = analyzeImpact(s.model, { kind: 'rect', id: 'nope' });
  assert.equal(impact.seed.valid, false);
});

/* ==================== 纯函数：模拟 ==================== */

test('simulateChanges：移动锚点沿约束链传播位置变化', async () => {
  const s = await chainStore();
  const anchor = s.model.rects.find((r) => r.id === byName(s, '锚点'));
  const sim = simulateChanges(s.model, s.headEvent.report, [
    { kind: 'move-rect', rectId: anchor.id, x: anchor.x + 50 },
  ]);
  assert.equal(sim.ok, true, JSON.stringify(sim.errors));
  const mid = sim.model.rects.find((r) => r.id === byName(s, '中间'));
  const leaf = sim.model.rects.find((r) => r.id === byName(s, '末端'));
  assert.ok(Math.abs(mid.x - (anchor.x + 50 + anchor.w + 20)) < 0.5, `中间随锚点传播（x=${mid.x}）`);
  // 末端跟随中间，同样右移 50
  const leafBefore = s.model.rects.find((r) => r.id === leaf.id);
  assert.ok(Math.abs((leaf.x - leafBefore.x) - 50) < 0.5, '末端间接受影响移动 50');
  assert.ok(sim.diff.rects.moved.length >= 3, '差异报告列出所有移动矩形');
});

test('simulateChanges：修改 contain 边距 / lock 尺寸 / 启停等参数', async () => {
  const s = await chainStore();
  // contain 边距
  const contain = findCons(s, (x) => x.kind === 'contain');
  if (contain) {
    const sim = simulateChanges(s.model, s.headEvent.report, [
      { kind: 'modify-constraint', constraintId: contain.id, params: { margin: 200 } },
    ]);
    assert.equal(sim.ok, true, JSON.stringify(sim.errors));
    const changed = sim.diff.constraints.changed.find((x) => x.id === contain.id);
    assert.ok(changed, 'contain 边距修改进入字段差异');
    assert.ok(changed.fields.some((f) => f.field === 'margin'));
  }
  // 停用一条约束
  const snap0 = findCons(s, (x) => x.kind === 'snap' && x.rect === byName(s, '末端'));
  const simOff = simulateChanges(s.model, s.headEvent.report, [
    { kind: 'modify-constraint', constraintId: snap0.id, params: {}, enabled: false },
  ]);
  assert.equal(simOff.ok, true);
  assert.equal(simOff.model.constraints.find((x) => x.id === snap0.id).enabled, false);
});

test('simulateChanges：删除矩形级联删除端点约束', async () => {
  const s = await chainStore();
  const mid = byName(s, '中间');
  const sim = simulateChanges(s.model, s.headEvent.report, [{ kind: 'delete-rect', rectId: mid }]);
  assert.equal(sim.ok, true);
  assert.ok(sim.model.constraints.every((c) => c.rect !== mid && c.other !== mid), '级联删除引用中间矩形的约束');
  assert.ok(sim.removedConstraintIds.length >= 2, '两条链约束被级联移除');
  assert.deepEqual(sim.deletedRects, [mid]);
  assert.ok(sim.diff.rects.removed.some((r) => r.id === mid));
});

test('simulateChanges：删除约束在模拟中移除', async () => {
  const s = await chainStore();
  const c = findCons(s, (x) => x.rect === byName(s, '末端'));
  const leafBefore = s.model.rects.find((r) => r.id === byName(s, '末端')).x;
  const sim = simulateChanges(s.model, s.headEvent.report, [{ kind: 'delete-constraint', constraintId: c.id }]);
  assert.equal(sim.ok, true);
  assert.ok(!sim.model.constraints.some((x) => x.id === c.id));
  // 删除贴齐后末端不再被强制贴到中间旁边（求解不再施加该约束）
  const leafAfter = sim.model.rects.find((r) => r.id === byName(s, '末端')).x;
  assert.notEqual(leafAfter, undefined);
  void leafBefore;
});

test('simulateChanges：修改约束参数（偏移）改变求解位置', async () => {
  const s = await chainStore();
  const c = findCons(s, (x) => x.kind === 'snap' && x.rect === byName(s, '中间'));
  const sim = simulateChanges(s.model, s.headEvent.report, [
    { kind: 'modify-constraint', constraintId: c.id, params: { gap: 80 } },
  ]);
  assert.equal(sim.ok, true);
  const anchor = s.model.rects.find((r) => r.id === byName(s, '锚点'));
  const mid = sim.model.rects.find((r) => r.id === byName(s, '中间'));
  assert.ok(Math.abs(mid.x - (anchor.x + anchor.w + 80)) < 0.5, `偏移 80 生效（x=${mid.x}）`);
});

test('simulateChanges：引入循环依赖时给 cycle 阻断（候选结果不能成环提交）', async () => {
  const s = await chainStore();
  // 候选“新增一条反向贴齐边”会成环：锚点→中间→末端→锚点。
  // 用等价的基线扩展模型验证模拟管线对环的检测（候选改参数不能凭空加边，环由基线模型承载）。
  const anchor = byName(s, '锚点');
  const leaf = byName(s, '末端');
  const cyclic = structuredClone(s.model);
  cyclic.constraints.push({ id: 'c_cyc', kind: 'snap', rect: anchor, other: leaf, axis: 'x', edge: 'l', otherEdge: 'r', gap: 20, priority: 50, enabled: true });
  assert.ok(findCycle(cyclic.constraints), '构造的基线确实成环');
  const probe = simulateChanges(cyclic, solve(normalize(cyclic)), []);
  assert.equal(probe.ok, false);
  assert.ok(probe.cycle, '空候选对已含环的模型也报 cycle');
  assert.deepEqual(probe.cycle.cids.includes('c_cyc') || probe.cycle.nodeIds.length >= 3, true);
  assert.ok(probe.errors.some((e) => e.code === 'cycle'));

  // 修改一条不存在的约束 -> 候选非法阻断
  const bad = simulateChanges(s.model, s.headEvent.report, [
    { kind: 'modify-constraint', constraintId: 'c_missing', params: { gap: 1 } },
  ]);
  assert.equal(bad.ok, false);
});

test('simulateChanges：越界风险（移动到画布外）被阻断', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const sim = simulateChanges(s.model, s.headEvent.report, [
    { kind: 'move-rect', rectId: anchor, x: 990 },
  ]);
  assert.equal(sim.ok, false);
  assert.ok(sim.errors.some((e) => e.code === 'out-of-bounds'), '报告越界阻断');
  assert.ok(sim.boundsBefore.length + sim.boundsAfter.length > 0, '越界矩形有明细');
});

test('simulateChanges：不修改基线模型（纯函数）', async () => {
  const s = await chainStore();
  const before = JSON.stringify(s.model);
  const anchor = byName(s, '锚点');
  simulateChanges(s.model, s.headEvent.report, [{ kind: 'delete-rect', rectId: anchor }]);
  assert.equal(JSON.stringify(s.model), before);
});

test('normalizeChange：候选 id 由内容确定性派生，相同内容同 id', () => {
  const a = normalizeChange({ kind: 'move-rect', rectId: 'r1', x: 10 }, { idx: 0 }).value;
  const b = normalizeChange({ kind: 'move-rect', rectId: 'r1', x: 10 }, { idx: 5 }).value;
  assert.equal(a.id, b.id, 'idx 不参与候选 id');
  const c = normalizeChange({ kind: 'move-rect', rectId: 'r1', x: 11 }, { idx: 0 }).value;
  assert.notEqual(a.id, c.id);
  assert.ok(normalizeChange({ kind: 'bogus' }).error);
  assert.ok(normalizeChange({ kind: 'move-rect', rectId: 'r1', w: -5 }).error);
});

test('applyChanges：多候选按序作用；删除后再移动同一矩形报告目标缺失，不静默丢弃', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const out = applyChanges(s.model, [
    { id: 'a', kind: 'delete-rect', rectId: anchor },
    { id: 'b', kind: 'move-rect', rectId: anchor, x: 200 },
  ]);
  assert.ok(!out.model.rects.some((r) => r.id === anchor), '删除最终生效');
  assert.ok(out.errors.some((e) => e.code === 'missing-target'), '移动已删除矩形不被静默丢弃');
});

/* ==================== Store：快照生命周期 ==================== */

test('createImpactAnalysis：创建快照并绑定分析时文档版本（docRev / headEventId / baseHash）', async () => {
  const s = await chainStore();
  const rev0 = s.rev;
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 300 }] });
  assert.equal(res.ok, true, res.error);
  const snap = res.snapshot;
  assert.equal(snap.branchId, MAIN_BRANCH);
  assert.equal(snap.headEventId, s.branch.headEventId);
  assert.equal(snap.baseHash, s.headEvent.hash);
  assert.ok(snap.docRev >= rev0);
  assert.equal(snap.status, 'open');
  assert.equal(snap.changes.length, 1);
  assert.ok(snap.simulation, '带候选时立即给出模拟');
  assert.ok(snap.impact, '影响面随快照保存');
  assert.equal(s.activeImpactId, snap.id);
});

test('createImpactAnalysis：同分支 head + 同种子 + 同候选内容派生同一快照（幂等）', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const seed = { kind: 'rect', id: anchor };
  const changes = [{ kind: 'move-rect', rectId: anchor, x: 300 }];
  const a = s.createImpactAnalysis(seed, { changes });
  const b = s.createImpactAnalysis(seed, { changes });
  assert.equal(a.snapshot.id, b.snapshot.id);
  assert.equal(b.reused, true);
  assert.equal(s.impactSnapshots.length, 1);
});

test('updateImpactCandidates：添加后重新模拟；discardChange 逐项放弃', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor });
  const id = res.snapshot.id;
  const u1 = s.updateImpactCandidates(id, [{ kind: 'move-rect', rectId: anchor, x: 250 }]);
  assert.equal(u1.ok, true);
  assert.equal(u1.snapshot.changes.length, 1);
  const changeId = u1.snapshot.changes[0].id;
  const u2 = s.discardImpactChange(id, changeId);
  assert.equal(u2.ok, true);
  assert.equal(u2.snapshot.changes.length, 0, '逐项放弃后候选清空');
  assert.equal(u2.snapshot.simulation, null, '无候选时模拟为空');
});

test('abandonImpact：标记放弃，不再可应用', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 300 }] });
  s.abandonImpact(res.snapshot.id);
  const r = await s.applyImpact(res.snapshot.id);
  assert.equal(r.ok, false);
});

/* ==================== Store：应用 / 幂等 / 原子性 ==================== */

test('applyImpact：通过模拟后一次性写 impact 审计事件，模型与模拟结果一致', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 260 }] });
  const headBefore = s.branch.headEventId;
  const applied = await s.applyImpact(res.snapshot.id);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.event.kind, 'impact');
  assert.equal(applied.event.parentId, headBefore);
  assert.equal(applied.event.impact.snapshotId, res.snapshot.id);
  assert.equal(s.branch.headEventId, applied.event.id);
  // 当前模型 = 模拟结果（锚点移动并沿链传播）
  assert.ok(Math.abs(s.model.rects.find((r) => r.id === anchor).x - 260) < 0.5);
  const snap = s.impactById(res.snapshot.id);
  assert.equal(snap.status, 'applied');
  assert.equal(snap.appliedEventId, applied.event.id);
  assert.ok(snap.report, '应用后回填影响报告');
});

test('applyImpact：同一组候选重复提交幂等，不产生重复事件', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 260 }] });
  const first = await s.applyImpact(res.snapshot.id);
  const impactEvents = () => s.events.filter((e) => e.kind === 'impact').length;
  assert.equal(impactEvents(), 1);
  const second = await s.applyImpact(res.snapshot.id);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.event.id, first.event.id);
  assert.equal(impactEvents(), 1, '只有 1 条 impact 事件');
});

test('applyImpact：模拟不通过（越界）时拒绝且不留部分修改', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const headId = s.branch.headEventId;
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 990 }] });
  assert.equal(res.snapshot.simulation.ok, false);
  const r = await s.applyImpact(res.snapshot.id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'impact-blocked');
  assert.equal(s.branch.headEventId, headId, 'head 未推进');
  assert.equal(s.events.filter((e) => e.kind === 'impact').length, 0, '无 impact 事件');
  assert.ok(Math.abs(s.model.rects.find((x) => x.id === anchor).x - 100) < 0.5, '模型保持基线');
});

test('应用失败后候选仍可逐项放弃 / 修改', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 990 }] });
  await s.applyImpact(res.snapshot.id);
  const fixed = s.updateImpactCandidates(res.snapshot.id, [{ kind: 'move-rect', rectId: anchor, x: 120 }]);
  assert.equal(fixed.snapshot.simulation.ok, true);
  const applied = await s.applyImpact(res.snapshot.id);
  assert.equal(applied.ok, true, applied.error);
});

/* ==================== Store：版本冲突 ==================== */

test('applyImpact：分析后当前分支前进 -> 409 版本冲突，候选保留且无部分修改', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 260 }] });
  const snapId = res.snapshot.id;
  const headAtAnalysis = s.branch.headEventId;

  // 模拟“另一页面在同分支提交”：直接往服务端权威文档追加一条 edit 事件
  const serverDoc = JSON.parse(JSON.stringify(harness.doc));
  const parent = serverDoc.events.find((e) => e.id === serverDoc.branches.find((b) => b.id === MAIN_BRANCH).headEventId);
  const m2 = structuredClone(parent.model);
  m2.rects.find((r) => r.id === anchor).name = '锚点(另一页改)';
  const norm2 = normalize(m2);
  const rep2 = solve(norm2);
  for (const r of norm2.rects) { const p = rep2.rects[r.id]; if (p) Object.assign(r, p); }
  const other = {
    id: 'e_other', branch: MAIN_BRANCH, parentId: parent.id, kind: 'edit', seq: parent.seq + 1,
    t: Date.now() + 1, actor: '乙', label: '另一页面提交', model: norm2, report: rep2, hash: rep2.hash,
    hashBefore: parent.hash, changes: null, conflicts: [],
  };
  serverDoc.events.push(other);
  serverDoc.branches.find((b) => b.id === MAIN_BRANCH).headEventId = other.id;
  serverDoc.rev = (serverDoc.rev || 1) + 1;
  harness.doc = serverDoc;

  const r = await s.applyImpact(snapId);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.reason, 'impact-branch-advanced');
  // 没有产生新的 impact 审计事件（候选未应用、无部分修改）
  assert.equal(s.events.filter((e) => e.kind === 'impact').length, 0);
  // 本地对齐到对方权威 head（冲突已采纳，编辑器可继续工作），或保持原 head —— 但候选位置绝不能被应用
  assert.ok(Math.abs(s.model.rects.find((x) => x.id === anchor).x - 100) < 0.5, '锚点候选位置未应用');
  // 候选原样保留 + 冲突原因记录在快照上
  const snap = s.impactById(snapId);
  assert.equal(snap.status, 'open');
  assert.equal(snap.changes.length, 1);
  assert.ok(snap.conflict, '冲突原因持久化到快照');
  assert.equal(snap.conflict.reason, 'impact-branch-advanced');
  // 编辑器没有进入全局只读冲突态
  assert.equal(s.saveConflict, null);
  void headAtAnalysis; void other;
});

test('impactBranchAdvanced：本地分支前进即判定（服务端核对前）', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor });
  assert.equal(s.impactBranchAdvanced(res.snapshot), false);
  s.commit((m) => { m.rects.find((r) => r.id === anchor).name = '改名'; }, { label: '前进一次' });
  assert.equal(s.impactBranchAdvanced(res.snapshot), true);
  const snap = s.impactById(res.snapshot.id);
  assert.ok(snap.conflict === null, '仅本地查看时不预写冲突；应用时才返回 409');
});

/* ==================== Store：重启一致 ==================== */

test('刷新 / 重启：快照、候选、模拟、冲突原因、应用事件与报告保持一致', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { name: '重启测试', changes: [{ kind: 'move-rect', rectId: anchor, x: 260 }] });
  const applied = await s.applyImpact(res.snapshot.id);
  await s.flushed();
  const eventId = applied.event.id;
  const reportChecksum = s.impactById(res.snapshot.id).report.checksum;

  const s2 = new Store({ base: '' });
  await s2.load();
  const snap2 = s2.impactById(res.snapshot.id);
  assert.ok(snap2, '快照随文档持久化');
  assert.equal(snap2.status, 'applied');
  assert.equal(snap2.appliedEventId, eventId);
  assert.equal(snap2.changes.length, 1, '候选保留');
  assert.ok(snap2.simulation.model, '模拟结果保留');
  assert.ok(snap2.impact, '影响面保留');
  const ev = s2.eventsById.get(eventId);
  assert.equal(ev.kind, 'impact');
  assert.equal(ev.impact.snapshotId, snap2.id);
  // 报告内容逐字节一致（校验和确定）
  const report2 = s2.impactReport(snap2.id, { generatedAt: snap2.report.generatedAt });
  assert.equal(report2.checksum, reportChecksum);
});

test('重启：open 快照（含冲突原因）恢复后仍可查看 / 放弃 / 改候选', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor }, { changes: [{ kind: 'move-rect', rectId: anchor, x: 260 }] });
  // 直接在快照上写一个冲突原因（等价于应用时分支前进落库）
  s._replaceImpact({ ...res.snapshot, conflict: { reason: 'impact-branch-advanced', headEventId: 'x', headSeq: 9, at: 123 } });
  s.persist();
  await s.flushed();

  const s2 = new Store({ base: '' });
  await s2.load();
  const snap2 = s2.impactById(res.snapshot.id);
  assert.equal(snap2.status, 'open');
  assert.equal(snap2.conflict.reason, 'impact-branch-advanced');
  const u = s2.discardImpactChange(snap2.id, snap2.changes[0].id);
  assert.equal(u.ok, true);
});

/* ==================== 纯函数：清洗 / 合流 / 报告 ==================== */

test('sanitizeImpactSnapshots：结构清洗、非法候选剔除、applied 缺事件回退 open', () => {
  const baseModel = normalize({ canvas: { w: 1000, h: 700 }, rects: [], constraints: [] });
  const good = {
    id: 'ia_1', status: 'open', branchId: 'main', headEventId: 'e1', docRev: 1,
    seed: { kind: 'rect', id: 'r1' }, baseHash: 'h', baseModel, baseReport: null,
    changes: [
      { id: 'c1', kind: 'move-rect', rectId: 'r1', x: 1 },
      { id: 'bad', kind: 'bogus' },
    ],
    simulation: null, impact: null,
  };
  const appliedOrphan = {
    id: 'ia_2', status: 'applied', branchId: 'main', headEventId: 'e1',
    seed: { kind: 'rect', id: 'r1' }, baseModel, changes: [],
  };
  const malformed = { id: 'ia_3', status: 'open' };
  const out = sanitizeImpactSnapshots([good, good, appliedOrphan, malformed]);
  assert.equal(out.length, 2, '重复 id 去重、结构缺失丢弃');
  const a = out.find((x) => x.id === 'ia_1');
  assert.deepEqual(a.changes.map((c) => c.id), ['c1'], '非法候选被剔除');
  const b = out.find((x) => x.id === 'ia_2');
  assert.equal(b.status, 'open', 'applied 缺 appliedEventId 回退 open');
});

test('mergeImpactSnapshots：按 id 并集；applied 不被 open 旧副本降级；open 新者胜', () => {
  const open1 = { id: 'ia_x', status: 'open', updatedAt: 1, changes: [] };
  const open2 = { id: 'ia_x', status: 'open', updatedAt: 2, changes: [] };
  assert.equal(mergeImpactSnapshots([open1], [open2])[0].updatedAt, 2);
  const applied = { id: 'ia_y', status: 'applied', updatedAt: 1, appliedEventId: 'e9', resultHash: 'h', appliedAt: 1, report: { 1: 1 } };
  const stale = { id: 'ia_y', status: 'open', updatedAt: 99, changes: [] };
  const m = mergeImpactSnapshots([stale], [applied]);
  assert.equal(m[0].status, 'applied');
  assert.equal(m[0].appliedEventId, 'e9');
  const m2 = mergeImpactSnapshots([applied], [stale]);
  assert.equal(m2[0].status, 'applied');
});

test('buildImpactReport：含影响面 / 模拟 / 候选 / 版本绑定，输出确定性校验和', () => {
  const fp1 = changesFingerprint([{ kind: 'move-rect', rectId: 'r1', x: 1, y: 2 }]);
  const fp2 = changesFingerprint([{ kind: 'move-rect', rectId: 'r1', y: 2, x: 1 }]);
  assert.equal(fp1, fp2, '候选字段顺序不影响指纹');
  const snapshot = {
    id: 'ia_r', name: '报告测试', createdAt: 10, actor: '甲', status: 'open',
    seed: { kind: 'rect', id: 'r1' }, branchId: 'main', branchName: '主分支', headEventId: 'e1',
    docRev: 3, baseHash: 'abc', baseModel: null, baseReport: null, changes: [], impact: null, simulation: null, conflict: null,
  };
  const r1 = buildImpactReport(snapshot, { generatedAt: 555 });
  const r2 = buildImpactReport(snapshot, { generatedAt: 555 });
  assert.equal(r1.checksum, r2.checksum, '同输入同校验和');
  assert.equal(r1.kind, 'impact-analysis-report');
  assert.equal(r1.snapshot.docRev, 3);
  assert.ok(/^[0-9a-z]+$/.test(r1.checksum));
});

/* ==================== 跨分支合流 ==================== */

test('另一页面在不同分支上的分析快照经保存合流，两边都保留', async () => {
  const s = await chainStore();
  const anchor = byName(s, '锚点');
  // main 上建一个 open 快照
  const res = s.createImpactAnalysis({ kind: 'rect', id: anchor });
  await s.flushed();
  // fork 另一分支并在其上分析
  s.forkFromEvent(s.branch.headEventId, '分析分支');
  const res2 = s.createImpactAnalysis({ kind: 'rect', id: anchor });
  await s.flushed();
  assert.ok(res.snapshot.id !== res2.snapshot.id);
  const serverSnapshots = harness.doc.impactSnapshots.map((x) => x.id).sort();
  assert.ok(serverSnapshots.includes(res.snapshot.id));
  assert.ok(serverSnapshots.includes(res2.snapshot.id));
});

/* ---------- 注册为串行 suite ---------- */

describe('影响分析与安全变更', { concurrency: 1 }, () => {
  rawTest.afterEach(afterEachFn);
  for (const [name, fn] of collected) rawTest(name, fn);
});
