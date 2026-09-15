// 端到端冒烟：影响分析与安全变更工作台经真实 HTTP 后端存取。
// 用法：先启动 server（并 POST /api/reset），再 node test/e2e-impact.mjs
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

const { Store } = await import('../web/js/geom/store.js');
const { newRect, newSnap } = await import('../web/js/geom/model.js');

const BASE = 'http://127.0.0.1:8080';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

await fetch(BASE + '/api/reset', { method: 'POST' });

const s = new Store({ base: BASE });
await s.load();
s.setActor('分析员');
ok(s.model.rects.length === 4, '种子文档加载');

// 建一条约束链：新锚点 ← 新中间 ← 新末端
s.commit((m) => {
  const a = newRect(80, 560, 100, 70, 'E锚点');
  const b = newRect(260, 560, 100, 70, 'E中间');
  const c = newRect(440, 560, 100, 70, 'E末端');
  m.rects.push(a, b, c);
  m.constraints.push(newSnap(b.id, a.id, 'x', 'l', 'r', 20, 60));
  m.constraints.push(newSnap(c.id, b.id, 'x', 'l', 'r', 20, 60));
}, { label: 'E2E 约束链' });
await s.flushed();
const id = (name) => s.model.rects.find((r) => r.name === name).id;
const anchor = id('E锚点'), mid = id('E中间'), leaf = id('E末端');

// 1) 影响分析
const pv = s.previewImpact({ kind: 'rect', id: anchor });
ok(pv.ok, '影响面预览');
ok(pv.impact.rects.some((r) => r.id === mid && r.relation === 'direct'), '中间=直接受影响');
ok(pv.impact.rects.some((r) => r.id === leaf && r.relation === 'indirect'), '末端=间接受影响');
ok(pv.impact.branches.some((b) => b.nodes.length === 3), '存在三级传播分支');

// 2) 创建带候选（移动锚点）的分析快照
const created = s.createImpactAnalysis({ kind: 'rect', id: anchor }, {
  name: 'E2E 移动锚点',
  changes: [{ kind: 'move-rect', rectId: anchor, x: 40 }],
});
ok(created.ok, created.error || '创建带候选的分析快照');
const snapId = created.snapshot.id;
ok(created.simulation.ok, '模拟通过（无环/无越界）');
const leafBefore = s.model.rects.find((r) => r.id === leaf).x;
ok(created.simulation.diff.rects.moved.length >= 3, '模拟显示链上矩形位置变化');

// 3) 应用
const applied = await s.applyImpact(snapId);
ok(applied.ok, applied.error || '应用候选变更');
ok(applied.event.kind === 'impact', '写入 impact 审计事件');
const eventId = applied.event.id;
await s.flushed();
const leafAfter = s.model.rects.find((r) => r.id === leaf).x;
ok(Math.abs((leafAfter - leafBefore) - (-40)) < 0.5, `末端随链传播 -40（Δ=${leafAfter - leafBefore}）`);
ok(s.impactById(snapId).status === 'applied', '快照标记 applied');

// 4) 重复提交幂等
const again = await s.applyImpact(snapId);
ok(again.ok && again.idempotent && again.event.id === eventId, '重复提交返回既有事件');
ok(s.events.filter((e) => e.kind === 'impact').length === 1, '只有 1 条 impact 事件');

// 5) 逐项放弃候选
const created2 = s.createImpactAnalysis({ kind: 'rect', id: anchor }, {
  changes: [
    { kind: 'move-rect', rectId: anchor, x: 10 },
    { kind: 'move-rect', rectId: mid, x: 300 },
  ],
});
ok(created2.ok && created2.snapshot.changes.length === 2, '第二张快照 2 项候选');
const dropped = s.discardImpactChange(created2.snapshot.id, created2.snapshot.changes[0].id);
ok(dropped.ok && dropped.snapshot.changes.length === 1, '逐项放弃一个候选');
await s.flushed();

// 6) 越界阻断 + 不留部分修改
const headBeforeBlock = s.branch.headEventId;
const blocked = s.createImpactAnalysis({ kind: 'rect', id: anchor }, {
  changes: [{ kind: 'move-rect', rectId: anchor, x: 995 }],
});
const blockRes = await s.applyImpact(blocked.snapshot.id);
ok(!blockRes.ok && blockRes.reason === 'impact-blocked', '越界候选被阻断');
ok(s.branch.headEventId === headBeforeBlock, '阻断时 head 不推进');

// 7) 版本冲突：模拟另一页面在同分支提交后应用旧快照
const conflictSnap = s.createImpactAnalysis({ kind: 'rect', id: leaf }, {
  changes: [{ kind: 'move-rect', rectId: leaf, x: 400 }],
});
ok(conflictSnap.ok, '创建待冲突快照');
await s.flushed();

// 直接用 HTTP 取出服务端文档，在另一 Store 上提交同分支编辑，模拟“另一页面”
const other = new Store({ base: BASE });
await other.load();
other.setActor('另一页面');
other.commit((m) => { m.rects.find((r) => r.id === mid).name = 'E中间(另一页面改)'; }, { label: '另一页面提交' });
await other.flushed();

const conflictRes = await s.applyImpact(conflictSnap.snapshot.id);
ok(!conflictRes.ok && conflictRes.status === 409 && conflictRes.reason === 'impact-branch-advanced',
  conflictRes.error || '分支前进 -> 409 版本冲突');
const snapAfter = s.impactById(conflictSnap.snapshot.id);
ok(snapAfter.status === 'open' && snapAfter.changes.length === 1, '版本冲突后候选原样保留');
ok(!!snapAfter.conflict, '冲突原因记录在快照上');
ok(s.saveConflict === null, '版本冲突不锁定整个编辑器');
ok(s.events.filter((e) => e.kind === 'impact').length === 1, '409 不追加任何 impact 事件（无部分修改）');
ok(s.model.rects.find((r) => r.id === leaf).x !== 400, '候选未被应用（叶子位置未改成 400）');
ok(s.branch.headEventId === conflictRes.headEventId, '本地跟随到对方权威 head（冲突已对齐，可继续编辑）');
await s.flushed();

// 8) 重启一致
const reborn = new Store({ base: BASE });
await reborn.load();
const rs = reborn.impactById(snapId);
ok(rs && rs.status === 'applied' && rs.appliedEventId === eventId, 'applied 快照重启后恢复');
ok(rs.report && typeof rs.report.checksum === 'string', '影响报告随文档持久化');
const ev = reborn.eventsById.get(eventId);
ok(ev && ev.kind === 'impact' && ev.impact.snapshotId === snapId, 'impact 事件重启后可回放');
ok(Math.abs(ev.model.rects.find((r) => r.id === leaf).x - leafAfter) < 0.001, '事件快照位置逐字节一致');

const openSnap = reborn.impactById(conflictSnap.snapshot.id);
ok(openSnap && openSnap.status === 'open' && openSnap.conflict, 'open 快照的冲突原因重启后保留');

// 9) 影响报告导出
const report = reborn.impactReport(snapId, { generatedAt: 1000 });
ok(report.kind === 'impact-analysis-report' && /^[0-9a-z]+$/.test(report.checksum), '影响报告带确定性校验和');
ok(report.candidates.length === 1 && report.simulation?.diff, '报告含候选与模拟差异');
const report2 = reborn.impactReport(snapId, { generatedAt: 1000 });
ok(report.checksum === report2.checksum, '同输入报告校验和逐字节一致');

// 10) applied 快照重复应用仍幂等
const idem = await reborn.applyImpact(snapId);
ok(idem.ok && idem.idempotent && idem.event.id === eventId, '重启后重复应用仍幂等');

console.log(`\n${fail === 0 ? '✅' : '❌'} e2e-impact: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
