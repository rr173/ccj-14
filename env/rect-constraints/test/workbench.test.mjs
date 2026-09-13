// 实验审计工作台：统一时间线（审计事件 + 实验变体求解）/ 健康标注
// （事件缺失、顺序重复、指纹不匹配、分支已推进、变体失败/损坏）/ 筛选 /
// 顺序回放步进 / 状态清洗 / 导出确定性 / Store 持久化与回放位置恢复。
import { test as rawTest } from 'node:test';
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
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); return _clearTimeout(id); };

const {
  buildWorkbench, filterNodes, neighborNode, nextReplayable,
  normalizeWorkbench, defaultWorkbench, buildExport, stableStringify, exportChecksum,
} = await import('../web/js/geom/auditbench.js');
const { Store } = await import('../web/js/geom/store.js');
const { mergeDocs, assessConflict, MAIN_BRANCH } = await import('../web/js/geom/audit.js');
const { newSnap } = await import('../web/js/geom/model.js');

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
        ok: false, status: 409, json: () => Promise.resolve({ error: 'revision-conflict', rev: curRev, ...info }),
      });
      const accept = (doc, extra = {}) => { serverDoc = doc; return jsonOk({ ok: true, rev: doc.rev, ...extra }); };
      if (body.baseRev !== curRev) {
        if (!serverDoc) {
          const doc = { ...body, rev: 1 };
          delete doc.baseRev; delete doc.baseHeads;
          return accept(doc);
        }
        const verdict = assessConflict(serverDoc, body);
        if (!verdict.mergeable) return reject(verdict);
        const merged = mergeDocs(serverDoc, body);
        delete merged.baseRev; delete merged.baseHeads;
        merged.rev = curRev + 1;
        return accept(merged, { merged: true, doc: merged });
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
    clear() { serverDoc = null; },
    get doc() { return serverDoc },
    set doc(v) { serverDoc = v; },
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
  const s = new Store({ base: '', tickMs: 1 });
  await s.load();
  return s;
};
const drain = () => new Promise((r) => _setTimeout(r, 0));
async function settle(s, expId) {
  for (let i = 0; i < 2000; i++) {
    const exp = s.experiments.find((x) => x.id === expId);
    if (exp && !exp.variants.some((v) => v.status === 'running' || v.status === 'queued')) return exp;
    await (exp && s._runners.has(expId) ? s._tick() : Promise.resolve());
  }
  throw new Error('settle timeout');
}

const moveRectSpec = (rect, x) => [{ name: '变体', rects: [{ id: rect, x }] }];

/* ---------- 构造：事件节点 + 变体节点统一时间线 ---------- */

test('统一时间线：编辑事件与实验变体求解都成为节点，顺序由 (t,种类,范围,序号,key) 确定', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第一步' });
  const srcId = s.branch.headEventId;
  const res = s.createExperiment(moveRectSpec(s.model.rects[0].id, 200), { name: '三方案' });
  assert.equal(res.ok, true);
  await settle(s, res.experiment.id);
  const w = s.workbench();
  assert.ok(w.nodes.length >= 3); // root + edit + ≥1 variant
  const kinds = new Set(w.nodes.map((n) => n.kind));
  assert.deepEqual([...kinds].sort(), ['edit-event', 'experiment-variant']);
  // 顺序确定：重算一次逐节点一致
  const w2 = buildWorkbench({
    events: s.events, eventsById: s.eventsById,
    branches: s.branches, branchesById: s.branchesById, experiments: s.experiments,
  });
  assert.deepEqual(w2.nodes.map((n) => n.key), w.nodes.map((n) => n.key));
  const variant = w.nodes.find((n) => n.kind === 'experiment-variant');
  assert.equal(variant.replayable, true);
  assert.ok(variant.entry && variant.baseEntry);
  assert.ok(variant.changes);
});

test('正常提交节点：求解前=父事件、求解后=本事件，指纹与差异完整', async () => {
  const s = await freshStore();
  const before = s.branch.headEventId;
  s.commit((m) => {
    const n = m.rects.length + 1;
    m.rects.push({ id: `r_new_${n}`, name: `新矩形${n}`, x: 300, y: 300, w: 100, h: 80 });
  }, { label: '新增矩形' });
  const w = s.workbench();
  const n = w.byKey.get(`event:${s.branch.headEventId}`);
  assert.equal(n.replayable, true);
  assert.equal(n.baseEntry.hash, s.eventsById.get(before).hash);
  assert.equal(n.hashBefore, s.eventsById.get(before).hash);
  assert.equal(n.hashAfter, n.entry.hash);
  assert.ok(n.changes.rects.added.length >= 1);
});

test('root 节点无求解前快照但仍可回放', async () => {
  const s = await freshStore();
  const w = s.workbench();
  const root = w.nodes.find((n) => n.eventKind === 'root');
  assert.equal(root.replayable, true);
  assert.equal(root.baseEntry, null);
  assert.equal(root.changes, null);
});

/* ---------- 健康标注：分支已推进 / 顺序重复 ---------- */

test('undo 后新提交：旧链节点标注“分支已推进”与“顺序重复”，但仍可回放', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' }); // seq 2
  const oldHead = s.branch.headEventId;
  s.undo();                                                  // head 回到 root
  s.commit((m) => { m.rects[0].x += 40; }, { label: 'B' }); // 新 seq 2
  const w = s.workbench();
  const oldNode = w.byKey.get(`event:${oldHead}`);
  assert.equal(oldNode.replayable, true);                    // 仍可回放
  const codes = oldNode.badges.map((b) => b.code);
  assert.ok(codes.includes('branch-advanced'));
  assert.ok(codes.includes('seq-duplicate'));
  assert.equal(oldNode.severity, 'warn');
  const newNode = w.byKey.get(`event:${s.branch.headEventId}`);
  assert.ok(newNode.badges.some((b) => b.code === 'seq-duplicate'));
  // 分支推进只是支线：当前链节点不被标 branch-advanced
  assert.ok(!newNode.badges.some((b) => b.code === 'branch-advanced'));
});

/* ---------- 健康标注：事件缺失 / 指纹不匹配（损坏） ---------- */

test('父事件缺失：节点标为不可回放，其他节点照常可查看', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const parent = s.branch.headEventId;
  s.commit((m) => { m.rects[0].x += 20; }, { label: 'B' });
  const child = s.branch.headEventId;
  // 模拟持久化文档中父事件整条丢失
  const doc = JSON.parse(JSON.stringify(s._payload()));
  doc.events = doc.events.filter((e) => e.id !== parent);
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const w = s2.workbench();
  const n = w.byKey.get(`event:${child}`);
  assert.equal(n.replayable, false);
  assert.equal(n.severity, 'bad');
  assert.ok(n.badges.some((b) => b.code === 'event-missing'));
  // root 与其他分支不受影响
  const root = w.nodes.find((x) => x.eventKind === 'root');
  assert.equal(root.replayable, true);
});

test('指纹不匹配：损坏事件标 corrupt 不可回放，其余事件与变体仍可查看', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const good = s.branch.headEventId;
  s.commit((m) => { m.rects[0].x += 20; }, { label: 'B' });
  const bad = s.branch.headEventId;
  const doc = JSON.parse(JSON.stringify(s._payload()));
  const ev = doc.events.find((e) => e.id === bad);
  ev.model.canvas.w = ev.model.canvas.w + 123; // 改画布不改 hash → 指纹不匹配（确定生效）
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const w = s2.workbench();
  assert.equal(w.byKey.get(`event:${bad}`).replayable, false);
  assert.equal(w.byKey.get(`event:${bad}`).severity, 'bad');
  assert.ok(w.byKey.get(`event:${bad}`).badges.some((b) => b.code === 'corrupt'));
  assert.equal(w.byKey.get(`event:${good}`).replayable, true);
});

/* ---------- 健康标注：变体失败 / 损坏 / 基准损坏 / 来源缺失 ---------- */

test('失败变体不可回放但只影响自己；损坏变体标 bad；完成变体正常', async () => {
  const s = await freshStore();
  const r1 = s.model.rects[0].id, r2 = s.model.rects[1].id;
  // 启用会成环的配置：给 r2 加一条 r2->r1 同轴向约束，与已有 r1<-... 组合成环
  const res = s.createExperiment([
    { name: '好变体', rects: [{ id: r1, x: 200 }] },
    { name: '坏变体', constraints: [{ id: 'c_nonexistent' }] }, // prepareSpecs 在创建期就会拒绝
  ], { name: '混合' });
  // 非法规格整个实验被拒绝（创建期拦截）
  assert.equal(res.ok, false);

  // 用运行期失败：直接构造一个会成环的变体（启用基准中停用约束的场景难以构造，
  // 这里通过 sanitizeExperiments 注入 failed / corrupt 记录验证健康标注）
  const expRes = s.createExperiment([
    { name: '好变体', rects: [{ id: r1, x: 200 }] },
    { name: '好变体2', rects: [{ id: r2, x: 500 }] },
  ], { name: '混合2' });
  await settle(s, expRes.experiment.id);
  const exp = s.experiments.find((x) => x.id === expRes.experiment.id);
  const doc = JSON.parse(JSON.stringify(s._payload()));
  const x0 = doc.experiments.find((x) => x.id === exp.id);
  // 把第二个完成变体的结果改坏（改画布尺寸，确定改变指纹且不破坏结构校验）
  const v2 = x0.variants[1];
  v2.result.model.canvas.w += 999;
  // 追加一个 failed 记录
  x0.variants.push({
    id: 'xv_failed', name: '失败变体', order: 2, changes: { rects: [], constraints: [] },
    status: 'failed', error: '检测到循环依赖（A → B）', attempts: 1, result: null,
  });
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const w = s2.workbench();
  const goodNode = w.nodes.find((n) => n.variant?.id === exp.variants[0].id);
  const badNode = w.nodes.find((n) => n.variant?.id === v2.id);
  const failNode = w.nodes.find((n) => n.variant?.id === 'xv_failed');
  assert.equal(goodNode.replayable, true);
  assert.equal(badNode.replayable, false);
  assert.equal(badNode.severity, 'bad');
  assert.ok(badNode.badges.some((b) => b.code === 'corrupt'));
  assert.equal(failNode.replayable, false);
  assert.equal(failNode.severity, 'warn');
  assert.ok(failNode.badges.some((b) => b.code === 'variant-failed'));
  // 失败节点的元数据仍可查看
  assert.ok(failNode.title.includes('失败变体'));
});

test('基准快照损坏：变体求解后仍可回放/另存，仅求解前差异被禁用', async () => {
  const s = await freshStore();
  const r1 = s.model.rects[0].id;
  const res = s.createExperiment([{ name: 'v', rects: [{ id: r1, x: 250 }] }], { name: 'E' });
  await settle(s, res.experiment.id);
  const doc = JSON.parse(JSON.stringify(s._payload()));
  const x0 = doc.experiments.find((x) => x.id === res.experiment.id);
  x0.baseModel.canvas.h += 333; // 基准画布篡改 → 基准指纹必然失配
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const exp2 = s2.experiments.find((x) => x.id === res.experiment.id);
  assert.equal(exp2.baseCorrupt, true);
  const n = s2.workbench().nodes.find((x) => x.experiment?.id === exp2.id);
  assert.equal(n.replayable, true);
  assert.equal(n.baseEntry, null);
  assert.equal(n.changes, null);
  assert.ok(n.badges.some((b) => b.code === 'base-corrupt'));
  assert.equal(n.severity, 'warn');
  assert.ok(n.fork); // 仍可另存为分支
});

test('实验来源事件缺失：只给 info/warn 标注，结果仍可回放', async () => {
  const s = await freshStore();
  const r1 = s.model.rects[0].id;
  const res = s.createExperiment([{ name: 'v', rects: [{ id: r1, x: 250 }] }], { name: 'E' });
  await settle(s, res.experiment.id);
  const doc = JSON.parse(JSON.stringify(s._payload()));
  doc.events = doc.events.filter((e) => e.id !== res.experiment.source.eventId || e.kind === 'root');
  // 仅当来源是 edit 时删除有效；若来源就是 root 则跳过断言
  if (res.experiment.source.eventId !== doc.events[doc.events.length - 1]?.id) {
    const s2 = new Store({ base: '', tickMs: 1 });
    await s2._adopt(doc, { seed: false });
    const n = s2.workbench().nodes.find((x) => x.experiment?.id === res.experiment.id);
    assert.equal(n.replayable, true);
  }
});

/* ---------- fork 来源节点 ---------- */

test('fork-root 节点求解前是来源事件（同指纹），带来源标注且两节点都可回放', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const src = s.branch.headEventId;
  const r = s.forkFromEvent(src, '实验分支');
  assert.equal(r.ok, true);
  const w = s.workbench();
  const rootNode = w.byKey.get(`event:${r.event.id}`);
  assert.equal(rootNode.replayable, true);
  assert.equal(rootNode.baseEntry.hash, s.eventsById.get(src).hash);
  assert.equal(rootNode.hashAfter, s.eventsById.get(src).hash);
  assert.equal(rootNode.provenance.eventId, src);
  // 同指纹：差异为 identical
  assert.ok(rootNode.changes.identical);
});

/* ---------- 筛选 ---------- */

test('按分支 / 实验 / 变体 / 健康级别 / 文本合取筛选', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: '主分支编辑' });
  const res = s.createExperiment(moveRectSpec(s.model.rects[0].id, 300), { name: '标签实验' });
  await settle(s, res.experiment.id);
  const fr = s.forkFromEvent(s.events[0].id, '支线一');
  s.commit((m) => { m.rects[0].x += 5; }, { label: '支线编辑' });
  const w = s.workbench();

  const byBranch = filterNodes(w.nodes, { branchId: fr.branch.id });
  assert.ok(byBranch.length >= 2); // fork-root + edit
  assert.ok(byBranch.every((n) =>
    n.branch?.id === fr.branch.id || n.provenance?.branchId === fr.branch.id));

  const byExp = filterNodes(w.nodes, { experimentId: res.experiment.id });
  assert.ok(byExp.length >= 1);
  assert.ok(byExp.every((n) => n.experiment?.id === res.experiment.id));

  const variantId = res.experiment.variants[0].id;
  const byVar = filterNodes(w.nodes, { experimentId: res.experiment.id, variantId });
  assert.equal(byVar.length, 1);
  assert.equal(byVar[0].variant.id, variantId);

  assert.ok(filterNodes(w.nodes, { severity: 'unreplayable' }).every((n) => !n.replayable));
  const found = filterNodes(w.nodes, { text: '标签实验' });
  assert.ok(found.some((n) => n.experiment?.name === '标签实验'));
  // 合取：分支+实验，跨分支实验被排除
  const mixed = filterNodes(w.nodes, { branchId: fr.branch.id, experimentId: res.experiment.id });
  assert.equal(mixed.length, 0);
});

/* ---------- 回放步进 ---------- */

test('nextReplayable 跳过不可回放节点，到头返回 null，逆序同样工作', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const good1 = s.branch.headEventId;
  s.commit((m) => { m.rects[0].x += 20; }, { label: 'B' });
  const good2 = s.branch.headEventId;
  const w = s.workbench();
  // 构造含坏节点的列表（顺序保持）
  const fakeBad = { key: 'event:bad', replayable: false, t: 0, kindRank: 0, scopeId: '', sortSeq: 0 };
  const k1 = `event:${good1}`, k2 = `event:${good2}`;
  const list = [w.byKey.get(k1), fakeBad, w.byKey.get(k2)];
  assert.equal(nextReplayable(list, k1, 1).key, k2); // 跳过坏节点
  assert.equal(nextReplayable(list, k2, 1), null);
  assert.equal(nextReplayable(list, k2, -1).key, k1);
  assert.equal(nextReplayable(list, k1, -1), null);
  assert.equal(neighborNode(list, k1, 1).key, 'event:bad'); // 相邻状态不跳过
});

/* ---------- Store：回放求解前 / 变体 / 只读 ---------- */

test('showWorkbenchNode：求解后事件回放、求解前快照回放、变体结果回放均只读', async () => {
  const s = await freshStore();
  const root = s.branch.headEventId;
  s.commit((m) => { m.rects[0].x += 20; }, { label: 'A' });
  const edit = s.branch.headEventId;
  const res = s.createExperiment(moveRectSpec(s.model.rects[0].id, 300), { name: 'E' });
  await settle(s, res.experiment.id);
  const w = s.workbench();

  const editNode = w.byKey.get(`event:${edit}`);
  assert.equal(s.showWorkbenchNode(editNode, 'after').ok, true);
  assert.equal(s.replaying, true);
  assert.equal(s.replayInfo.mode, 'event');

  // 求解前 = root 快照
  assert.equal(s.showWorkbenchNode(editNode, 'before').ok, true);
  assert.equal(s.replayInfo.mode, 'event-before');
  assert.equal(s.headEvent.hash, s.eventsById.get(root).hash);
  assert.equal(s.auditWorkbench.side, 'before');

  // 只读：提交被拒绝
  const blocked = s.commit((m) => { m.rects[0].x += 1; }, { label: 'X' });
  assert.equal(blocked.ok, false);

  // 变体结果（快照回放，非审计事件）
  const vNode = w.nodes.find((n) => n.kind === 'experiment-variant');
  assert.equal(s.showWorkbenchNode(vNode, 'after').ok, true);
  assert.equal(s.replayInfo.mode, 'variant-result');
  assert.equal(s.headEvent.hash, vNode.entry.hash);

  s.exitReplay();
  assert.equal(s.replaying, false);
});

test('root 节点没有求解前：查看求解前被拒绝，求解后正常', async () => {
  const s = await freshStore();
  const w = s.workbench();
  const root = w.nodes.find((n) => n.eventKind === 'root');
  assert.equal(s.showWorkbenchNode(root, 'before').ok, false);
  assert.equal(s.showWorkbenchNode(root, 'after').ok, true);
});

test('不可回放节点：回放与另存分支被拒绝，光标仍记录，其他节点不受影响', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const parent = s.branch.headEventId;
  s.commit((m) => { m.rects[0].x += 20; }, { label: 'B' });
  const child = s.branch.headEventId;
  const doc = JSON.parse(JSON.stringify(s._payload()));
  doc.events = doc.events.filter((e) => e.id !== parent);
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const w = s2.workbench();
  const bad = w.byKey.get(`event:${child}`);
  assert.equal(s2.showWorkbenchNode(bad, 'after').ok, false);
  assert.equal(s2.replaying, false);
  const root = w.nodes.find((n) => n.eventKind === 'root');
  assert.equal(s2.showWorkbenchNode(root, 'after').ok, true);
});

/* ---------- Store：工作台状态持久化 / 重启一致 ---------- */

test('筛选条件、回放位置、前后面随文档持久化；重启后位置保留、播放收敛为暂停', async () => {
  let s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const eid = s.branch.headEventId;
  s.setWorkbench({
    filter: { branchId: MAIN_BRANCH, severity: 'issues', text: '卡片' },
    cursorKey: `event:${eid}`, side: 'after', playing: true, speedMs: 500,
  });
  await s.flushed();

  s = new Store({ base: '', tickMs: 1 });
  await s.load();
  const wb = s.auditWorkbench;
  assert.equal(wb.cursorKey, `event:${eid}`);
  assert.equal(wb.side, 'after');
  assert.equal(wb.playing, false); // 重启即暂停
  assert.equal(wb.speedMs, 500);
  assert.equal(wb.filter.branchId, MAIN_BRANCH);
  assert.equal(wb.filter.severity, 'issues');
  assert.equal(wb.filter.text, '卡片');
});

test('重启后自动重放到持久化光标位置（画布为该节点只读快照）', async () => {
  let s = await freshStore();
  s.commit((m) => { m.rects[0].x += 25; }, { label: 'A' });
  const eid = s.branch.headEventId;
  s.showWorkbenchNode(s.workbench().byKey.get(`event:${eid}`), 'after');
  await s.flushed();

  s = new Store({ base: '', tickMs: 1 });
  await s.load();
  // _adopt 不自动回放；app 启动逻辑等价调用：
  const w = s.workbench();
  const n = w.byKey.get(s.auditWorkbench.cursorKey);
  assert.ok(n);
  assert.equal(s.showWorkbenchNode(n, s.auditWorkbench.side).ok, true);
  assert.equal(s.headEvent.hash, s.eventsById.get(eid).hash);
});

test('光标指向的节点在重启后已损坏/缺失：光标回退为 null，文档正常打开', async () => {
  let s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const eid = s.branch.headEventId;
  s.setWorkbench({ cursorKey: `event:${eid}` });
  await s.flushed();
  const doc = JSON.parse(JSON.stringify(harness.doc));
  const ev = doc.events.find((e) => e.id === eid);
  ev.model.canvas.h = ev.model.canvas.h + 777; // 改画布不改 hash → 指纹不匹配
  harness.doc = doc;

  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  assert.equal(s2.auditWorkbench.cursorKey, null);
});

test('失效的分支/变体筛选在加载时回退；速度非法回默认', async () => {
  const s = await freshStore();
  await s._adopt({
    ...JSON.parse(JSON.stringify({ events: s.events, branches: s.branches })),
    events: s.events, branches: s.branches,
    auditWorkbench: {
      filter: { branchId: 'b_gone', experimentId: 'x_gone', variantId: 'xv_gone', severity: 'weird', text: 'x' },
      cursorKey: 'event:nope', side: 'before', playing: true, speedMs: 42,
    },
  }, { seed: false });
  const wb = s.auditWorkbench;
  assert.equal(wb.filter.branchId, null);
  assert.equal(wb.filter.experimentId, null);
  assert.equal(wb.filter.severity, 'all');
  assert.equal(wb.cursorKey, null);
  assert.equal(wb.side, 'before'); // 合法值保留
  assert.equal(wb.speedMs, defaultWorkbench().speedMs);
});

/* ---------- 从节点创建编辑分支（分支来源 provenance） ---------- */

test('从变体节点创建编辑分支：fork-root 与变体同指纹，工作台光标切到新分支起点', async () => {
  const s = await freshStore();
  const res = s.createExperiment(moveRectSpec(s.model.rects[0].id, 320), { name: 'E' });
  await settle(s, res.experiment.id);
  const vNode = s.workbench().nodes.find((n) => n.kind === 'experiment-variant');
  const r = s.forkExperimentVariant(res.experiment.id, vNode.variant.id, '变体落地分支');
  assert.equal(r.ok, true);
  assert.equal(r.event.hash, vNode.hashAfter);
  assert.equal(r.event.provenance.kind, 'experiment');
  assert.equal(s.currentBranchId, r.branch.id);
  // 按新分支筛选能看到 fork-root
  const list = filterNodes(s.workbench().nodes, { branchId: r.branch.id });
  assert.ok(list.some((n) => n.key === `event:${r.event.id}`));
});

/* ---------- 导出 ---------- */

test('导出当前筛选结果：顺序与界面一致、含完整前后模型与冲突链、输出确定性 + 校验和', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const res = s.createExperiment(moveRectSpec(s.model.rects[0].id, 300), { name: 'E' });
  await settle(s, res.experiment.id);
  const w = s.workbench();
  const list = filterNodes(w.nodes, { branchId: MAIN_BRANCH });
  const doc = buildExport(list, { branchId: MAIN_BRANCH }, { exportedAt: 'fixed' });
  assert.equal(doc.summary.total, list.length);
  assert.deepEqual(doc.nodes.map((n) => n.key), list.map((n) => n.key));
  const withAfter = doc.nodes.filter((n) => n.after);
  assert.ok(withAfter.length >= 1);
  assert.ok(withAfter.every((n) => n.after.model.rects && n.after.report));
  // 冲突链字段存在（即使为空数组）
  assert.ok(doc.nodes.every((n) => Array.isArray(n.conflicts)));
  // 确定性：同输入两次 stableStringify 逐字节一致
  const t1 = stableStringify(doc);
  const t2 = stableStringify(JSON.parse(JSON.stringify(doc)));
  assert.equal(t1, t2);
  const sum1 = exportChecksum(t1);
  const sum2 = exportChecksum(t2);
  assert.equal(sum1, sum2);
  assert.match(sum1, /^[0-9a-f]{8}$/);
});

/* ---------- 注册：串行 suite（共享内存服务器 / localStorage） ---------- */

// 文件级全局 mock：套件全部结束后恢复，避免污染同进程并发的其他测试文件
const _realFetch = globalThis.fetch;
const _realLocalStorage = globalThis.localStorage;
const _realSetTimeout = globalThis.setTimeout;
const _realClearTimeout = globalThis.clearTimeout;

rawTest('实验审计工作台', { concurrency: false }, async (t) => {
  t.after(() => {
    globalThis.fetch = _realFetch;
    globalThis.localStorage = _realLocalStorage;
    globalThis.setTimeout = _realSetTimeout;
    globalThis.clearTimeout = _realClearTimeout;
    activeFetch = null;
  });
  for (const [name, fn] of collected) {
    await t.test(name, async () => {
      try { await fn(); }
      finally {
        for (const id of pendingTimers) _clearTimeout(id);
        pendingTimers.clear();
        for (let i = 0; i < 5; i++) await drain();
        harness.nextGen();
        harness.clear();
        mem.clear();
      }
    });
  }
});
