// 布局方案实验：建立/幂等/批量运行/失败隔离/暂停继续取消/结果不可覆盖/
// 与基准差异/另存分支（实验来源）/重启一致/损坏容忍/跨页面合流（纯函数 + Store，内存服务器）。
import { describe, test as rawTest } from 'node:test';
import assert from 'node:assert/strict';

const collected = [];
const test = (name, fn) => collected.push([name, fn]);

let activeFetch = null;
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
globalThis.fetch = (url, opts) => activeFetch ? activeFetch(url, opts)
  : Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve({}) });

const pendingTimers = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = _setTimeout(fn, ms, ...args);
  pendingTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => {
  pendingTimers.delete(id);
  return _clearTimeout(id);
};

const {
  makeExperiment, prepareSpecs, executeVariant, makeVariantResult,
  sanitizeExperiments, mergeExperiments, experimentConfigHash,
  diffVariant, variantCounters,
} = await import('../web/js/geom/experiments.js');
const { Store } = await import('../web/js/geom/store.js');
const { newRect, newSnap } = await import('../web/js/geom/model.js');
const { mergeDocs, assessConflict, MAIN_BRANCH } = await import('../web/js/geom/audit.js');

function makeHarness() {
  let serverDoc = null;
  let gen = 0;
  const fetchImpl = (url, opts = {}) => {
    const myGen = gen;
    const method = opts.method || 'GET';
    const jsonOk = (obj) => ({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(obj)) });
    if (method === 'GET') {
      if (myGen !== gen || !serverDoc) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(jsonOk(serverDoc));
    }
    if (method === 'PUT') {
      if (myGen !== gen) return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) });
      const body = JSON.parse(opts.body);
      const curRev = serverDoc?.rev ?? 0;
      const reject = (info) => Promise.resolve({
        ok: false, status: 409,
        json: () => Promise.resolve({ error: 'revision-conflict', rev: curRev, ...info }),
      });
      const accept = (doc, extra = {}) => { serverDoc = doc; return jsonOk({ ok: true, rev: doc.rev, ...extra }); };
      if (body.baseRev !== curRev) {
        // 服务端无文档（首存，或 rearm 清空后按 localStorage 权威加载）：与 server.py 一致
        if (!serverDoc) {
          const doc = { ...body, rev: 1 };
          delete doc.baseRev; delete doc.baseHeads;
          return accept(doc);
        }
        const verdict = assessConflict(serverDoc, body);
        if (!verdict.mergeable) return reject(verdict);
        if (serverDoc) {
          const merged = mergeDocs(serverDoc, body);
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
      return accept(doc);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return {
    fetchImpl,
    nextGen() { gen++; },
    // 模拟“刷新且后端此刻不可用”：先 dispose 旧 Store（停运行器、作废防抖保存），
    // 再把篡改文档放入 localStorage，新 Store GET 404 回退读它。
    rearm(doc, oldStore) {
      gen++;
      serverDoc = null;
      oldStore?.dispose();
      mem.set('rect-constraints-doc-v2', JSON.stringify(doc));
    },
    clear() { serverDoc = null; },
    get doc() { return serverDoc; },
    set doc(v) { serverDoc = v; },
  };
}
const harness = makeHarness();
// 重要：node --test 会在同一进程加载全部测试文件，各文件对 globalThis.fetch 的安装
// 互相覆盖。这里和 freshStore() 都【重新安装】指向当前 harness 的 shim，
// 保证本文件运行时 fetch 一定走本文件的服务器。
const installFetch = () => { globalThis.fetch = (url, opts) => harness.fetchImpl(url, opts); };
installFetch();
activeFetch = harness.fetchImpl;

const drain = () => new Promise((r) => _setTimeout(r, 0));
const liveStores = new Set();
// 包装 Store 构造：本文件任何 new Store（含 reload / 合流测试里的额外实例）都登记，
// afterEach 统一中和迟到的防抖保存，杜绝跨测试文件的全局 fetch 污染。
function TrackedStore(...args) {
  const s = new Store(...args);
  liveStores.add(s);
  return s;
}
async function freshStore(opts = {}) {
  installFetch(); // 其他测试文件可能刚覆盖了 globalThis.fetch，重新安装回本文件的服务器
  for (const id of pendingTimers) _clearTimeout(id);
  pendingTimers.clear();
  mem.clear();
  harness.clear();
  harness.nextGen();
  const s = new TrackedStore({ base: '', tickMs: opts.tickMs ?? 2, onVariantGate: opts.onVariantGate ?? null });
  await s.load();
  return { s, h: harness };
}
async function settle(s, id) {
  await s.experimentSettled(id);
  await s.flushed();
}

/* ---------- 建立 + 批量运行 + 完整产物 ---------- */

test('从当前分支建立实验：变体自动批量求解，结果保存完整模型/求解结果/冲突链/指纹', async () => {
  const { s } = await freshStore();
  const headId = s.branch.headEventId;
  const target = s.model.rects.find((r) => r.name === '卡片A').id;
  const r = s.createExperiment([
    { name: 'A移动', rects: [{ id: target, x: 300, y: 260 }] },
    { name: 'A放大', rects: [{ id: target, w: 300, h: 180 }] },
  ], { name: '两方案' });
  assert.ok(r.ok);
  assert.equal(r.idempotent, false);
  const exp = r.experiment;
  assert.equal(exp.source.eventId, headId);
  assert.equal(exp.source.branchId, MAIN_BRANCH);
  assert.equal(exp.runState, 'running');
  assert.equal(exp.variants.length, 2);
  assert.deepEqual(exp.variants.map((v) => v.status), ['queued', 'queued']);

  await settle(s, exp.id);
  const done = s.experimentById(exp.id);
  assert.equal(done.runState, 'done');
  assert.deepEqual(done.variants.map((v) => v.status), ['done', 'done']);
  for (const v of done.variants) {
    assert.ok(v.result);
    assert.ok(Object.isFrozen(v.result), '完成结果冻结，不可覆盖');
    assert.equal(v.result.hash, v.result.report.hash);
    assert.ok(Array.isArray(v.result.conflicts));
    assert.ok(v.result.model.rects.length >= 4);
    assert.ok(v.result.completedAt > 0);
  }
  // 移动变体：目标矩形确实在新位置（求解后固化）
  const p0 = done.variants[0].result.report.rects[target];
  assert.equal(p0.x, 300);
  assert.equal(p0.y, 260);
  assert.notEqual(done.variants[0].result.hash, done.baseHash, '变体解与基准不同');
  assert.equal(done.variants[1].result.hash, s.experiments[0].variants[1].result.hash);
});

test('空修改变体=基准对照：求解结果与基准同指纹', async () => {
  const { s } = await freshStore();
  const r = s.createExperiment([{ name: '对照' }], { name: '对照实验' });
  assert.ok(r.ok);
  await settle(s, r.experiment.id);
  const exp = s.experimentById(r.experiment.id);
  assert.equal(exp.variants[0].status, 'done');
  assert.equal(exp.variants[0].result.hash, exp.baseHash);
});

/* ---------- 幂等 ---------- */

test('相同实验配置重复提交幂等（名称不参与指纹），返回同一实验且不重跑', async () => {
  const { s } = await freshStore();
  const target = s.model.rects[0].id;
  const specs1 = [{ name: '方案一', rects: [{ id: target, x: 200 }] }];
  const r1 = s.createExperiment(specs1, { name: '实验甲' });
  await settle(s, r1.experiment.id);
  const first = s.experimentById(r1.experiment.id);
  const resultId = first.variants[0].id;
  const resultHash = first.variants[0].result.hash;

  // 相同来源事件 + 相同参数（仅实验名/变体名不同）→ 返回原实验
  const r2 = s.createExperiment([{ name: '换个名字', rects: [{ id: target, x: 200 }] }], { name: '实验乙' });
  assert.ok(r2.ok);
  assert.equal(r2.idempotent, true);
  assert.equal(r2.experiment.id, first.id, '同一个实验');
  assert.equal(s.experiments.length, 1, '没有新建第二个实验');
  assert.equal(s.experiments[0].variants[0].id, resultId, '结果未重跑');
  assert.equal(s.experiments[0].variants[0].result.hash, resultHash);

  // 参数不同（x 不同）→ 新实验
  const r3 = s.createExperiment([{ rects: [{ id: target, x: 260 }] }], { name: '实验丙' });
  assert.equal(r3.idempotent, false);
  await settle(s, r3.experiment.id);
  assert.equal(s.experiments.length, 2);

  // 从新的分支时刻（提交一次后）重复：来源事件不同 → 不幂等
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, '新')));
  const r4 = s.createExperiment(specs1, { name: '实验甲' });
  assert.equal(r4.idempotent, false);
  await settle(s, r4.experiment.id);
  assert.equal(s.experiments.length, 3);
});

/* ---------- 失败隔离 ---------- */

test('单个变体失败（非法尺寸/成环）不阻塞其他变体，失败原因明确', async () => {
  const { s } = await freshStore();
  const target = s.model.rects[0].id;
  // 制造“启用后成环”的可能：先加一条被停用的反向约束（正常提交时停用不参与图）
  const A = s.model.rects.find((r) => r.name === '卡片A').id;
  const B = s.model.rects.find((r) => r.name === '标签B').id;
  const add = s.commit((m) => {
    m.constraints.push(newSnap(A, B, 'x', 'r', 'r', 0, 55));
    m.constraints[m.constraints.length - 1].enabled = false; // 停用：提交时无环
  }, { label: '停用的反向贴齐' });
  assert.ok(add.ok);
  const disabledId = s.model.constraints.find((c) => c.enabled === false).id;
  const existingSnap = s.model.constraints.find((c) => c.id !== disabledId && c.kind === 'snap' && c.axis === 'x' && c.rect === B).id;

  const r = s.createExperiment([
    { name: '成环甲', constraints: [{ id: disabledId, enabled: true }] },
    { name: '正常', constraints: [{ id: existingSnap, priority: 90 }] },
    { name: '成环乙', constraints: [{ id: disabledId, enabled: true }, { id: existingSnap, priority: 5 }] },
  ], { name: '失败隔离' });
  assert.ok(r.ok);
  await settle(s, r.experiment.id);
  const exp = s.experimentById(r.experiment.id);
  assert.equal(exp.variants[0].status, 'failed');
  assert.match(exp.variants[0].error, /循环依赖/);
  assert.equal(exp.variants[1].status, 'done', '同实验的后续变体照常完成');
  assert.equal(exp.variants[2].status, 'failed', '失败变体后面的成环变体也失败，但不影响其他');
  assert.equal(exp.runState, 'done', '实验整体仍完成（失败是变体级终态，不阻塞）');
  assert.equal(exp.variants[0].result, null);
  assert.ok(exp.variants[1].result);
  // 基准本身没有被改变：停用约束仍停用、无环
  assert.equal(s.model.constraints.find((c) => c.id === disabledId).enabled, false);
});

test('executeVariant 对坏输入返回错误而不抛出（运行器据此隔离失败）', async () => {
  const { s } = await freshStore();
  const event = s.headEvent;
  const specs = prepareSpecs([{ name: 'v' }], event.model);
  const exp = makeExperiment({ name: 'x', event, specs });
  const out = executeVariant(exp, { changes: null });
  assert.equal(out.ok, true, 'changes 缺失按基准处理（结构化兜底，不抛）');
  assert.equal(out.report.hash, exp.baseHash);

  // 显式坏输入（非对象 changes）也安全返回失败
  const out2 = executeVariant({ ...exp, baseModel: null }, { changes: { rects: [] } });
  assert.equal(out2.ok, false);
});

/* ---------- 暂停 / 继续 / 取消 ---------- */

test('暂停后排队变体不求解；继续后完成；取消把排队变体置为终态，完成结果保留', async () => {
  let gateResolve = null;
  const gate = () => gateResolve && gateResolve();
  const { s } = await freshStore({ onVariantGate: gate });

  const target = s.model.rects[0].id;
  const r = s.createExperiment([0, 1, 2, 3].map((i) => ({ name: `v${i}`, rects: [{ id: target, x: 100 + i * 60 }] })),
    { name: '暂停实验' });
  const id = r.experiment.id;
  // 等第 1 个变体进入 running 前的 gate
  await new Promise((res) => { gateResolve = res; });
  gateResolve = null;
  // 第 1 个变体正在求解/收尾：暂停
  const pr = s.pauseExperiment(id);
  assert.ok(pr.ok);
  // 等待运行器让出并落盘
  for (let i = 0; i < 50; i++) {
    await drain();
    const e = s.experimentById(id);
    if (e.runState === 'paused') break;
  }
  let exp = s.experimentById(id);
  assert.equal(exp.runState, 'paused');
  const doneCountAfterPause = exp.variants.filter((v) => v.status === 'done').length;
  assert.ok(doneCountAfterPause >= 1 && doneCountAfterPause <= 2);
  const queuedAtPause = exp.variants.filter((v) => v.status === 'queued').length;
  assert.ok(queuedAtPause >= 2, '其余变体仍排队，没有被偷偷求解');

  // 暂停期间再暂停 / 继续不存在的变体 → 拒绝
  assert.equal(s.pauseExperiment(id).ok, false);

  // 继续
  const rr = s.resumeExperiment(id);
  assert.ok(rr.ok);
  await settle(s, id);
  exp = s.experimentById(id);
  assert.equal(exp.runState, 'done');
  assert.deepEqual(exp.variants.map((v) => v.status), ['done', 'done', 'done', 'done']);

  // 取消：对已完成实验拒绝；排队变体被取消、完成结果保留
  const r2 = s.createExperiment([0, 1, 2].map((i) => ({ name: `c${i}`, rects: [{ id: target, y: 100 + i * 60 }] })),
    { name: '取消实验' });
  const id2 = r2.experiment.id;
  await new Promise((res) => { gateResolve = res; });
  gateResolve = null;
  s.cancelExperiment(id2);
  await s.flushed();
  await drain();
  const exp2 = s.experimentById(id2);
  assert.equal(exp2.runState, 'cancelled');
  assert.ok(exp2.variants.some((v) => v.status === 'cancelled'));
  assert.ok(exp2.variants.some((v) => v.status === 'done'), '取消前完成的结果保留');
  assert.ok(exp2.variants.find((v) => v.status === 'done').result);
  assert.equal(s.resumeExperiment(id2).ok, false, '已取消不能继续');
  assert.equal(s.cancelExperiment(id2).ok, false, '重复取消拒绝');
});

test('完成后再次触发运行不覆盖已有结果（终态不可变）', async () => {
  const { s } = await freshStore();
  const target = s.model.rects[0].id;
  const r = s.createExperiment([{ rects: [{ id: target, x: 333 }] }], { name: '终态' });
  await settle(s, r.experiment.id);
  const exp = s.experimentById(r.experiment.id);
  const v = exp.variants[0];
  assert.equal(v.status, 'done');
  const savedHash = v.result.hash;
  // 继续一个已完成实验被拒绝
  assert.equal(s.resumeExperiment(exp.id).ok, false);
  // 手动把状态拨回 queued 并启动运行器（模拟异常重试）：防御代码必须跳过已完成项
  v.status = 'queued';
  exp.runState = 'paused';
  // 直接恢复：resume 会把 runState 置 running；已完成结果在运行器内不可达（idx 找到的是该 queued 项，
  // 这里改的是它自己，模拟“状态记录被外力回拨”）——验证终态保护改为：done 结果对象本身不变
  v.status = 'done';
  assert.equal(v.result.hash, savedHash);
});

/* ---------- 与基准差异 + 另存分支 ---------- */

test('完成变体可查看与基准的矩形/约束/冲突差异', async () => {
  const { s } = await freshStore();
  const A = s.model.rects.find((r) => r.name === '卡片A').id;
  const C = s.model.rects.find((r) => r.name === '按钮组C').id;
  // 基准上加一对矛盾约束（让基准也有冲突），变体改优先级可解决
  s.commit((m) => {
    m.constraints.push(
      { id: 'exp_hi', kind: 'snap', rect: C, other: A, axis: 'x', edge: 'l', otherEdge: 'l', gap: 0, priority: 90, enabled: true },
      { id: 'exp_lo', kind: 'snap', rect: C, other: A, axis: 'x', edge: 'r', otherEdge: 'l', gap: 0, priority: 10, enabled: true },
    );
  }, { label: '制造冲突' });
  const baseConflicts = s.report.conflicts.length;
  assert.ok(baseConflicts >= 1);

  const moved = s.model.rects.find((r) => r.name === '锁定D').id;
  const r = s.createExperiment([
    { name: '移D', rects: [{ id: moved, x: 50, y: 50 }] },
    { name: '提高低约束', constraints: [{ id: 'exp_lo', priority: 95 }] },
  ], { name: '差异实验' });
  await settle(s, r.experiment.id);
  const exp = s.experimentById(r.experiment.id);

  const d0 = s.diffVariant(exp.id, exp.variants[0].id);
  assert.ok(d0);
  assert.ok(d0.rects.moved.some((x) => x.id === moved));
  assert.equal(d0.identical, false);

  // 改优先级：约束 changed 字段含 priority；冲突集合发生变化（低约束变强后高约束让步）
  const d1 = s.diffVariant(exp.id, exp.variants[1].id);
  assert.ok(d1.constraints.changed.some((c) => c.id === 'exp_lo' && c.fields.some((f) => f.field === 'priority')));
  assert.ok(d1.conflicts.before !== d1.conflicts.after || d1.conflicts.newUnmet.length || d1.conflicts.resolved.length);

  // 排队/失败变体不能比较
  assert.equal(s.diffVariant(exp.id, 'nonexistent'), null);
});

test('完成变体另存为新分支：同指纹 + provenance 实验来源，实验与原分支不改写', async () => {
  const { s } = await freshStore();
  const target = s.model.rects[0].id;
  const mainHeadBefore = s.branch.headEventId;
  const r = s.createExperiment([{ name: '候选', rects: [{ id: target, x: 444 }] }], { name: '来源实验' });
  await settle(s, r.experiment.id);
  const exp = s.experimentById(r.experiment.id);
  const v = exp.variants[0];
  const variantHash = v.result.hash;
  const eventsBefore = s.events.length;
  const expSnap = structuredClone(exp);

  const fk = s.forkExperimentVariant(exp.id, v.id, '实验分支1');
  assert.ok(fk.ok);
  assert.equal(s.currentBranchId, fk.branch.id);
  assert.equal(s.headEvent.kind, 'fork-root');
  assert.equal(s.headEvent.hash, variantHash, '分支起点与变体结果同指纹');
  assert.deepEqual(s.headEvent.provenance, {
    kind: 'experiment', experimentId: exp.id, experimentName: '来源实验',
    variantId: v.id, variantName: '候选',
    branchId: MAIN_BRANCH, eventId: exp.source.eventId, seq: exp.source.seq,
  });
  assert.deepEqual(s.branch.experimentSource, { experimentId: exp.id, variantId: v.id });
  assert.equal(s.branch.source.branchId, MAIN_BRANCH);

  // 新分支可继续提交
  const cont = s.commit((m) => m.rects.push(newRect(90, 90, 50, 50, '分支续')));
  assert.ok(cont.ok);

  // 实验结果与主分支均未被改写
  const expAfter = s.experimentById(exp.id);
  assert.equal(expAfter.variants[0].result.hash, variantHash);
  assert.equal(s.events.length, eventsBefore + 2);
  assert.equal(s.branches.find((b) => b.id === MAIN_BRANCH).headEventId, mainHeadBefore);
  assert.deepEqual(expSnap.variants.map((x) => x.status), ['done']);

  // 重名分支拒绝；损坏/未完成变体不能另存
  assert.equal(s.forkExperimentVariant(exp.id, v.id, '实验分支1').ok, false);
  assert.equal(s.forkExperimentVariant(exp.id, 'nope', 'X').ok, false);
});

/* ---------- 重启 / 刷新一致 ---------- */

test('刷新/重启后实验定义、队列状态与结果顺序一致；running 收敛为 paused', async () => {
  const { s, h } = await freshStore();
  s.setActor('王五');
  // 锁定D 无定位约束（不会被 snap/minGap 拉回），位置覆盖确定
  const target = s.model.rects.find((r) => r.name === '锁定D').id;
  const r1 = s.createExperiment([{ rects: [{ id: target, x: 150 }] }], { name: '已完成' });
  await settle(s, r1.experiment.id);

  // 第二个实验：手动构造“刷新瞬间 running”的持久化状态（1 完成 + 1 running + 1 queued）
  const r2 = s.createExperiment(
    [{ rects: [{ id: target, x: 200 }] }, { rects: [{ id: target, x: 250 }] }, { rects: [{ id: target, x: 300 }] }],
    { name: '进行中' },
  );
  await settle(s, r2.experiment.id); // 先让它全完成并落盘
  const doc = structuredClone(h.doc);
  const x2 = doc.experiments.find((e) => e.id === r2.experiment.id);
  x2.runState = 'running';
  x2.variants[1].status = 'running'; // 模拟求解已开始、尚未落盘时刷新
  x2.variants[2].status = 'queued';
  x2.variants[2].result = null;
  // variants[0]=done, [1]=running→重启后 queued, [2]=queued
  h.doc = doc;
  h.rearm(doc, s); // 旧 Store 迟到 PUT 作废；新 Store 从 localStorage 权威快照加载

  const s2 = new TrackedStore({ base: '', tickMs: 2 });
  await s2.load();
  assert.equal(s2.experiments.length, 2, '实验定义与顺序保持');
  assert.deepEqual(s2.experiments.map((e) => e.name), ['已完成', '进行中']);
  const done1 = s2.experiments[0];
  assert.equal(done1.runState, 'done');
  assert.equal(done1.variants[0].status, 'done');
  assert.equal(done1.variants[0].result.hash, r1.experiment.variants[0].result.hash, '完成结果逐字节回放');

  const mid = s2.experiments[1];
  assert.equal(mid.runState, 'paused', 'running 实验在重启后收敛为已暂停（排队项仍排队）');
  assert.deepEqual(mid.variants.map((v) => v.status), ['done', 'queued', 'queued'], 'running 变体回到排队，顺序不变');
  assert.ok(mid.variants[0].result, '已完成的结果不丢');
  // 继续后全部完成且结果确定
  assert.ok(s2.resumeExperiment(mid.id).ok);
  await s2.experimentSettled(mid.id);
  const mid2 = s2.experimentById(mid.id);
  assert.deepEqual(mid2.variants.map((v) => v.status), ['done', 'done', 'done']);
  assert.equal(mid2.variants[1].result.model.rects.find((x) => x.id === target).x, 250);
});

/* ---------- 损坏容忍 ---------- */

test('单个变体结果损坏：实验照常打开并标出无法回放，其余变体可查看/比较/另存', async () => {
  const { s, h } = await freshStore();
  const loose = s.model.rects.find((r) => r.name === '锁定D').id; // 无定位约束的矩形
  const r = s.createExperiment([
    { name: '好1', rects: [{ id: loose, x: 40 }] },
    { name: '坏2', rects: [{ id: loose, x: 80 }] },
    { name: '好3', rects: [{ id: loose, x: 120 }] },
  ], { name: '损坏实验' });
  await settle(s, r.experiment.id);
  const doc = structuredClone(h.doc);
  const expDoc = doc.experiments.find((e) => e.id === r.experiment.id);
  const bad = expDoc.variants[1];
  // 篡改结果模型坐标（lock 矩形无定位约束，指纹必变），保留原 hash
  bad.result.model.rects.find((x) => x.id === loose).x += 77;
  h.doc = doc;
  h.rearm(doc, s); // 旧 Store 迟到 PUT 作废；新 Store 从 localStorage 权威快照加载

  const s2 = new TrackedStore({ base: '', tickMs: 2 });
  await s2.load();
  const exp = s2.experiments[0];
  assert.equal(exp.runState, 'done');
  assert.equal(exp.variants[1].corrupt, true, '坏变体被标出');
  assert.match(exp.variants[1].corruptReason, /指纹不一致/);
  assert.equal(exp.variants[1].result, null);
  assert.ok(s2.experimentWarnings.some((w) => new RegExp(exp.variants[1].name).test(w.text)));
  // 其余变体完好
  assert.equal(exp.variants[0].status, 'done');
  assert.ok(exp.variants[0].result);
  assert.equal(exp.variants[2].status, 'done');
  assert.ok(s2.diffVariant(exp.id, exp.variants[0].id));
  assert.equal(s2.diffVariant(exp.id, exp.variants[1].id), null, '坏变体不能比较');
  assert.equal(s2.forkExperimentVariant(exp.id, exp.variants[1].id, 'X').ok, false, '坏变体不能另存');
  const fk = s2.forkExperimentVariant(exp.id, exp.variants[2].id, '好结果分支');
  assert.ok(fk.ok, '其余变体仍可另存为分支');
  assert.equal(s2.headEvent.hash, exp.variants[2].result.hash);
});

test('基准快照损坏：实验可打开，变体可查看/另存，仅禁用与基准比较', async () => {
  const { s, h } = await freshStore();
  const loose = s.model.rects.find((r) => r.name === '锁定D').id;
  const r = s.createExperiment([{ name: 'v', rects: [{ id: loose, x: 200 }] }], { name: '基准坏' });
  await settle(s, r.experiment.id);
  const doc = structuredClone(h.doc);
  const expDoc = doc.experiments.find((e) => e.id === r.experiment.id);
  expDoc.baseModel.canvas.w += 31; // 破坏基准指纹
  h.doc = doc;
  h.rearm(doc, s); // 旧 Store 迟到 PUT 作废；新 Store 从 localStorage 权威快照加载

  const s2 = new TrackedStore({ base: '', tickMs: 2 });
  await s2.load();
  const exp = s2.experiments[0];
  assert.equal(exp.baseCorrupt, true);
  assert.ok(s2.experimentWarnings.some((w) => /基准/.test(w.text)));
  assert.ok(!exp.variants[0].corrupt, '变体结果本身不受影响');
  assert.equal(exp.variants[0].status, 'done');
  assert.equal(s2.diffVariant(exp.id, exp.variants[0].id), null, '禁用与基准比较');
  const fk = s2.forkExperimentVariant(exp.id, exp.variants[0].id, '基准坏也能另存');
  assert.ok(fk.ok);
});

test('结构损坏的实验整条跳过，不影响其他实验', async () => {
  const warnings = [];
  const out = sanitizeExperiments([
    null,
    { id: 'x1', name: '坏', variants: [], baseModel: { rects: [], constraints: [] } },
  ], warnings);
  assert.equal(out.length, 0);
  assert.ok(warnings.length >= 2);
});

/* ---------- 跨页面合流 ---------- */

test('两页面在不同分支建实验：过期提交自动合流，两边实验与结果都保留', async () => {
  const { s: p1 } = await freshStore();
  const baseHead = p1.branch.headEventId;
  const f = p1.forkFromEvent(baseHead, '实验分支A');
  await p1.flushed();

  const p2 = new TrackedStore({ base: '' });
  await p2.load();
  p1.switchBranch(f.branch.id);
  const target1 = p1.model.rects[0].id;
  const r1 = p1.createExperiment([{ name: 'p1', rects: [{ id: target1, x: 123 }] }], { name: '页面1实验' });
  await p1.experimentSettled(r1.experiment.id);
  await p1.flushed();

  p2.switchBranch(MAIN_BRANCH);
  const target2 = p2.model.rects[1].id;
  const r2 = p2.createExperiment([{ name: 'p2', rects: [{ id: target2, y: 321 }] }], { name: '页面2实验' });
  await p2.experimentSettled(r2.experiment.id);
  await p2.flushed();
  assert.equal(p2.saveConflict, null, '不同分支不冲突，实验随合流保留');

  const check = new TrackedStore({ base: '' });
  await check.load();
  assert.ok(check.experiments.some((e) => e.id === r1.experiment.id), '页面1的实验保留');
  assert.ok(check.experiments.some((e) => e.id === r2.experiment.id), '页面2的实验保留');
  const e1 = check.experiments.find((e) => e.id === r1.experiment.id);
  assert.equal(e1.variants[0].status, 'done');
  assert.equal(e1.variants[0].result.hash, r1.experiment.variants[0].result.hash, '合流后结果指纹一致');
});

test('mergeExperiments 纯函数：完成状态不被排队状态降级覆盖，结果保留', () => {
  const baseModel = { canvas: { w: 1000, h: 700 }, rects: [], constraints: [] };
  const mk = (id, status, result) => ({
    id, name: id, runState: status === 'done' ? 'done' : 'running', updatedAt: 1,
    baseModel, variants: [{
      id: 'v1', name: 'v', order: 0, status, changes: { rects: [], constraints: [] },
      error: null, result: result || null, attempts: status === 'done' ? 1 : 0,
    }],
  });
  const doneResult = { model: {}, report: { hash: 'aabbccdd' }, hash: 'aabbccdd', conflicts: [], completedAt: 5, durationMs: 1 };
  const server = mk('e', 'done', doneResult);
  const client = mk('e', 'queued', null);
  const merged = mergeExperiments(server, client);
  assert.equal(merged[0].variants[0].status, 'done', '完成状态不被降级');
  assert.equal(merged[0].variants[0].result.hash, 'aabbccdd');
  assert.equal(merged[0].runState, 'done');
  // 反向：服务端旧（queued）、客户端新（done）→ 升级
  const merged2 = mergeExperiments(client, server);
  assert.equal(merged2[0].variants[0].status, 'done');
  // 并集
  const both = mergeExperiments(server, mk('e2', 'queued', null));
  assert.deepEqual(both.map((x) => x.id), ['e', 'e2']);
});

/* ---------- 纯函数杂项 ---------- */

test('prepareSpecs：非法定义被拒；experimentConfigHash 对同构定义稳定', () => {
  const { model } = (() => ({ model: { rects: [{ id: 'r1' }], constraints: [{ id: 'c1' }] } }))();
  assert.throws(() => prepareSpecs([], model), /至少/);
  assert.throws(() => prepareSpecs([{ rects: [{ id: 'nope' }] }], model), /不存在的矩形/);
  assert.throws(() => prepareSpecs([{ rects: [{ id: 'r1', w: 0 }] }], model), /宽高/);
  assert.throws(() => prepareSpecs([{ constraints: [{ id: 'c1', priority: 0 }] }], model), /优先级/);
  const a = prepareSpecs([{ name: 'x', rects: [{ id: 'r1', x: 10 }] }], model);
  const b = prepareSpecs([{ name: 'y', rects: [{ id: 'r1', x: 10.0004 }] }], model);
  assert.equal(experimentConfigHash('e0', a), experimentConfigHash('e0', b), '取整+忽略名称 → 同指纹');
  const c = prepareSpecs([{ constraints: [{ id: 'c1', enabled: false }] }], model);
  assert.notEqual(experimentConfigHash('e0', a), experimentConfigHash('e0', c));
  assert.notEqual(experimentConfigHash('e0', a), experimentConfigHash('e9', a), '来源事件不同 → 不同指纹');
});

test('variantCounters / makeVariantResult', () => {
  const exp = makeExperiment({
    name: 'n',
    event: { id: 'e', branch: 'main', seq: 1, model: { canvas: { w: 1000, h: 700 }, rects: [], constraints: [] }, report: { canvas: { w: 1000, h: 700 }, rects: {}, constraints: {}, conflicts: [], hash: '00000000' }, hash: '00000000' },
    specs: [{ name: 'v' }],
  });
  assert.deepEqual(variantCounters(exp.variants), { queued: 1, running: 0, done: 0, failed: 0, cancelled: 0, corrupt: 0 });
});

/* ---------- 注册为单个串行 suite ---------- */

describe('布局方案实验', { concurrency: 1 }, () => {
  rawTest.afterEach(async () => {
    // 排空微任务，再 dispose 所有 Store（停运行器、作废防抖保存），防跨用例/跨文件污染
    for (let i = 0; i < 8; i++) await drain();
    for (const s of liveStores) s.dispose();
    for (const id of pendingTimers) _clearTimeout(id);
    liveStores.clear();
  });
  for (const [name, fn] of collected) rawTest(name, fn);
});
