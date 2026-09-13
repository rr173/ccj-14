// 布局审计与分支：事件不可变 / 回放 / fork 来源关系 / 时间线 / 损坏检测 /
// 跨分支合流 / 分支头并发判定（纯函数 + Store，内存模拟服务器）。
// 全部用例收集后在文件末尾注册进一个串行 suite（concurrency:1），
// 避免共享内存服务器 / localStorage 的用例并发互扰。
import { describe, test as rawTest, afterEach } from 'node:test';
const collected = [];
const test = (name, fn) => collected.push([name, fn]);
import assert from 'node:assert/strict';

// 防抖定时器跨测试清理
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

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

// 单进程内存服务器，与 server.py 同构。代际（gen）隔离跨测试的迟到请求：
// afterEach 先排空所有微任务链，再 gen++，此后旧 Store 迟到的任何请求都 no-op。
let activeFetch = null;
globalThis.fetch = (url, opts) => activeFetch(url, opts);

const {
  makeRootEvent, makeEvent, makeForkRootEvent, sanitizeAudit, migrateLegacy,
  timelineFor, mergeDocs, assessConflict, MAIN_BRANCH,
} = await import('../web/js/geom/audit.js');
const { Store } = await import('../web/js/geom/store.js');
const { seedModel, newRect, normalize } = await import('../web/js/geom/model.js');
const { solve } = await import('../web/js/geom/solver.js');

function makeHarness() {
  let serverDoc = null;
  let gen = 0;
  const fetchImpl = (url, opts = {}) => {
    const myGen = gen; // 调用时代即“请求发起代”；排空后 gen 已推进，迟到请求必不匹配
    const method = opts.method || 'GET';
    const jsonOk = (obj) => ({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(obj)) });
    if (method === 'GET') {
      if (myGen !== gen || !serverDoc) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(jsonOk(serverDoc));
    }
    if (method === 'PUT') {
      if (myGen !== gen) return Promise.resolve(reject({ reason: 'stale-generation' }));
      const body = JSON.parse(opts.body);
      const curRev = serverDoc?.rev ?? 0;
      const reject = (info) => Promise.resolve({
        ok: false, status: 409,
        json: () => Promise.resolve({ error: 'revision-conflict', rev: curRev, ...info }),
      });
      const accept = (doc, extra = {}) => { serverDoc = doc; return jsonOk({ ok: true, rev: doc.rev, ...extra }); };
      if (body.baseRev !== curRev) {
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
    clear() { serverDoc = null; },
    get doc() { return serverDoc; },
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
  harness.nextGen(); // 每个用例独立一代：上一用例任何迟到请求一律 409/no-op
  const s = new Store({ base: '' });
  await s.load();
  return { s, h: harness };
};

// 先多轮排空微任务（Store fire-and-forget 的 load/冲突回调链走完），
// 再推进代际并清空，保证上一个测试的迟到请求绝不接触新测试状态。
const drain = () => new Promise((r) => _setTimeout(r, 0));
const afterEachFn = async () => {
  for (const id of pendingTimers) _clearTimeout(id);
  pendingTimers.clear();
  for (let i = 0; i < 6; i++) await drain();
  harness.nextGen();
  harness.clear();
  mem.clear();
};

/* ---------- 事件不可变 + 提交元数据 ---------- */

test('每次提交追加不可变审计事件：操作者/时间/前后指纹/变更/冲突', async () => {
  const { s } = await freshStore();
  s.setActor('张三');
  const root = s.headEvent;
  assert.equal(root.actor, '系统', '种子事件是系统操作者');
  assert.equal(root.hashBefore, null);
  assert.equal(root.kind, 'root');

  const before = root.hash;
  const res = s.commit((m) => m.rects.push(newRect(300, 300, 100, 60, '审计矩形')), { label: '加矩形' });
  assert.ok(res.ok);
  const ev = s.headEvent;
  assert.equal(ev.actor, '张三');
  assert.equal(ev.label, '加矩形');
  assert.ok(ev.t >= root.t);
  assert.equal(ev.hashBefore, before, '记录提交前指纹');
  assert.equal(ev.hash, res.report.hash, '记录提交后指纹');
  assert.notEqual(ev.hash, before);
  assert.ok(ev.changes, '记录结构化变更');
  assert.deepEqual(ev.changes.rects.added.map((x) => x.name), ['审计矩形']);
  assert.ok(Array.isArray(ev.conflicts), '记录当时冲突结果');

  // 不可修改：冻结
  assert.throws(() => { ev.label = 'x'; }, TypeError);
  assert.throws(() => { ev.model.rects.push(1); }, TypeError);
  assert.equal(s.events.filter((e) => e.label === '加矩形').length, 1);

  // 下一条提交的父指纹 = 上一条后指纹（链）
  s.commit(() => {}, { label: '空提交' });
  assert.equal(s.headEvent.parentId, ev.id);
  assert.equal(s.headEvent.hashBefore, ev.hash);
  await s.flushed();
});

test('冲突结果记入事件；同模型事件回放 report 逐字节一致', async () => {
  const { s } = await freshStore();
  // 按名称取矩形（rects 按随机 id 排序，索引 [0]/[2] 在不同运行指向不同矩形会让冲突数抖动）
  const A = s.model.rects.find((r) => r.name === '卡片A').id;
  const C = s.model.rects.find((r) => r.name === '按钮组C').id;
  s.commit((m) => {
    m.constraints.push(
      { id: 'cx1', kind: 'snap', rect: C, other: A, axis: 'x', edge: 'l', otherEdge: 'l', gap: 0, priority: 95, enabled: true },
      { id: 'cx2', kind: 'snap', rect: C, other: A, axis: 'x', edge: 'r', otherEdge: 'l', gap: 0, priority: 5, enabled: true },
    );
  }, { label: '制造冲突' });
  const ev = s.headEvent;
  assert.ok(ev.conflicts.length >= 1, '冲突写入事件');
  assert.deepEqual(ev.conflicts, ev.report.conflicts);

  // 回放：从事件直接取快照，与重算一致
  const replay = s.replay(ev.id);
  assert.ok(replay.ok);
  assert.equal(s.report.hash, ev.hash);
  assert.equal(JSON.stringify(s.report.conflicts), JSON.stringify(ev.conflicts));
  s.exitReplay();
  assert.equal(s.headEvent.id, s.branch.headEventId);
});

/* ---------- undo/redo 在事件链上行走，事件不删除 ---------- */

test('undo/redo 沿事件链移动 head；undo 后新提交保留旧支线', async () => {
  const { s } = await freshStore();
  const e0 = s.headEvent;
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, 'v1')), { label: 'a' });
  const e1 = s.headEvent;
  s.commit((m) => m.rects.push(newRect(20, 20, 40, 40, 'v2')), { label: 'b' });
  const e2 = s.headEvent;

  s.undo();
  assert.equal(s.headEvent.id, e1.id);
  s.undo();
  assert.equal(s.headEvent.id, e0.id);
  assert.ok(!s.canUndo, 'root 不能再 undo');
  s.redo();
  assert.equal(s.headEvent.id, e1.id);
  s.redo();
  assert.equal(s.headEvent.id, e2.id);

  // undo 一次再提交：e2 成为支线，但事件仍在审计流里
  s.undo();
  assert.equal(s.headEvent.id, e1.id);
  s.commit((m) => m.rects.push(newRect(30, 30, 40, 40, 'v2-alt')), { label: 'b2' });
  const e2b = s.headEvent;
  assert.notEqual(e2b.id, e2.id);
  assert.ok(s.eventsById.has(e2.id), '被取代的支线事件未删除');
  const tl = s.timeline();
  assert.deepEqual(tl.detached.map((r) => r.ev.id), [e2.id], '支线出现在 detached 区');
  assert.ok(tl.chain.every((r) => r.ev.id !== e2.id));
});

/* ---------- 回放只读 ---------- */

test('回放模式拒绝一切写操作（历史不可改写）', async () => {
  const { s } = await freshStore();
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, 'x')), { label: 'a' });
  const ev = s.branch.headEventId;
  s.replay(s.events[0].id);
  assert.equal(s.replaying, true);
  const blocked = s.commit((m) => m.rects.push(newRect(1, 1, 1, 1, 'y')), { label: '非法' });
  assert.equal(blocked.ok, false);
  assert.equal(s.headEvent.id, s.events[0].id);
  assert.equal(s.events.length, 2, '没有追加事件');
  assert.equal(s.previewDrag({}, []).hash, s.events[0].report.hash, '拖动预览也不改写');
  s.exitReplay();
  assert.equal(s.branch.headEventId, ev, '退出回到分支 head');
});

/* ---------- fork：来源关系 + 不改写原分支 ---------- */

test('从历史事件另存为新分支：provenance 保留，原事件/原分支不改写', async () => {
  const { s } = await freshStore();
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, '第一')), { label: 'a' });
  const e1 = s.headEvent;
  s.commit((m) => m.rects.push(newRect(20, 20, 40, 40, '第二')), { label: 'b' });
  const e2 = s.headEvent;
  const mainName = s.branch.name;

  // 回放 e1 并 fork
  s.replay(e1.id);
  const res = s.forkFromEvent(e1.id, '实验分支');
  assert.equal(res.ok, true);
  assert.equal(s.currentBranchId, res.branch.id);
  const root = s.headEvent;
  assert.equal(root.kind, 'fork-root');
  assert.equal(root.hash, e1.hash, 'fork 起点与来源同指纹');
  assert.deepEqual(root.provenance, { branchId: 'main', eventId: e1.id, seq: e1.seq });
  assert.equal(s.branch.source.branchId, 'main');
  assert.equal(s.branch.source.eventId, e1.id);

  // 原分支原事件未被改写
  const main = s.branches.find((b) => b.id === MAIN_BRANCH);
  assert.equal(main.headEventId, e2.id);
  assert.equal(s.eventsById.get(e1.id).hash, e1.hash);

  // 时间线带来源前缀
  const tl = s.timeline();
  assert.equal(tl.sourcePrefix.length, 2, '来源链 root+e1 作为只读前缀');
  assert.ok(tl.sourcePrefix.every((r) => r.foreign));

  // 新分支继续提交：事件挂在新分支上，main 不受影响
  s.commit((m) => m.rects.push(newRect(50, 50, 30, 30, '分支矩形')), { label: '分支编辑' });
  assert.equal(s.headEvent.branch, res.branch.id);
  assert.equal(s.branches.find((b) => b.id === MAIN_BRANCH).headEventId, e2.id);

  // 重名分支拒绝
  assert.equal(s.forkFromEvent(e1.id, '实验分支').ok, false);
  await s.flushed();
});

test('分支比较输出矩形/约束/冲突差异', async () => {
  const { s } = await freshStore();
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, '主干')), { label: 'main-a' });
  const e = s.headEvent;
  s.forkFromEvent(e.id, '对比分支');
  const fb = s.currentBranchId;
  s.commit((m) => m.rects.push(newRect(20, 20, 40, 40, '分支新增')), { label: 'fb-a' });
  const d = s.compareBranches(MAIN_BRANCH, fb);
  assert.deepEqual(d.rects.added.map((x) => x.name), ['分支新增']);
  assert.equal(d.identical, false);
  assert.equal(s.compareBranches(MAIN_BRANCH, MAIN_BRANCH).identical, true);
});

/* ---------- 损坏检测：当前布局可打开，明确指出不可回放事件 ---------- */

test('审计记录损坏：布局仍可打开，并明确标出无法回放的事件', async () => {
  const { s, h } = await freshStore();
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, '好的1')), { label: '好事件1' });
  s.commit((m) => m.rects.push(newRect(20, 20, 40, 40, '好的2')), { label: '好事件2' });
  await s.flushed();
  const doc = structuredClone(h.doc);

  // 篡改最新事件的快照（保留 hash，制造指纹不一致）。
  // 必须改不受约束拉回的新增矩形：受约束矩形会被求解器拉回原不动点，
  // 指纹恰好不变（那正是确定性求解的正确行为）。
  const head = doc.events.find((e) => e.id === doc.branches[0].headEventId);
  head.model.rects.find((r) => r.name === '好的2').x += 123;
  head.t = 4321;
  const s2 = new Store({ base: '' });
  h.doc = doc;
  mem.clear(); // 后端为权威：清空 localStorage，避免回退读到旧缓存
  await s2.load();

  const bad = s2.eventsById.get(head.id);
  assert.equal(bad.corrupt, true, '坏事件被标记');
  assert.match(bad.corruptReason, /指纹不一致/);
  assert.ok(s2.auditWarnings.some((w) => /指纹校验失败/.test(w.text)), '明确警告文本');
  assert.notEqual(s2.branch.headEventId, head.id, 'head 回退到最近可回放事件');
  assert.ok(s2.model.rects.length >= 1, '当前布局仍然可以打开');
  assert.equal(s2.replay(head.id).ok, false, '坏事件不能回放');

  const tl = s2.timeline();
  const allRows = [...tl.chain, ...tl.detached];
  const row = allRows.find((r) => r.ev.id === head.id);
  assert.ok(row, '坏事件仍显示在时间线上（链上或支线）');
  assert.equal(row.replayable, false);
  assert.equal(row.corrupt, true);
});

test('head 链中间事件损坏：回退 head，坏事件保留在审计流', async () => {
  const { s, h } = await freshStore();
  s.commit((m) => m.rects.push(newRect(1, 1, 20, 20, 'a')), { label: 'e1' });
  const e1 = s.headEvent.id;
  s.commit((m) => m.rects.push(newRect(2, 2, 20, 20, 'b')), { label: 'e2' });
  const e2 = s.headEvent.id;
  s.commit((m) => m.rects.push(newRect(3, 3, 20, 20, 'c')), { label: 'e3' });
  await s.flushed();
  const doc = structuredClone(h.doc);
  const mid = doc.events.find((e) => e.id === e2);
  mid.model.rects.find((r) => r.name === 'b').x += 99; // 破坏中间事件（新增无约束矩形）

  h.doc = doc;
  mem.clear();
  const s2 = new Store({ base: '' });
  await s2.load();
  assert.equal(s2.eventsById.get(e2).corrupt, true);
  assert.equal(s2.branch.headEventId, e1, 'head 回退到 e1（e3 也因链经过坏事件不可达）');
  assert.ok(s2.eventsById.has(e2), '坏事件没有被删除');
  assert.ok(s2.auditWarnings.length >= 1);
});

test('主分支全部损坏：用种子布局打开，坏审计仍可见', async () => {
  const { s, h } = await freshStore();
  await s.flushed();
  const doc = structuredClone(h.doc);
  // 篡改画布宽度：任何事件的重算指纹都会变（不受约束回位影响）
  for (const e of doc.events) { e.model.canvas.w += 50; }
  h.doc = doc;
  mem.clear();
  const s2 = new Store({ base: '' });
  await s2.load();
  assert.equal(s2.currentBranchId, MAIN_BRANCH);
  assert.ok(s2.model.rects.length === 4, '以种子重新打开');
  assert.ok(s2.auditWarnings.some((w) => /主分支/.test(w.text)), '提示主分支审计不可用');
  assert.ok(s2.events.some((e) => e.corrupt), '坏事件保留可见');
});

/* ---------- 旧文档迁移 / 重启一致性 ---------- */

test('旧版 entries/idx 文档迁移为审计链，回放结果与历史一致', async () => {
  const m1 = normalize(seedModel());
  const r1raw = solve(m1, null);
  for (const r of m1.rects) Object.assign(r, r1raw.rects[r.id]);
  const r1 = solve(normalize(m1), null);
  const m2 = normalize(structuredClone(m1));
  m2.rects.push({ id: 'r_legacy_new', name: '新增', x: 300, y: 300, w: 90, h: 60 });
  const r2raw = solve(m2, null);
  for (const r of m2.rects) Object.assign(r, r2raw.rects[r.id]);
  const m2n = normalize(m2);
  const r2 = solve(m2n, null);
  assert.notEqual(r2.hash, r1.hash, '前提：两条历史 hash 不同');
  const legacy = {
    entries: [
      { model: normalize(m1), report: r1, hash: r1.hash },
      { model: m2n, report: r2, hash: r2.hash, label: '移动', t: 123 },
    ],
    idx: 1, rev: 7, versions: [], currentVersionId: null, compare: {},
  };
  const mig = migrateLegacy(legacy);
  assert.equal(mig.events.length, 2);
  assert.equal(mig.branches[0].headEventId, 'e_legacy_1');
  mem.clear();
  // 后端 GET 返回 404（空 harness），走 localStorage 旧文档迁移
  const s = new Store({ base: '' });
  mem.set('rect-constraints-doc-v1', JSON.stringify(legacy));
  await s.load();
  assert.equal(s.headEvent.hash, r2.hash, '迁移后当前布局 hash 不变');
  assert.equal(s.events.length, 2);
  assert.equal(s.headEvent.actor, '历史迁移');
  assert.equal(s.canUndo, true);
  s.undo();
  assert.equal(s.headEvent.hash, r1.hash, '迁移历史可回放/撤销');
});

test('重启后审计顺序、分支关系、回放结果一致', async () => {
  const { s } = await freshStore();
  s.setActor('李四');
  s.commit((m) => m.rects.push(newRect(10, 10, 40, 40, '主干1')), { label: 'c1' });
  const eFork = s.headEvent;
  const f1 = s.forkFromEvent(eFork.id, '发布线');
  s.commit((m) => m.rects.push(newRect(20, 20, 40, 40, '分支内')), { label: 'c2' });
  s.setBranchCompare(MAIN_BRANCH, f1.branch.id);
  await s.flushed();

  const before = {
    events: s.events.map((e) => [e.id, e.seq, e.parentId, e.branch, e.hash]),
    branches: s.branches.map((b) => [b.id, b.headEventId, b.source]),
    cmp: s.compareBranches(MAIN_BRANCH, f1.branch.id),
  };

  const s2 = new Store({ base: '' });
  await s2.load();
  assert.deepEqual(
    s2.events.map((e) => [e.id, e.seq, e.parentId, e.branch, e.hash]),
    before.events,
    '事件顺序/链/指纹一致',
  );
  assert.deepEqual(
    s2.branches.map((b) => [b.id, b.headEventId, b.source]),
    before.branches,
    '分支关系一致',
  );
  assert.equal(s2.branchCompare.a, MAIN_BRANCH, '分支比较选择持久化');
  assert.equal(JSON.stringify(s2.compareBranches(MAIN_BRANCH, f1.branch.id)), JSON.stringify(before.cmp));

  // 回放每个事件，结果与存储指纹一致
  for (const e of s2.events) {
    if (e.corrupt || !e.model) continue;
    assert.ok(s2.replay(e.id).ok);
    assert.equal(s2.report.hash, e.hash, `回放 ${e.id} 指纹一致`);
  }
});

/* ---------- 并发：同分支 head 前进拒绝；不同分支合流 ---------- */

test('两个页面从同一分支头编辑：旧页面携带过期事件序号被 409 拒绝', async () => {
  const { s: p1 } = await freshStore();
  const p2 = new Store({ base: '' });
  await p2.load();
  assert.equal(p1.branch.headEventId, p2.branch.headEventId);

  p1.commit((m) => m.rects.push(newRect(10, 500, 80, 50, '页面1')), { label: 'p1' });
  await p1.flushed();
  assert.equal(p1.saveConflict, null);

  p2.commit((m) => m.rects.push(newRect(900, 500, 80, 50, '页面2')), { label: 'p2' });
  await p2.flushed();
  assert.equal(p2.saveConflict?.reason, 'branch-advanced', '明确报“分支已前进”');
  assert.ok(p2.model.rects.some((r) => r.name === '页面2'), '本地修改保留在内存');

  const check = new Store({ base: '' });
  await check.load();
  assert.ok(check.model.rects.some((r) => r.name === '页面1'));
  assert.ok(!check.model.rects.some((r) => r.name === '页面2'), '旧提交没有覆盖');
  assert.equal(check.events.length, p1.events.length, '事件只被页面1推进');
});

test('两个页面编辑不同分支：过期提交自动合流，两边内容都保留', async () => {
  const { s: p1 } = await freshStore();
  const baseHead = p1.branch.headEventId;
  const f = p1.forkFromEvent(baseHead, '分支A');
  await p1.flushed();

  const p2 = new Store({ base: '' });
  await p2.load();
  // p2 停在 main；p1 也切回 main 制造 rev 竞争，p2 编辑 main
  p1.switchBranch(MAIN_BRANCH);
  p1.commit((m) => m.rects.push(newRect(10, 10, 30, 30, 'A-主干')), { label: 'a' });
  await p1.flushed();

  // p2 的 rev 已过期，但它把分支 A 切过去编辑（不同分支）
  p2.switchBranch(f.branch.id);
  p2.commit((m) => m.rects.push(newRect(20, 20, 30, 30, 'B-分支')), { label: 'b' });
  await p2.flushed();
  assert.equal(p2.saveConflict, null, '不同分支不冲突');

  const check = new Store({ base: '' });
  await check.load();
  assert.ok(check.events.some((e) => e.label === 'a'), '主干事件保留');
  assert.ok(check.events.some((e) => e.label === 'b'), '分支事件保留');
  const branchA = check.branches.find((x) => x.id === f.branch.id);
  assert.ok(branchA, '分支 A 存在');
  const headB = check.eventsById.get(branchA.headEventId);
  assert.equal(headB.label, 'b');
  assert.ok(headB.model.rects.some((r) => r.name === 'B-分支'));
  assert.ok(check.branches.find((x) => x.id === MAIN_BRANCH).headEventId);
});

/* ---------- 纯函数：合流规则确定性 ---------- */

test('mergeDocs/assessConflict 纯函数规则', () => {
  const mkEvent = (id, branch, parent, n) => {
    const m = normalize(seedModel());
    const r = solve(m);
    return { id, branch, parentId: parent, kind: parent ? 'edit' : 'root', seq: n, t: n, actor: 'x', label: id, model: m, report: r, hash: r.hash, hashBefore: null, changes: null, conflicts: [] };
  };
  const e0 = mkEvent('e0', 'main', null, 1);
  const e1 = mkEvent('e1', 'main', 'e0', 2);
  const srv = {
    events: [e0, e1],
    branches: [{ id: 'main', name: '主分支', rootEventId: 'e0', headEventId: 'e1', redoTipId: null, source: null }],
    currentBranchId: 'main', versions: [], currentVersionId: null,
    compare: {}, branchCompare: {}, actor: '',
  };
  // 过期 + 同分支 -> branch-advanced
  const staleSame = { ...structuredClone(srv), currentBranchId: 'main', baseHeads: { main: 'e0' } };
  const v = assessConflict(srv, staleSame);
  assert.equal(v.mergeable, false);
  assert.equal(v.reason, 'branch-advanced');
  assert.equal(v.headSeq, 2);

  // 过期 + 不同分支（fork 来源 e1 在服务端）-> 可合流
  const f0 = { ...mkEvent('f0', 'b1', null, 1), kind: 'fork-root', provenance: { branchId: 'main', eventId: 'e1', seq: 2 } };
  const client = {
    ...structuredClone(srv),
    events: [structuredClone(e0), structuredClone(e1), f0],
    branches: [
      { id: 'main', name: '主分支', rootEventId: 'e0', headEventId: 'e1', redoTipId: null, source: null },
      { id: 'b1', name: '分支', rootEventId: 'f0', headEventId: 'f0', redoTipId: null, source: { branchId: 'main', eventId: 'e1' } },
    ],
    currentBranchId: 'b1',
    baseHeads: { main: 'e1', b1: 'f0' },
  };
  const v2 = assessConflict(srv, client);
  assert.equal(v2.mergeable, true);
  const merged = mergeDocs(srv, client);
  assert.ok(merged.events.some((e) => e.id === 'f0'));
  assert.equal(merged.branches.find((b) => b.id === 'b1').headEventId, 'f0');
  assert.equal(merged.branches.find((b) => b.id === 'main').headEventId, 'e1', '非当前分支保留服务端 head');
  // 确定性
  assert.equal(JSON.stringify(mergeDocs(srv, client)), JSON.stringify(mergeDocs(srv, client)));
});

/* ---------- 注册为单个串行 suite ---------- */
describe('布局审计与分支', { concurrency: 1 }, () => {
  rawTest.afterEach(afterEachFn);
  for (const [name, fn] of collected) rawTest(name, fn);
});
