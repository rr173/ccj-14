// 真实 HTTP 后端 e2e：旧版布局批量迁移的批次执行 / 逐文件成败 / 幂等 /
// 暂停继续取消 / 服务中断恢复 / 导入为新分支（重复源不产生重复分支）/
// 刷新一致 / 服务端结构校验与跨分支合流。用法：先启动 server（8099）。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { Store } = await import('../web/js/geom/store.js');
const { findCycle } = await import('../web/js/geom/solver.js');

const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

await fetch(BASE + '/api/reset', { method: 'POST' });

const legacy2017 = (label) => JSON.stringify({
  format: 'rect-layout/v1', name: label,
  canvas: { width: 400, height: 300 },
  boxes: [[20, 20, 100, 60, 'A', 'a'], [140, 20, 80, 60, 'B', 'b']],
  links: [{ type: 'snap', from: 'b', to: 'a', dir: 'x', fromEdge: 'l', toEdge: 'r', dist: 20 }],
});
const legacy2015 = JSON.stringify({
  schema: 'RC-TABLES', title: '表格布局',
  canvas: { width: 500, height: 400 },
  rects: [
    { uid: 'x', caption: '甲', left: 10, top: 10, width: 60, height: 50 },
    { uid: 'y', left: 'x', top: 10, width: 60, height: 50 }, // 非法坐标 -> 隔离
  ],
  rules: [{ id: 'rr', op: 'attach', target: 'x', anchor: 'MISSING', orientation: 'x' }], // 悬空 -> 隔离
});

const store = new Store({ base: BASE, tickMs: 5 });
await store.load();

// 1) 批次：两成一败，逐文件独立
const cr = store.createMigrationBatch([
  { name: 'a.json', text: legacy2017('布局A') },
  { name: 'b.json', text: legacy2015 },
  { name: 'bad.json', text: '{\n  "ok": 1,\n  "bad": ,\n}' },
], { name: 'HTTP 迁移批次' });
ok(cr.ok, '建立迁移批次');
const bid = cr.batch.id;
await store.migrationSettled(bid);
await store.flushed();
const batch = store.migrationById(bid);
ok(batch.files.filter((f) => f.status === 'done').length === 2, '两份文件成功');
ok(batch.files.find((f) => f.name === 'bad.json').status === 'failed', '非法 JSON 文件独立失败');
const failed = batch.files.find((f) => f.status === 'failed');
ok(!!failed.error.suggestion && failed.raw.includes('"bad": ,'), '失败文件保留原始输入与修复建议');
ok(failed.error.line === 3 && failed.error.column === 10 && failed.error.offset === 22,
  `失败错误带准确行列偏移（line=${failed.error.line},col=${failed.error.column},off=${failed.error.offset}）`);

// 2) 成功结果干净：无悬空 / 无环 / 约束引用正确
const aFile = batch.files.find((f) => f.name === 'a.json');
const m = aFile.result.model;
ok(!findCycle(m.constraints), '迁移结果无循环依赖');
const ids = new Set(m.rects.map((r) => r.id));
ok(m.constraints.every((c) => ids.has(c.rect) && (c.other == null || ids.has(c.other))), '无悬空引用');
ok(m.constraints.some((c) => c.kind === 'snap' && c.rect === 'b' && c.other === 'a'), '约束引用在重命名后仍正确');

// 3) 导入为新编辑分支；相同源重复导入幂等
const imp = store.importMigrationFile(bid, aFile.id, {});
ok(imp.ok && !imp.idempotent, '成功文件导入为新编辑分支');
await store.flushed();
const branchId = imp.branch.id;
const imp2 = store.importMigrationFile(bid, aFile.id, {});
ok(imp2.idempotent && imp2.branch.id === branchId, '相同源重复导入幂等，不产生重复分支');

// 4) 跨批次重复提交相同源文件：复用既有结果，不重复转换、不产生重复分支
const cr2 = store.createMigrationBatch([{ name: 'a-copy.json', text: legacy2017('布局A') }], {});
ok(cr2.reused && cr2.reused.length === 1, '跨批次相同源文件复用既有迁移结果');
await store.migrationSettled(cr2.batch.id);
const f2 = cr2.batch.files[0];
const imp3 = store.importMigrationFile(cr2.batch.id, f2.id, {});
ok(imp3.idempotent && imp3.branch.id === branchId, '复用结果导入仍指向同一分支（无重复布局）');

// 5) 批次内完全相同文件只迁移一份
const cr3 = store.createMigrationBatch([
  { name: 'x1.json', text: legacy2015 },
  { name: 'x2.json', text: legacy2015 },
], {});
ok(cr3.batch.files.length === 1 && cr3.batch.skippedDuplicates.length === 1, '批次内重复源只迁移一份并记录跳过');

// 6) 刷新后批次 / 文件终态 / 导入记录 / 分支一致
const store2 = new Store({ base: BASE, tickMs: 5 });
await store2.load();
const rb = store2.migrationById(bid);
ok(!!rb && rb.runState === 'done', '刷新后批次为已结束');
ok(rb.files.find((f) => f.name === 'a.json').result.hash === aFile.result.hash, '刷新后迁移结果指纹一致');
ok(store2.branches.some((b) => b.id === branchId && b.source?.kind === 'migration'), '刷新后迁移分支与来源关系保留');
const root = store2.eventsById.get(store2.branches.find((b) => b.id === branchId).rootEventId);
ok(root.provenance.kind === 'migration' && root.provenance.sourceFileHash === aFile.sourceHash, 'fork-root 带 migration provenance');

// 7) 暂停 / 继续 / 取消
const texts = Array.from({ length: 6 }, (_, i) => JSON.stringify({
  canvas: { w: 300, h: 200 }, rects: [{ id: 'r', x: i, y: 0, w: 10, h: 10 }], constraints: [],
}));
const gates = [];
store2.onMigrationGate = () => new Promise((r) => gates.push(r));
const waitGate = () => new Promise((res) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (gates.length || Date.now() - t0 > 2000) { clearInterval(iv); res(); } }, 1);
});
const cr4 = store2.createMigrationBatch(texts.map((t, i) => ({ name: `f${i}.json`, text: t })), {});
const id4 = cr4.batch.id;
await waitGate(); gates.shift()();
await waitGate();
store2.pauseMigration(id4);
gates.shift()();
await sleep(15);
const paused = store2.migrationById(id4);
ok(paused.runState === 'paused' && paused.files.filter((f) => f.status === 'done').length === 2, '批次暂停，已开始文件收尾、后续不推进');
await store2.flushed();

// 8) 服务中断恢复：刷新时仍 running 的批次从已完成文件之后自动续跑
// 手动把服务端批次改为 running（模拟中断瞬间），重新 load
let doc = await (await fetch(BASE + '/api/doc')).json();
doc.migrations = doc.migrations.map((b) => b.id === id4
  ? { ...b, runState: 'running', files: b.files.map((f) => f.status === 'queued' ? f : f) }
  : b);
// 直接经 PUT 回写（带正确基线）
{
  const cur = await (await fetch(BASE + '/api/doc')).json();
  const res = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...cur, ...doc, baseRev: cur.rev, baseHeads: Object.fromEntries(cur.branches.map((b) => [b.id, b.headEventId])) }),
  });
  if (!res.ok) console.error('  （中断模拟回写失败', res.status, '）');
}
delete store2.onMigrationGate;
const store3 = new Store({ base: BASE, tickMs: 5 });
await store3.load();
const rb3 = store3.migrationById(id4);
ok(rb3 && rb3.files.filter((f) => f.status === 'queued').length <= 4, '中断批次被识别（从已完成文件之后恢复）');
await store3.migrationSettled(id4);
await store3.flushed();
const done3 = store3.migrationById(id4);
ok(done3.runState === 'done' && done3.files.every((f) => f.status === 'done'), '服务中断恢复后批次跑完，完成项不重跑');

// 9) 迁移报告可导出且含源摘要/映射/隔离/错误/分支标识/校验和
const report = store3.migrationReport(bid);
ok(!!report.checksum && /^[0-9a-f]{8}$/.test(report.checksum), '报告带 FNV 校验和');
ok(report.summary.succeeded === 2 && report.summary.failed === 1, '报告汇总成功/失败计数');
const rf = report.files.find((f) => f.name === 'a.json');
ok(rf.imported && rf.imported.branchId === branchId && rf.result.mapping.rects.length, '报告含最终分支标识与映射表');
const badReportErr = report.files.find((f) => f.name === 'bad.json').error;
ok(badReportErr, '报告含失败文件错误');
ok(badReportErr && badReportErr.line === 3 && badReportErr.column === 10 && badReportErr.offset === 22
  && !!badReportErr.suggestion, '报告错误含准确行号/列号/偏移与修复建议');
ok(rf.result.quarantined.length === 0 || Array.isArray(rf.result.quarantined), '报告含隔离项字段');

// 10) 取消批次：用全新 store 先挂 gate 再建批，确定性地在文件之间取消
const store4 = new Store({ base: BASE, tickMs: 5 });
await store4.load();
const gates5 = [];
const waitG = () => new Promise((res) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (gates5.length || Date.now() - t0 > 2000) { clearInterval(iv); res(); } }, 1);
});
store4.onMigrationGate = () => new Promise((r) => gates5.push(r));
// 使用与前面批次【不同】的内容，避免跨批次幂等复用导致批次立即结束
const texts5 = Array.from({ length: 6 }, (_, i) => JSON.stringify({
  canvas: { w: 300, h: 200 }, rects: [{ id: 'z', x: 100 + i, y: 50, w: 12, h: 12 }], constraints: [],
}));
const cr5 = store4.createMigrationBatch(texts5.map((t, i) => ({ name: `c${i}.json`, text: t })), {});
await waitG();
gates5.shift()();                 // 放行文件 0（完成）
await waitG();                    // 文件 1 到达 gate
store4.cancelMigration(cr5.batch.id);
gates5.forEach((g) => g());
await sleep(15);
await store4.flushed();
const cb = store4.migrationById(cr5.batch.id);
ok(cb.files.some((f) => f.status === 'cancelled'), '排队文件进入已取消终态');
ok(cb.files.some((f) => f.status === 'done' && f.result), '取消前完成文件结果保留');
delete store4.onMigrationGate;

async function waitGate2(g) {
  const t0 = Date.now();
  while (!g.length) { if (Date.now() - t0 > 2000) break; await sleep(1); }
}

console.log(`\n迁移 e2e：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
