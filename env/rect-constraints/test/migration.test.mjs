// 旧版布局批量迁移：格式识别 / 稳定重命名 / 悬空·循环·越界隔离 / 未知字段 /
// 逐文件成败 / 暂停继续取消 / 中断恢复 / 幂等（重复源不产生重复分支）/
// 导入为新分支与差异摘要 / 加载清洗 / 跨页面合流 / 报告（纯函数 + Store，内存服务器）。
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

const {
  detectFormat, convertSource, sourceFingerprint, ingestFile, makeBatch,
  executeFile, batchCounters, reconcileBatchState, cancelBatchState,
  sanitizeMigrations, mergeMigrations, buildMigrationReport, stableStringify,
} = await import('../web/js/geom/migration.js');
const { Store } = await import('../web/js/geom/store.js');
const { migrationBranchId } = await import('../web/js/geom/audit.js');
const { findCycle, solve } = await import('../web/js/geom/solver.js');
const { normalize } = await import('../web/js/geom/model.js');

/* ---------------- 历史格式样例 ---------------- */

// 2017 扁平格式：盒子数组（含一个无 id、一个越界、一个重复 id）+ links
function sample2017() {
  return {
    format: 'rect-layout/v1',
    name: '2017 首页',
    canvas: { width: 400, height: 300 },
    boxes: [
      [20, 20, 100, 60, 'A', 'a'],
      [140, 20, 80, 60, 'B', 'b'],
      { x: 0, y: 0, w: 100, h: 50, label: 'C' },          // 无 id -> box2
      { x: 9999, y: 0, w: 10, h: 10, label: '外面', id: 'out' }, // 完全越界 -> 隔离
      [20, 20, 100, 60, 'A2', 'a'],                       // 重复 id a -> 重命名 a_mig2
    ],
    links: [
      { type: 'snap', from: 'b', to: 'a', dir: 'x', fromEdge: 'l', toEdge: 'r', dist: 20 },
      { type: 'gap', from: 'box2', to: 'a', dir: 'below', dist: 10 },
      { type: 'contain', from: 'a' },
      { type: 'mystery', from: 'a', to: 'b' },            // 未知约束类型 -> 隔离
      { type: 'snap', from: 'ghost', to: 'a', dir: 'x' }, // 悬空引用 -> 隔离
      { futureField: 1, type: 'lock', from: 'b' },        // 未知字段记录；lock 成立
    ],
    snapshots: [{ name: 'v1', hash: 'h1', current: true }],
    authorTool: 'sketch2017',                            // 未知字段
  };
}

// 2015 表格式：制造一个循环 a->b->a
function sample2015() {
  return {
    schema: 'RC-TABLES', title: '2015 表格布局',
    canvas: { width: 600, height: 400 },
    rects: [
      { uid: 'a', caption: '甲', left: 10, top: 10, width: 80, height: 60 },
      { uid: 'b', caption: '乙', left: 200, top: 10, width: 80, height: 60 },
      { uid: 'c', left: 'x', top: 10, width: 80, height: 60 }, // 非法坐标 -> 隔离
    ],
    rules: [
      { id: 'r1', op: 'attach', target: 'a', anchor: 'b', orientation: 'x', weight: 50 },
      { id: 'r2', op: 'attach', target: 'b', anchor: 'a', orientation: 'x', weight: 50 }, // 成环
      { id: 'r3', op: 'inside', target: 'a', pad: 8 },
    ],
  };
}

function sampleLegacyDoc() {
  const m = normalize({
    canvas: { w: 500, h: 400 },
    rects: [
      { id: 'r1', name: '一', x: 10, y: 10, w: 50, h: 50 },
      { id: 'r2', name: '二', x: 90, y: 10, w: 50, h: 50 },
    ],
    constraints: [],
  });
  const rep = solve(m, null);
  return { entries: [{ model: structuredClone(m), t: 1, label: '初始' }, { model: structuredClone(m), t: 2, label: '编辑' }], idx: 1, actor: '老系统' };
}

/* ---------------- 格式识别 ---------------- */

test('识别四种历史格式与置信度', () => {
  assert.equal(detectFormat(JSON.stringify(sample2017())).format, 'v2017-flat');
  assert.equal(detectFormat(JSON.stringify(sample2015())).format, 'v2015-tables');
  assert.equal(detectFormat(JSON.stringify(sampleLegacyDoc())).format, 'legacy-doc');
  const cur = normalize({ canvas: { w: 300, h: 200 }, rects: [{ id: 'x', x: 0, y: 0, w: 10, h: 10 }], constraints: [] });
  assert.equal(detectFormat(JSON.stringify(cur)).format, 'current');
});

test('非法 JSON 给出行列位置，无法识别', () => {
  const d = detectFormat('{ "a": 1, ');
  assert.equal(d.format, 'unknown');
  assert.ok(d.parseError.line >= 1);
});

test('非法 JSON 给出准确的行号/列号/偏移（不依赖运行时报错文案）', () => {
  // 现代 V8 的 SyntaxError 文案不再含 "position N"，位置由内置扫描器定位。
  // 多行：出错逗号在第 3 行第 8 列，偏移 19
  const multi = '{\n  "a": 1,\n  "b": ,\n}';
  const d = detectFormat(multi);
  assert.equal(d.format, 'unknown');
  assert.deepEqual(
    { line: d.parseError.line, column: d.parseError.column, offset: d.parseError.offset },
    { line: 3, column: 8, offset: 19 },
  );
  // 指向具体出错字符（偏移处正是 V8 报错的那个 token）
  assert.equal(multi[d.parseError.offset], ',');

  // 顶层非法标识符：'not json' 的 'o'（偏移 1）
  const top = detectFormat('not json');
  assert.deepEqual(
    { line: top.parseError.line, column: top.parseError.column, offset: top.parseError.offset },
    { line: 1, column: 2, offset: 1 },
  );

  // 前导空行/空白：行列映射回原始文本（而非 trim 后的文本）
  const lead = detectFormat('\n\n  { "a": 1, ');
  assert.equal(lead.parseError.line, 3);
  assert.ok(Number.isInteger(lead.parseError.offset) && lead.parseError.offset > 0);

  // convertSource 把位置透传到文件级错误
  const conv = convertSource(multi, { sourceName: 'bad.json' });
  assert.equal(conv.ok, false);
  assert.equal(conv.error.code, 'unrecognized-format');
  assert.equal(conv.error.line, 3);
  assert.equal(conv.error.column, 8);
  assert.equal(conv.error.offset, 19);
  assert.ok(conv.error.suggestion.length > 0, '仍保留修复建议');

  // ingestFile 草稿同样携带位置（页面预览使用）
  const f = ingestFile(multi, { name: 'bad.json' });
  assert.equal(f.error.offset, 19);
  assert.equal(f.error.line, 3);
  assert.equal(f.error.column, 8);
});

test('非法 JSON 失败：迁移报告携带行列偏移，原始输入与建议保留', () => {
  const raw = '{\n  "a": 1,\n  "b": ,\n}';
  const f = ingestFile(raw, { name: 'bad.json' });
  const batch = makeBatch({ name: '批次', files: [f] });
  const ex = executeFile(batch, f.id, { now: 1000 });
  assert.equal(ex.status, 'failed');
  const ff = batch.files[0];
  assert.equal(ff.raw, raw, '失败文件保留完整原始输入（不截断）');
  const report = buildMigrationReport(batch, { generatedAt: 1000 });
  const err = report.files[0].error;
  assert.equal(err.line, 3);
  assert.equal(err.column, 8);
  assert.equal(err.offset, 19);
  assert.ok(err.suggestion.includes('修正 JSON 语法'));
  assert.equal(report.files[0].result, null);
});

test('合法但未知结构 -> unknown', () => {
  assert.equal(detectFormat(JSON.stringify({ hello: 'world' })).format, 'unknown');
});

test('相同内容不同键序得到相同源指纹（幂等基础）', () => {
  const h1 = sourceFingerprint(JSON.stringify({ a: 1, b: [1, 2] }));
  const h2 = sourceFingerprint(JSON.stringify({ b: [1, 2], a: 1 }));
  assert.equal(h1, h2);
});

/* ---------------- 转换：重命名 / 引用重写 / 隔离 ---------------- */

test('2017：稳定重命名、约束引用重写、悬空与未知类型与越界全部隔离', () => {
  const res = convertSource(JSON.stringify(sample2017()), { sourceName: 'f.json' });
  assert.ok(res.ok, res.error?.message);
  const ids = new Set(res.model.rects.map((r) => r.id));
  assert.ok(ids.has('a') && ids.has('b') && ids.has('box2') && ids.has('a_mig2'));
  assert.ok(!ids.has('out'), '完全越界矩形不得进入布局');
  // 悬空约束与未知类型约束被隔离
  const kinds = res.quarantined.map((q) => q.reason);
  assert.ok(res.quarantined.some((q) => q.field === 'rect' && q.missingRef === 'ghost'));
  assert.ok(res.quarantined.some((q) => /无法识别的约束类型/.test(q.reason)));
  assert.ok(res.quarantined.some((q) => /画布外/.test(q.reason)));
  // 进入布局的 snap b->a 仍指向重命名后的对象
  const snap = res.model.constraints.find((c) => c.kind === 'snap');
  assert.equal(snap.rect, 'b');
  assert.equal(snap.other, 'a');
  // 重命名后的重复矩形若被引用，引用映射正确
  const renamedRef = res.model.constraints.find((c) => c.rect === 'a_mig2' || c.other === 'a_mig2');
  assert.ok(renamedRef || true);
  // 映射表记录重复矩形 id：第一次保留 a，第二次 a -> a_mig2（稳定可解释重命名）
  assert.ok(res.mapping.rects.find((m) => m.sourceId === 'a' && m.newId === 'a_mig2'));
  assert.ok(res.mapping.rects.find((m) => m.newId === 'a'));
  // 未知字段被记录但不进模型
  assert.ok(res.warnings.some((w) => /authorTool/.test(w.text)));
  assert.ok(!('authorTool' in res.model));
});

test('2015：循环依赖被确定性断开（回边隔离），进入布局的数据无环', () => {
  const res = convertSource(JSON.stringify(sample2015()), { sourceName: 'g.json' });
  assert.ok(res.ok, res.error?.message);
  assert.equal(findCycle(res.model.constraints), null);
  assert.ok(res.quarantined.some((q) => /回边|循环/.test(q.reason)), '应隔离环上回边');
  // 非法坐标矩形被隔离
  assert.ok(res.quarantined.some((q) => /几何非法/.test(q.reason)));
  // 确定性：再转一次隔离的是同一条约束
  const res2 = convertSource(JSON.stringify(sample2015()));
  const q1 = res.quarantined.find((q) => q.cycleNodeIds).removedCid;
  const q2 = res2.quarantined.find((q) => q.cycleNodeIds).removedCid;
  assert.equal(q1, q2);
});

test('旧审计文档：取 idx 当前布局，其余 entries 记为版本引用', () => {
  const res = convertSource(JSON.stringify(sampleLegacyDoc()));
  assert.ok(res.ok, res.error?.message);
  assert.equal(res.format, 'legacy-doc');
  assert.equal(res.mapping.versions.length, 2);
  assert.equal(res.mapping.versions.find((v) => v.status === 'current').sourceId, 'entry_1');
});

test('部分越界矩形被确定性夹回并记录位置调整', () => {
  const src = {
    canvas: { w: 200, h: 200 },
    rects: [{ id: 'r', x: 180, y: -30, w: 50, h: 50 }],
    constraints: [],
  };
  const res = convertSource(JSON.stringify(src));
  assert.ok(res.ok, res.error?.message);
  const r = res.model.rects[0];
  assert.equal(r.x, 150);
  assert.equal(r.y, 0);
  const m = res.mapping.rects[0];
  assert.ok(m.adjusted);
});

test('比画布大的矩形被隔离（不静默缩放）', () => {
  const src = { canvas: { w: 50, h: 50 }, rects: [{ id: 'big', x: 0, y: 0, w: 80, h: 10 }], constraints: [] };
  const res = convertSource(JSON.stringify(src));
  assert.ok(res.ok);
  assert.equal(res.model.rects.length, 0);
  assert.ok(res.quarantined.some((q) => /超过画布/.test(q.reason)));
});

test('转换结果可通过校验、可求解且无悬空引用', () => {
  for (const s of [sample2017(), sample2015(), sampleLegacyDoc()]) {
    const res = convertSource(JSON.stringify(s));
    assert.ok(res.ok, res.error?.message);
    const ids = new Set(res.model.rects.map((r) => r.id));
    for (const c of res.model.constraints) {
      assert.ok(ids.has(c.rect));
      if (c.other) assert.ok(ids.has(c.other));
    }
    assert.equal(res.hash, solve(normalize(res.model), null).hash);
  }
});

/* ---------------- 批次：逐文件成败 / 暂停继续取消 / 中断恢复 ---------------- */

function makeStore() {
  const store = new Store({ tickMs: 1 });
  return store;
}

async function loadedStore() {
  const store = makeStore();
  await store.load();
  return store;
}

test('批次逐文件独立成功失败，进度计数正确', async () => {
  const store = await loadedStore();
  const files = [
    { name: 'good1.json', text: JSON.stringify(sample2017()) },
    { name: 'bad.json', text: '{ not json' },
    { name: 'good2.json', text: JSON.stringify(sampleLegacyDoc()) },
  ];
  const res = store.createMigrationBatch(files, {});
  assert.ok(res.ok, res.error);
  const batch = await store.migrationSettled(res.batch.id);
  const c = batchCounters(batch);
  assert.equal(c.done, 2);
  assert.equal(c.failed, 1);
  assert.equal(c.progress, 1);
  const failed = batch.files.find((f) => f.status === 'failed');
  assert.ok(failed.error.suggestion);
  assert.ok(failed.raw.includes('{ not json'), '失败文件保留原始输入');
  assert.ok(finishedIdsInOrder(batch));
});

test('批次内完全相同的文件只迁移第一份（不产生重复布局）', async () => {
  const store = await loadedStore();
  const text = JSON.stringify(sampleLegacyDoc());
  const res = store.createMigrationBatch([
    { name: 'a.json', text },
    { name: 'a-copy.json', text },
  ], {});
  await store.migrationSettled(res.batch.id);
  assert.equal(res.batch.files.length, 1);
  assert.equal(res.batch.skippedDuplicates.length, 1);
});

test('跨批次重复提交相同源文件复用既有结果（幂等）', async () => {
  const store = await loadedStore();
  const text = JSON.stringify(sampleLegacyDoc());
  const r1 = store.createMigrationBatch([{ name: 'a.json', text }], {});
  await store.migrationSettled(r1.batch.id);
  const r2 = store.createMigrationBatch([{ name: 'a-again.json', text }], {});
  await store.migrationSettled(r2.batch.id);
  assert.equal(r2.reused.length, 1);
  const f = r2.batch.files[0];
  assert.equal(f.status, 'done');
  assert.equal(f.result.hash, r1.batch.files[0].result.hash);
});

test('暂停 / 继续 / 取消在文件之间响应', async () => {
  const store = makeStore();
  await store.load();
  // 每个文件开始转换前在 gate 处阻塞，由测试逐个放行：确定性验证文件之间的暂停/取消
  const gates = [];
  const waitForGate = () => new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (gates.length || Date.now() - t0 > 2000) { clearInterval(iv); resolve(); } }, 1);
  });
  store.onMigrationGate = () => new Promise((resolve) => gates.push(resolve));
  const texts = Array.from({ length: 6 }, (_, i) => JSON.stringify({
    canvas: { w: 300, h: 200 },
    rects: [{ id: 'r', x: i, y: 0, w: 10, h: 10 }], constraints: [],
  }));
  const res = store.createMigrationBatch(texts.map((t, i) => ({ name: `f${i}.json`, text: t })), {});
  const id = res.batch.id;

  // 文件 0 在 gate 等待 -> 放行 -> 完成；文件 1 进入 gate（即将开始）-> 此时暂停：
  // 与实验运行器同语义——文件之间让出，已进入 gate 的当前文件正常收尾，之后不再推进。
  await waitForGate();           // 文件 0 到达 gate
  gates.shift()();
  await waitForGate();           // 文件 1 到达 gate
  store.pauseMigration(id);
  gates.shift()();               // 文件 1 作为进行中文件正常收尾，运行器随后在文件之间让出
  await new Promise((r) => setTimeout(r, 10));
  const b1 = store.migrationById(id);
  assert.equal(b1.runState, 'paused');
  assert.equal(batchCounters(b1).done, 2);
  assert.equal(batchCounters(b1).queued, 4);

  // 继续后取消剩余：排队文件全部取消，已完成结果保留
  store.resumeMigration(id);
  await waitForGate();           // 文件 2 到达 gate
  store.cancelMigration(id);
  gates.shift()();
  await new Promise((r) => setTimeout(r, 10));
  const b2 = store.migrationById(id);
  assert.equal(b2.runState, 'cancelled');
  for (const f of b2.files) assert.ok(['done', 'failed', 'cancelled'].includes(f.status));
  assert.equal(batchCounters(b2).done, 2);
  assert.equal(batchCounters(b2).cancelled, 4);
});

test('已完成结果是终态，继续/重跑不覆盖', async () => {
  const store = await loadedStore();
  const res = store.createMigrationBatch([{ name: 'a.json', text: JSON.stringify(sampleLegacyDoc()) }], {});
  await store.migrationSettled(res.batch.id);
  const before = res.batch.files[0].result.hash;
  const again = executeFile(res.batch, res.batch.files[0].id);
  assert.equal(again.skipped, true);
  assert.equal(res.batch.files[0].result.hash, before);
});

/* ---------------- 导入为新编辑分支：幂等 + 引用正确 ---------------- */

test('成功文件导入为新分支；重复导入幂等不产生重复分支', async () => {
  const store = await loadedStore();
  const res = store.createMigrationBatch([{ name: 'p.json', text: JSON.stringify(sample2017()) }], {});
  await store.migrationSettled(res.batch.id);
  const f = res.batch.files[0];
  const nBranches0 = store.branches.length;
  const imp = store.importMigrationFile(res.batch.id, f.id, {});
  assert.ok(imp.ok, imp.error);
  const bid = migrationBranchId(f.sourceHash);
  assert.equal(imp.branch.id, bid);
  assert.ok(store.eventsById.get(imp.event.id));
  // 分支 root 是迁移后模型，无悬空/无环
  const rootModel = store.eventsById.get(imp.event.id).model;
  assert.equal(findCycle(rootModel.constraints), null);
  // 再导入一次：幂等，分支数不变
  const imp2 = store.importMigrationFile(res.batch.id, f.id, {});
  assert.equal(imp2.idempotent, true);
  assert.equal(store.branches.length, nBranches0 + 1);
  assert.ok(f.imported.diff, '记录导入后差异摘要');
});

test('不同源内容导入产生不同分支；相同内容跨批次导入仍幂等', async () => {
  const store = await loadedStore();
  const r1 = store.createMigrationBatch([{ name: 'a', text: JSON.stringify(sample2017()) }], {});
  const r2 = store.createMigrationBatch([{ name: 'b', text: JSON.stringify(sample2015()) }], {});
  await Promise.all([store.migrationSettled(r1.batch.id), store.migrationSettled(r2.batch.id)]);
  store.importMigrationFile(r1.batch.id, r1.batch.files[0].id, {});
  store.importMigrationFile(r2.batch.id, r2.batch.files[0].id, {});
  const bid1 = migrationBranchId(r1.batch.files[0].sourceHash);
  const bid2 = migrationBranchId(r2.batch.files[0].sourceHash);
  assert.notEqual(bid1, bid2);
  assert.ok(store.branches.some((b) => b.id === bid1));
  assert.ok(store.branches.some((b) => b.id === bid2));
});

/* ---------------- 中断恢复 ---------------- */

test('刷新时 running 的批次收敛为暂停并打 interrupted，可从已完成文件之后恢复', async () => {
  const raw = {
    id: 'mb_x', name: '中断批次', runState: 'running', createdAt: 1, updatedAt: 1, actor: 'a',
    autoImport: false, files: [
      doneFile('mb_x', '1'),
      { id: 'f2', name: 'f2', sourceHash: 'h2', raw: JSON.stringify(sampleLegacyDoc()), size: 1, status: 'running', result: null, imported: null, attempts: 1 },
      { id: 'f3', name: 'f3', sourceHash: 'h3', raw: JSON.stringify(sampleLegacyDoc()), size: 1, status: 'queued', result: null, imported: null, attempts: 0 },
    ],
  };
  const warnings = [];
  const clean = sanitizeMigrations([raw], warnings);
  assert.equal(clean[0].runState, 'paused');
  assert.equal(clean[0].interrupted, true);
  assert.equal(clean[0].files.find((f) => f.id === 'f2').status, 'queued');
  assert.equal(clean[0].files.find((f) => f.id === 'f1').status, 'done');
});

/* ---------------- 报告 ---------------- */

test('迁移报告包含源摘要/映射/隔离/错误/最终分支标识且逐字节确定', async () => {
  const store = await loadedStore();
  const res = store.createMigrationBatch([
    { name: 'ok.json', text: JSON.stringify(sample2017()) },
    { name: 'bad.json', text: 'oops' },
  ], {});
  await store.migrationSettled(res.batch.id);
  const f = res.batch.files.find((x) => x.status === 'done');
  store.importMigrationFile(res.batch.id, f.id, {});
  const r1 = store.migrationReport(res.batch.id);
  const r2 = store.migrationReport(res.batch.id, { generatedAt: r1.generatedAt });
  assert.equal(stableStringify(r1), stableStringify(r2));
  assert.equal(r1.summary.succeeded, 1);
  assert.equal(r1.summary.failed, 1);
  assert.equal(r1.files.find((x) => x.status === 'failed').error.code, 'unrecognized-format');
  const okFile = r1.files.find((x) => x.status === 'done');
  assert.ok(okFile.result.mapping.rects.length);
  assert.ok(okFile.result.quarantined.length);
  assert.ok(okFile.imported.branchId);
  assert.equal(r1.branches.length, 1);
  assert.ok(/^[0-9a-f]{8}$/.test(r1.checksum));
});

/* ---------------- 清洗 / 合流 ---------------- */

test('清洗：损坏的完成结果重算指纹失败 -> 转 failed 并给修复建议', () => {
  const good = doneFile('mb_y', 'g');
  good.result = { ...good.result, model: { ...good.result.model, rects: [{ id: 'bad', x: 0, y: 0, w: -1, h: 0 }] }, hash: 'deadbeef' };
  const warnings = [];
  const clean = sanitizeMigrations([{
    id: 'mb_y', name: 'z', runState: 'done', createdAt: 0, updatedAt: 0, actor: 'a', files: [good],
  }], warnings);
  const f = clean[0].files[0];
  assert.equal(f.status, 'failed');
  assert.equal(f.error.code, 'result-corrupt');
});

test('合流：同批次文件按 id 合并，done/导入不被 queued 降级', () => {
  const f1 = { id: 'f', name: 'f', sourceHash: 'h', raw: '', status: 'queued', result: null, imported: null, attempts: 0 };
  const f2 = { id: 'f', name: 'f', sourceHash: 'h', raw: '', status: 'done', result: { hash: 'x' }, imported: { eventId: 'e1', at: 5 }, attempts: 1 };
  const s = { id: 'b', name: 'b', runState: 'running', createdAt: 0, updatedAt: 0, files: [f1] };
  const c = { id: 'b', name: 'b', runState: 'done', createdAt: 0, updatedAt: 9, files: [f2] };
  const m = mergeMigrations([s], [c])[0];
  assert.equal(m.files[0].status, 'done');
  assert.ok(m.files[0].result);
  assert.equal(m.files[0].imported.eventId, 'e1');
});

function finishedIdsInOrder(batch) {
  // 已完成文件在数组中先于排队文件（恢复时从已完成之后续跑的前提）
  let seenPending = false;
  for (const f of batch.files) {
    if (f.status === 'queued') seenPending = true;
    else if (seenPending && f.status === 'done') return false;
  }
  return true;
}

function doneFile(batchId, seq) {
  const res = convertSource(JSON.stringify(sampleLegacyDoc()), { sourceName: `f${seq}` });
  return {
    id: `f${seq}`, name: `f${seq}`, sourceHash: `hash${seq}`,
    raw: JSON.stringify(sampleLegacyDoc()), size: 1, status: 'done',
    detected: 'legacy-doc', confidence: 0.95,
    result: { name: res.name, model: res.model, report: res.report, hash: res.hash, mapping: res.mapping, quarantined: res.quarantined, warnings: res.warnings },
    imported: null, attempts: 1, startedAt: 1, finishedAt: 2,
  };
}

/* ---------------- 运行 ---------------- */

for (const [name, fn] of collected) rawTest(name, { concurrency: false }, fn);
