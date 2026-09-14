// 编辑分支三方合并：共同祖先 / 自动合并（两边只改不同对象）/ 同对象冲突逐项解决 /
// 删除-修改相撞 / 悬空引用 / 环 / 越界阻止完成 / 幂等（重复提交不产生重复事件）/
// 目标分支前进 409 与更新后逐项重确认 / 草案持久化与重启一致 / 合并事件与来源关系不改写历史。
// 用内存模拟服务器（与 audit.test.mjs 同一套 harness），收集后在文件末尾注册为串行 suite。
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
const { newRect, newSnap, newMinGap } = await import('../web/js/geom/model.js');
const {
  findMergeBase, buildMergePlan, assembleMergeModel, finalizeMergeModel,
  choicesToMap, itemKey, mergeMergeDrafts,
} = await import('../web/js/geom/merge.js');

function makeHarness() {
  // 用对象字段而非闭包局部变量：测试可直接读 harness.doc 观察当前服务端文档
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
      // opts.body 是 JSON 字符串：parse 后即与真实 HTTP 等价的独立对象
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

/** 分叉：main 提交一次后 fork，来源分支与目标分支各自继续编辑。 */
async function diverged({ targetEdit = null, sourceEdit = null, seedExtra = null } = {}) {
  const { s } = await freshStore();
  s.setActor('甲');
  if (seedExtra) s.commit(seedExtra, { label: '基线编辑' });
  s.commit((m) => m.rects.push(newRect(320, 300, 80, 60, '基线矩形')), { label: '分叉点' });
  const baseId = s.branch.headEventId;
  await s.flushed();
  const fk = s.forkFromEvent(baseId, '来源分支');
  const sourceBranchId = fk.branch.id;
  if (sourceEdit) s.commit(sourceEdit, { label: '来源编辑' });
  await s.flushed();
  s.switchBranch(MAIN_BRANCH);
  if (targetEdit) s.commit(targetEdit, { label: '目标编辑' });
  await s.flushed();
  return { s, baseId, sourceBranchId };
}

const openAndPlan = (s, sourceBranchId) => {
  const opened = s.openMergeDraft(MAIN_BRANCH, sourceBranchId);
  assert.ok(opened.ok, opened.error);
  return opened;
};

/* ---------- 纯函数：共同祖先 ---------- */

test('findMergeBase：fork 后两边各改，共同祖先是 fork 点', async () => {
  const { s, baseId, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(10, 10, 20, 20, 'S')),
    targetEdit: (m) => m.rects.push(newRect(20, 20, 20, 20, 'T')),
  });
  const t = s.eventsById.get(s.branch.headEventId);
  const src = s.eventsById.get(s.branches.find((b) => b.id === sourceBranchId).headEventId);
  const base = findMergeBase(t, src, s.eventsById);
  assert.equal(base.id, baseId);
});

/* ---------- 自动合并：两边只改不同对象 ---------- */

test('两边只改不同对象：全部自动合并，无冲突，可直接完成', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(100, 100, 40, 40, '来源矩形')),
    targetEdit: (m) => m.rects.push(newRect(500, 100, 40, 40, '目标矩形')),
  });
  const opened = openAndPlan(s, sourceBranchId);
  assert.equal(opened.plan.counts.conflicts, 0);
  assert.equal(opened.plan.counts.auto, 2);
  const pv = s.previewMerge(opened.draft.id);
  assert.ok(pv.ok, JSON.stringify(pv.errors));
  assert.ok(pv.model.rects.some((r) => r.name === '来源矩形'));
  assert.ok(pv.model.rects.some((r) => r.name === '目标矩形'));

  const cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok, cm.error);
  assert.equal(cm.event.kind, 'merge');
  assert.equal(s.model.rects.some((r) => r.name === '来源矩形'), true);
  assert.equal(s.model.rects.some((r) => r.name === '目标矩形'), true);
  await s.flushed();
});

test('一边移动矩形、另一边改不相关约束：自动合并', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => {
      const r = m.rects.find((x) => x.name === '基线矩形');
      r.x = 100; r.y = 100; // 无约束新矩形，移动生效
    },
    targetEdit: (m) => {
      const A = m.rects.find((x) => x.name === '卡片A').id;
      const B = m.rects.find((x) => x.name === '标签B').id;
      m.constraints.push(newMinGap(B, A, 'below', 15, 31));
    },
  });
  const opened = openAndPlan(s, sourceBranchId);
  assert.equal(opened.plan.counts.conflicts, 0, '矩形与约束是不同对象');
  assert.ok(opened.plan.rects.auto.length >= 1);
  assert.ok(opened.plan.constraints.auto.length >= 1);
  const cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok, cm.error);
});

/* ---------- 同对象冲突：逐项 保留目标 / 采用来源 / 手动 ---------- */

test('同一矩形被双方改名：产生冲突，未解决阻止完成，逐项选择后通过', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '来源名'; },
    targetEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '目标名'; },
  });
  const opened = openAndPlan(s, sourceBranchId);
  assert.equal(opened.plan.rects.conflicts.length, 1);
  // 未解决不能完成
  const blocked = await s.commitMerge(opened.draft.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'merge-blocked');
  assert.ok(blocked.unresolved.length >= 1);

  const key = itemKey(opened.plan.rects.conflicts[0]);
  assert.equal(s.setMergeResolution(opened.draft.id, key, 'target').ok, true);
  const pvT = s.previewMerge(opened.draft.id);
  assert.ok(pvT.ok);
  assert.ok(pvT.model.rects.some((r) => r.name === '目标名'));
  assert.equal(pvT.model.rects.some((r) => r.name === '来源名'), false);

  // 改为采用来源
  assert.equal(s.setMergeResolution(opened.draft.id, key, 'source').ok, true);
  const pvS = s.previewMerge(opened.draft.id);
  assert.ok(pvS.model.rects.some((r) => r.name === '来源名'));

  const cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok, cm.error);
  assert.deepEqual(cm.report.items.filter((i) => i.via === 'conflict').map((i) => i.resolution), ['source']);
});

test('手动填写矩形结果：自定义名称/位置/尺寸生效，非法几何被拒', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '来源名'; },
    targetEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '目标名'; },
  });
  const opened = openAndPlan(s, sourceBranchId);
  const item = opened.plan.rects.conflicts[0];
  const key = itemKey(item);
  const bad = s.setMergeResolution(opened.draft.id, key, 'manual',
    { id: item.id, name: '坏矩形', x: 10, y: 10, w: -5, h: 10 });
  assert.equal(bad.ok, false, '负宽度被拒绝');
  const good = s.setMergeResolution(opened.draft.id, key, 'manual',
    { id: item.id, name: '手动画', x: 210, y: 210, w: 55, h: 44 });
  assert.ok(good.ok);
  const pv = s.previewMerge(opened.draft.id);
  assert.ok(pv.ok, JSON.stringify(pv.errors));
  const r = pv.model.rects.find((x) => x.id === item.id);
  assert.equal(r.name, '手动画');
  assert.equal(r.w, 55);
  assert.equal(r.h, 44);
});

test('同一条约束双方改不同字段也算冲突；手动 JSON 可解决', async () => {
  const { s } = await freshStore();
  s.commit((m) => {
    const A = m.rects.find((x) => x.name === '卡片A').id;
    const B = m.rects.find((x) => x.name === '标签B').id;
    m.constraints.push(newSnap(B, A, 'y', 't', 't', 0, 50));
  }, { label: '基线加约束' });
  const baseId = s.branch.headEventId;
  await s.flushed();
  const fk = s.forkFromEvent(baseId, '约束来源');
  const src = fk.branch.id;
  s.commit((m) => { m.constraints.find((c) => c.axis === 'y').priority = 90; }, { label: '来源提优先级' });
  await s.flushed();
  s.switchBranch(MAIN_BRANCH);
  s.commit((m) => { m.constraints.find((c) => c.axis === 'y').enabled = false; }, { label: '目标停用' });
  await s.flushed();

  const opened = openAndPlan(s, src);
  const cc = opened.plan.constraints.conflicts;
  assert.equal(cc.length, 1, '同约束被双方修改');
  const key = itemKey(cc[0]);
  s.setMergeResolution(opened.draft.id, key, 'source');
  const cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok, cm.error);
  const merged = s.model.constraints.find((c) => c.id === cc[0].id);
  assert.equal(merged.priority, 90);
  assert.equal(merged.enabled, true, '采用来源（仍启用）');
});

/* ---------- 删除 / 修改相撞 ---------- */

test('一边删除矩形、另一边修改它：删除-修改冲突，两种选择都可完成', async () => {
  // 目标删除基线矩形；来源移动它
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => { const r = m.rects.find((x) => x.name === '基线矩形'); r.x = 250; r.y = 250; },
    targetEdit: (m) => { m.rects = m.rects.filter((x) => x.name !== '基线矩形'); },
  });
  const opened = openAndPlan(s, sourceBranchId);
  const rc = opened.plan.rects.conflicts[0];
  assert.ok(rc, '矩形删除/修改冲突');
  assert.equal(rc.target, null, '目标侧已删除');
  assert.ok(rc.source, '来源侧仍存在');
  const key = itemKey(rc);

  // 采用来源 -> 矩形保留（且来源移动生效）
  s.setMergeResolution(opened.draft.id, key, 'source');
  let pv = s.previewMerge(opened.draft.id);
  assert.ok(pv.ok, JSON.stringify(pv.errors));
  assert.ok(pv.model.rects.some((r) => r.id === rc.id));
  let cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok, cm.error);
  assert.ok(s.model.rects.some((r) => r.id === rc.id));

  // 另一场景：保留目标（=接受删除）-> 矩形被删除
  const { s: s2, sourceBranchId: src2 } = await diverged({
    sourceEdit: (m) => { const r = m.rects.find((x) => x.name === '基线矩形'); r.x = 250; },
    targetEdit: (m) => { m.rects = m.rects.filter((x) => x.name !== '基线矩形'); },
  });
  const op2 = openAndPlan(s2, src2);
  s2.setMergeResolution(op2.draft.id, itemKey(op2.plan.rects.conflicts[0]), 'target');
  pv = s2.previewMerge(op2.draft.id);
  assert.ok(pv.ok, JSON.stringify(pv.errors));
  assert.equal(pv.model.rects.some((r) => r.id === op2.plan.rects.conflicts[0].id), false);
  cm = await s2.commitMerge(op2.draft.id);
  assert.ok(cm.ok);
});

test('一边删约束另一边改它：删除-修改冲突', async () => {
  const { s } = await freshStore();
  s.setActor('甲');
  s.commit((m) => {
    const A = m.rects.find((x) => x.name === '卡片A').id;
    const B = m.rects.find((x) => x.name === '标签B').id;
    m.constraints.push(newSnap(B, A, 'y', 'b', 'b', 0, 45));
  }, { label: '基线约束' });
  const baseId = s.branch.headEventId;
  await s.flushed();
  const fk = s.forkFromEvent(baseId, '删改来源');
  const src = fk.branch.id;
  const cid = s.model.constraints.find((c) => c.axis === 'y').id;
  s.commit((m) => { m.constraints = m.constraints.filter((c) => c.id !== cid); }, { label: '来源删除约束' });
  await s.flushed();
  s.switchBranch(MAIN_BRANCH);
  s.commit((m) => { m.constraints.find((c) => c.id === cid).priority = 99; }, { label: '目标改优先级' });
  await s.flushed();
  const opened = openAndPlan(s, src);
  const cc = opened.plan.constraints.conflicts;
  assert.equal(cc.length, 1);
  assert.equal(cc[0].source, null);
  s.setMergeResolution(opened.draft.id, itemKey(cc[0]), 'target'); // 保留目标（修改保留）
  const cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok, cm.error);
  assert.equal(s.model.constraints.some((c) => c.id === cid), true);
});

/* ---------- 悬空引用 / 环 / 越界：必须阻止完成 ---------- */

test('合并后悬空引用（一边删矩形、另一边新增引用它的约束）被阻止并给出原因', async () => {
  const { s } = await freshStore();
  s.setActor('甲');
  // 基线新增独立矩形 K，并让它被 contain 固定在画布内（求解后位置不动，避免新增约束把它拉动）
  let kid;
  s.commit((m) => {
    const k = newRect(300, 400, 70, 50, 'K');
    kid = k.id;
    m.rects.push(k);
    m.constraints.push({ id: 'c_k_contain', kind: 'contain', rect: kid, margin: 0, priority: 20, enabled: true });
  }, { label: '基线 K' });
  const baseId = s.branch.headEventId;
  await s.flushed();
  const fk = s.forkFromEvent(baseId, '悬空来源');
  const src = fk.branch.id;
  // 来源：新增另一条引用 K 的约束（不移动 K）
  s.commit((m) => {
    const A = m.rects.find((x) => x.name === '卡片A').id;
    m.constraints.push(newMinGap(A, kid, 'above', 10, 15));
  }, { label: '来源引用 K' });
  await s.flushed();
  s.switchBranch(MAIN_BRANCH);
  // 目标：删除矩形 K 及其基线 contain 约束（来源新增的另一条引用 K 的约束在目标侧不存在）
  s.commit((m) => {
    m.rects = m.rects.filter((r) => r.id !== kid);
    m.constraints = m.constraints.filter((c) => c.rect !== kid);
  }, { label: '目标删 K' });
  await s.flushed();

  const opened = openAndPlan(s, src);
  // 两边改不同对象：约束自动并入、矩形自动删除，没有对象级冲突，但结果悬空
  assert.equal(opened.plan.counts.conflicts, 0, '没有对象级冲突（悬空是合并后整体校验）');
  const pv = s.previewMerge(opened.draft.id);
  assert.equal(pv.ok, false);
  assert.ok(pv.errors.some((e) => e.code === 'dangling-ref'), JSON.stringify(pv.errors));
  const cm = await s.commitMerge(opened.draft.id);
  assert.equal(cm.ok, false);
  assert.equal(cm.reason, 'merge-blocked');
  // 目标分支 head 没有被推进
  assert.equal(s.branch.headEventId, s.branches.find((b) => b.id === MAIN_BRANCH).headEventId);
});

test('合并后成环被阻止并给出环上矩形/约束', async () => {
  const { s } = await freshStore();
  s.setActor('甲');
  // 基线：新增两个无约束矩形 P、Q（单条边无环）
  let P, Q;
  s.commit((m) => {
    const p = newRect(200, 200, 60, 60, 'P');
    const q = newRect(400, 200, 60, 60, 'Q');
    P = p.id; Q = q.id;
    m.rects.push(p, q);
  }, { label: '基线 P/Q' });
  const baseId = s.branch.headEventId;
  await s.flushed();
  const fk = s.forkFromEvent(baseId, '成环来源');
  const src = fk.branch.id;
  // 来源只加 Q → P 一条边（单独无环）
  const rSrc = s.commit((m) => m.constraints.push(newSnap(Q, P, 'x', 'l', 'r', 20, 50)), { label: '来源 Q→P' });
  assert.ok(rSrc.ok && !rSrc.cycle, '来源单分支无环');
  await s.flushed();
  s.switchBranch(MAIN_BRANCH);
  // 目标加 P → Q 一条边（单独无环）+ 一个独立矩形
  const rTgt = s.commit((m) => {
    m.rects.push(newRect(40, 40, 30, 30, '目标独立'));
    m.constraints.push(newSnap(P, Q, 'x', 'l', 'r', 20, 50));
  }, { label: '目标 P→Q' });
  assert.ok(rTgt.ok && !rTgt.cycle, '目标单分支无环');
  await s.flushed();

  const opened = openAndPlan(s, src);
  // 两条边在各自分支都是新增 -> 自动并入，合并后成环；无对象级冲突
  assert.equal(opened.plan.counts.conflicts, 0, '没有对象冲突（自动合并）');
  assert.ok(opened.plan.constraints.auto.length >= 2, '两条边都自动并入');
  const pv = s.previewMerge(opened.draft.id);
  assert.equal(pv.ok, false, '自动合并结果成环必须阻止');
  assert.ok(pv.errors.some((e) => e.code === 'cycle'), JSON.stringify(pv.errors));
  assert.ok(pv.cycle.nodeIds.includes(P) && pv.cycle.nodeIds.includes(Q));
  assert.ok(pv.cycle.cids.length === 2);
  const cm = await s.commitMerge(opened.draft.id);
  assert.equal(cm.ok, false);
  assert.equal(cm.reason, 'merge-blocked');
});

test('手动结果把矩形移出画布：越界阻止完成', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '来源名'; },
    targetEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '目标名'; },
  });
  const opened = openAndPlan(s, sourceBranchId);
  const item = opened.plan.rects.conflicts[0];
  s.setMergeResolution(opened.draft.id, itemKey(item), 'manual',
    { id: item.id, name: '越界矩形', x: 980, y: 680, w: 80, h: 60 }); // 超出 1000×700
  const pv = s.previewMerge(opened.draft.id);
  assert.equal(pv.ok, false);
  assert.ok(pv.errors.some((e) => e.code === 'out-of-bounds'), JSON.stringify(pv.errors));
});

/* ---------- 幂等：重复提交同一份草案不产生重复事件 ---------- */

test('重复提交同一合并草案幂等：不产生重复 merge 事件', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(100, 100, 30, 30, '来源')),
    targetEdit: (m) => m.rects.push(newRect(200, 200, 30, 30, '目标')),
  });
  const opened = openAndPlan(s, sourceBranchId);
  const c1 = await s.commitMerge(opened.draft.id);
  assert.ok(c1.ok && !c1.idempotent);
  const eventsAfter = s.events.length;
  const c2 = await s.commitMerge(opened.draft.id);
  assert.ok(c2.ok && c2.idempotent, '第二次提交是幂等返回');
  assert.equal(c2.event.id, c1.event.id, '返回同一条合并事件');
  assert.equal(s.events.length, eventsAfter, '没有新增事件');
  assert.equal(s.events.filter((e) => e.kind === 'merge').length, 1);
});

test('同一对分支 head 重复打开草案复用同一 id（不产生重复草案）', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(5, 5, 20, 20, 'S')),
  });
  const o1 = s.openMergeDraft(MAIN_BRANCH, sourceBranchId);
  const id1 = o1.draft.id;
  s.selectMergeDraft(null);
  const o2 = s.openMergeDraft(MAIN_BRANCH, sourceBranchId);
  assert.equal(o2.draft.id, id1);
  assert.equal(s.mergeDrafts.filter((d) => d.id === id1).length, 1);
});

/* ---------- 合并不改写原分支与历史 ---------- */

test('合并只追加目标分支事件：来源分支与原事件不变', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(100, 100, 30, 30, '来源')),
    targetEdit: (m) => m.rects.push(newRect(200, 200, 30, 30, '目标')),
  });
  const srcHeadBefore = s.branches.find((b) => b.id === sourceBranchId).headEventId;
  const mainHeadBefore = s.branch.headEventId;
  const allEventsBefore = s.events.map((e) => [e.id, e.hash]);
  const opened = openAndPlan(s, sourceBranchId);
  const cm = await s.commitMerge(opened.draft.id);
  assert.ok(cm.ok);
  assert.equal(s.branches.find((b) => b.id === sourceBranchId).headEventId, srcHeadBefore, '来源 head 不变');
  assert.notEqual(s.branch.headEventId, mainHeadBefore, '目标 head 前进到 merge 事件');
  assert.equal(s.branch.headEventId, cm.event.id);
  // merge 事件的 parent 是合并前目标 head，merge 元数据记录来源关系
  assert.equal(cm.event.parentId, mainHeadBefore);
  assert.equal(cm.event.merge.sourceBranchId, sourceBranchId);
  assert.equal(cm.event.merge.draftId, opened.draft.id);
  // 既有事件未被改写
  for (const [id, hash] of allEventsBefore) {
    assert.equal(s.eventsById.get(id).hash, hash);
  }
});

/* ---------- 合并期间目标分支前进：版本冲突 + 更新后逐项重确认 ---------- */

test('合并期间目标分支被另一页面推进：提交返回版本冲突，选择保留；更新 head 后重新确认', async () => {
  const { s: p1, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(100, 100, 30, 30, '来源矩形')),
    targetEdit: (m) => m.rects.push(newRect(200, 200, 30, 30, '目标矩形')),
  });
  const opened = p1.openMergeDraft(MAIN_BRANCH, sourceBranchId);
  assert.ok(opened.ok);
  const draftId = opened.draft.id;
  assert.equal(opened.plan.counts.conflicts, 0, '本场景无对象冲突');
  await p1.flushed(); // 草案先落盘服务端，再让另一页面加载

  // 另一页面在 main 的当前 head 上追加一个提交（经服务端，不经 p1）。
  const p2 = new Store({ base: '' });
  await p2.load();
  p2.commit((m) => m.rects.push(newRect(400, 400, 30, 30, '后来的矩形')), { label: '合并期间插入' });
  await p2.flushed();

  // p1 本地视图尚未刷新：mergeTargetAdvanced 为 false，但 commitMerge 会向服务端核对 head
  assert.equal(p1.mergeTargetAdvanced(p1.mergeDraftById(draftId)), false, '本地视图尚未感知前进');
  const cm = await p1.commitMerge(draftId);
  assert.equal(cm.ok, false);
  assert.equal(cm.status, 409);
  assert.equal(cm.reason, 'merge-target-advanced');
  assert.equal(cm.targetHeadId, p2.branch.headEventId, '409 带回服务端最新 head');
  const eventsBefore = p1.events.length;
  assert.equal(p1.branch.headEventId, opened.draft.targetHeadId, '未追加任何事件、目标 head 不变');
  // 草案仍在、可重建包含来源矩形的合并预览：本地选择保留
  const pv0 = p1.previewMerge(draftId);
  assert.ok(pv0.ok && pv0.model.rects.some((r) => r.name === '来源矩形'), '本地合并选择仍保留（预览仍含来源改动）');
  void eventsBefore;

  // p1 更新到最新分支头（先从服务端拉取最新文档）
  await p1.load();
  const r = p1.refreshMergeDraftHeads(draftId);
  assert.ok(r.ok, r.error);
  const newDraftId = p1.activeMergeDraftId;
  assert.notEqual(newDraftId, draftId, 'head 变化产生新草案 id');
  const view = p1.mergeDraftView(newDraftId);
  assert.ok(view.ok);
  assert.equal(p1.mergeDraftById(draftId).status, 'superseded', '旧草案标记 superseded');
  // 新计划：来源矩形与后来的矩形自动并存
  const pv = p1.previewMerge(newDraftId);
  assert.ok(pv.ok, JSON.stringify(pv.errors));
  assert.ok(pv.model.rects.some((x) => x.name === '来源矩形'));
  assert.ok(pv.model.rects.some((x) => x.name === '后来的矩形'));
  // 完成后三方内容都在
  const cm2 = await p1.commitMerge(newDraftId);
  assert.ok(cm2.ok, cm2.error);
  assert.ok(p1.model.rects.some((x) => x.name === '来源矩形'));
  assert.ok(p1.model.rects.some((x) => x.name === '目标矩形'));
  assert.ok(p1.model.rects.some((x) => x.name === '后来的矩形'));
});

test('目标前进导致旧选择的冲突消失/变化时，更新后只保留仍适用的选择', async () => {
  const { s: p1 } = await diverged({
    sourceEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '来源名'; },
    targetEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '目标名'; },
  });
  const src = p1.branches.find((b) => b.name === '来源分支').id;
  const opened = p1.openMergeDraft(MAIN_BRANCH, src);
  const key = itemKey(opened.plan.rects.conflicts[0]);
  p1.setMergeResolution(opened.draft.id, key, 'source');
  await p1.flushed();

  // 另一页面（同源 localStorage / 经服务端）在 main 上把目标名改成与来源相同
  const p2 = new Store({ base: '' });
  await p2.load();
  p2.commit((m) => { m.rects.find((x) => x.name === '目标名').name = '来源名'; }, { label: '目标趋同' });
  await p2.flushed();

  await p1.load();
  const r = p1.refreshMergeDraftHeads(opened.draft.id);
  assert.ok(r.ok);
  const view = p1.mergeDraftView(p1.activeMergeDraftId);
  // 两边结果现在相同：tri 仍标记双方 changed（相对各自 base），但 sameResult=true；
  // 选择仍按 key 保留，提交结果确定（=来源名）
  const carried = view.draft.choices;
  assert.ok(carried.some((c) => c.key === key), '仍适用的选择保留');
  const cm = await p1.commitMerge(p1.activeMergeDraftId);
  assert.ok(cm.ok, cm.error);
  assert.ok(p1.model.rects.some((x) => x.name === '来源名'));
});

/* ---------- 刷新 / 重启一致性 ---------- */

test('刷新/重启后草案、共同祖先、冲突选择、来源关系、报告一致', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '来源名'; },
    targetEdit: (m) => { m.rects.find((x) => x.name === '基线矩形').name = '目标名'; },
  });
  const opened = openAndPlan(s, sourceBranchId);
  const item = opened.plan.rects.conflicts[0];
  s.setMergeResolution(opened.draft.id, itemKey(item), 'manual',
    { id: item.id, name: '重启后保留', x: 150, y: 150, w: 33, h: 22 });
  s.selectMergeDraft(opened.draft.id);
  await s.flushed();

  const s2 = new Store({ base: '' });
  await s2.load();
  const d2 = s2.mergeDraftById(opened.draft.id);
  assert.ok(d2, '草案持久化');
  assert.equal(d2.status, 'open');
  assert.equal(s2.activeMergeDraftId, opened.draft.id, '打开的草案 id 持久化');
  const view = s2.mergeDraftView(d2.id);
  assert.ok(view.ok);
  assert.equal(view.plan.baseEventId, opened.plan.baseEventId, '共同祖先一致');
  assert.equal(view.plan.counts.conflicts, 1);
  const ch = view.choices.get(itemKey(item));
  assert.equal(ch.resolution, 'manual');
  assert.equal(ch.manual.name, '重启后保留', '手动选择持久化');
  const pv = s2.previewMerge(d2.id);
  assert.ok(pv.ok, JSON.stringify(pv.errors));
  assert.ok(pv.model.rects.some((r) => r.name === '重启后保留'));
});

test('完成后重启：草案为 completed，merge 事件可回放，报告与前后差异可查看', async () => {
  const { s, sourceBranchId } = await diverged({
    sourceEdit: (m) => m.rects.push(newRect(100, 100, 30, 30, '来源矩形')),
    targetEdit: (m) => m.rects.push(newRect(200, 200, 30, 30, '目标矩形')),
  });
  const opened = openAndPlan(s, sourceBranchId);
  const cm = await s.commitMerge(opened.draft.id);
  await s.flushed();

  const s2 = new Store({ base: '' });
  await s2.load();
  const d = s2.mergeDraftById(opened.draft.id);
  assert.equal(d.status, 'completed');
  assert.equal(d.mergeEventId, cm.event.id);
  const ev = s2.eventsById.get(cm.event.id);
  assert.equal(ev.kind, 'merge');
  assert.ok(!ev.corrupt, '合并事件指纹校验通过、可回放');
  assert.ok(s2.replay(cm.event.id).ok);
  assert.equal(s2.report.hash, cm.event.hash);
  s2.exitReplay();
  const rep = s2.mergeReportForEvent(cm.event.id);
  assert.ok(rep);
  assert.ok(rep.diff.rects.added.length >= 1, '合并报告含相对目标 head 的差异');
  assert.equal(rep.mergeEventId, cm.event.id);
  assert.equal(rep.items.length, opened.plan.counts.auto + opened.plan.counts.conflicts);
});

/* ---------- 草案跨页面合流（纯函数） ---------- */

test('mergeMergeDrafts：open 选择按键并集；completed 不被 open 旧副本降级', () => {
  const open1 = { id: 'd1', status: 'open', updatedAt: 1, choices: [{ key: 'rect:a', resolution: 'source' }] };
  const open2 = { id: 'd1', status: 'open', updatedAt: 2, choices: [{ key: 'rect:b', resolution: 'target' }] };
  const m1 = mergeMergeDrafts([open1], [open2]);
  assert.equal(m1[0].status, 'open');
  assert.equal(m1[0].choices.length, 2);

  const done = { id: 'd2', status: 'completed', updatedAt: 5, mergeEventId: 'e9', resultHash: 'h', completedAt: 5, targetHeadId: 'e9', report: { x: 1 }, choices: [] };
  const staleOpen = { id: 'd2', status: 'open', updatedAt: 1, choices: [] };
  const m2 = mergeMergeDrafts([staleOpen], [done]);
  assert.equal(m2[0].status, 'completed');
  assert.equal(m2[0].mergeEventId, 'e9');
  // 反向：服务端 completed，客户端晚到 open
  const m3 = mergeMergeDrafts([done], [staleOpen]);
  assert.equal(m3[0].status, 'completed');
  assert.equal(m3[0].mergeEventId, 'e9');
});

/* ---------- 注册为串行 suite ---------- */

describe('编辑分支三方合并', { concurrency: 1 }, () => {
  rawTest.afterEach(afterEachFn);
  for (const [name, fn] of collected) rawTest(name, fn);
});
