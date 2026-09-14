// 端到端冒烟：编辑分支三方合并经真实 HTTP 后端存取。
// 用法：先启动 server（并 POST /api/reset），再 node test/e2e-merges.mjs
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

const { Store } = await import('../web/js/geom/store.js');
const { newRect, newSnap, newMinGap } = await import('../web/js/geom/model.js');

const BASE = 'http://127.0.0.1:8080';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

await fetch(BASE + '/api/reset', { method: 'POST' });

const s = new Store({ base: BASE });
await s.load();
s.setActor('合并员');
ok(s.model.rects.length === 4, '种子文档加载');

// 分叉：main 加一个矩形后 fork 来源分支
s.commit((m) => m.rects.push(newRect(330, 300, 80, 60, '共同新矩形')), { label: '分叉点' });
const commonId = s.model.rects.find((r) => r.name === '共同新矩形').id;
const forkBase = s.branch.headEventId;
const fk = s.forkFromEvent(forkBase, 'E2E 来源分支');
const sourceId = fk.branch.id;
await s.flushed(); // 确保新分支（fork-root）已被服务端确认，再在来源分支上提交

// 来源：新增一个来源专属矩形，并把共同矩形改名（在来源分支上）
s.commit((m) => {
  m.rects.push(newRect(120, 150, 60, 60, '来源专属'));
  m.rects.find((r) => r.id === commonId).name = '共同(来源改名)';
}, { label: '来源编辑' });
await s.flushed(); // 先确保来源分支提交落盘，再切回目标分支（避免在飞保存误判分支前进）

// 目标：新增另一个矩形，并把共同矩形改成另一个名字（制造一个冲突）
s.switchBranch('main');
s.commit((m) => {
  m.rects.push(newRect(520, 150, 60, 60, '目标专属'));
  m.rects.find((r) => r.id === commonId).name = '共同(目标改名)';
}, { label: '目标编辑' });
await s.flushed();

// 打开合并草案
const opened = s.openMergeDraft('main', sourceId);
ok(opened.ok, '打开合并草案');
ok(opened.plan.counts.auto >= 2, `自动项 ≥2（实际 ${opened.plan.counts.auto}）`);
ok(opened.plan.counts.conflicts === 1, `冲突 1 项（实际 ${opened.plan.counts.conflicts}）`);
const draftId = opened.draft.id;

// 未解决不能完成
const blocked = await s.commitMerge(draftId);
ok(!blocked.ok && blocked.reason === 'merge-blocked', '未解决冲突时阻止完成');

// 共同矩形冲突：手动填写一个新名字
const rc = opened.plan.rects.conflicts[0];
const res = s.setMergeResolution(draftId, 'rect:' + rc.id, 'manual',
  { id: rc.id, name: '共同(合并手动命名)', x: 330, y: 300, w: 80, h: 60 });
ok(res.ok, '手动填写矩形结果');

const pv = s.previewMerge(draftId);
ok(pv.ok, JSON.stringify(pv.errors || {}));
ok(pv.model.rects.some((r) => r.name === '来源专属'), '预览含来源专属矩形（自动合并）');
ok(pv.model.rects.some((r) => r.name === '目标专属'), '预览含目标专属矩形（自动合并）');
ok(pv.model.rects.some((r) => r.name === '共同(合并手动命名)'), '预览含手动命名结果');

// 完成
const cm = await s.commitMerge(draftId);
ok(cm.ok, cm.error || '合并完成');
ok(cm.event.kind === 'merge', '生成 merge 审计事件');
ok(cm.event.merge.baseEventId === forkBase, 'merge 事件记录共同祖先');
ok(cm.event.merge.sourceBranchId === sourceId, 'merge 事件记录来源关系');
ok(cm.event.merge.conflicts === 1 && cm.event.merge.auto >= 2, 'merge 元数据含自动/冲突计数');
ok(s.model.rects.some((r) => r.name === '来源专属'), '合并后画布含来源专属');
ok(s.model.rects.some((r) => r.name === '目标专属'), '合并后画布含目标专属');

// 重复提交幂等
const cm2 = await s.commitMerge(draftId);
ok(cm2.ok && cm2.idempotent && cm2.event.id === cm.event.id, '重复提交幂等，不产生重复事件');
const nMerge = s.events.filter((e) => e.kind === 'merge').length;
ok(nMerge === 1, `只有 1 条 merge 事件（实际 ${nMerge}）`);

// 来源分支未被改写
const sourceBranch = s.branches.find((b) => b.id === sourceId);
ok(sourceBranch.headEventId !== cm.event.id, '来源分支 head 未被改写');

// 合并报告：前后差异 + 逐项裁决
const report = s.mergeReportForEvent(cm.event.id);
ok(report && report.diff, '可查看合并前后差异报告');
ok(report.items.length >= 3, `报告逐项列出裁决（${report.items.length} 项）`);
ok(report.items.some((i) => i.via === 'conflict' && i.resolution === 'manual'), '报告含手动冲突裁决');
await s.flushed();

// 刷新：草案 completed、merge 事件可回放
const s2 = new Store({ base: BASE });
await s2.load();
const d = s2.mergeDraftById(draftId);
ok(d && d.status === 'completed' && d.mergeEventId === cm.event.id, '刷新后草案为 completed');
const ev = s2.eventsById.get(cm.event.id);
ok(ev.kind === 'merge' && !ev.corrupt, '刷新后 merge 事件可回放');
ok(s2.replay(cm.event.id).ok, '回放到合并事件');
ok(s2.report.hash === cm.event.hash, '回放指纹一致');
s2.exitReplay();
const rep2 = s2.mergeReportForEvent(cm.event.id);
ok(rep2 && rep2.diff, '刷新后合并报告仍可查看');

// 合并期间目标分支前进：另一页面推进 main，本页旧草案提交返回 409
const s3 = new Store({ base: BASE });
await s3.load();
// 先再造一对分叉用于前进场景
s3.commit((m) => m.rects.push(newRect(400, 400, 40, 40, '第二次分叉点')), { label: '第二次分叉点' });
const base2 = s3.branch.headEventId;
const fk2 = s3.forkFromEvent(base2, 'E2E 第二来源');
const src2 = fk2.branch.id;
s3.commit((m) => m.rects.push(newRect(80, 80, 30, 30, '第二来源矩形')), { label: '来源2' });
await s3.flushed();
s3.switchBranch('main');
const op2 = s3.openMergeDraft('main', src2);
await s3.flushed();

const other = new Store({ base: BASE });
await other.load();
other.commit((m) => m.rects.push(newRect(700, 500, 40, 40, '插入矩形')), { label: '合并期间插入' });
await other.flushed();

const rejected = await s3.commitMerge(op2.draft.id);
ok(!rejected.ok && rejected.status === 409 && rejected.reason === 'merge-target-advanced', '目标分支前进时提交返回 409');
ok(s3.events.filter((e) => e.kind === 'merge').length === 1, '409 后没有产生第二条 merge 事件');

// 更新到最新 head：旧选择保留、逐项重确认后可完成
await s3.load();
const rr = s3.refreshMergeDraftHeads(op2.draft.id);
ok(rr.ok, '更新到最新分支头');
const pv2 = s3.previewMerge(s3.activeMergeDraftId);
ok(pv2.ok, JSON.stringify(pv2.errors || {}));
ok(pv2.model.rects.some((r) => r.name === '第二来源矩形'), '更新后仍含来源改动');
ok(pv2.model.rects.some((r) => r.name === '插入矩形'), '更新后含目标新增');
const cm3 = await s3.commitMerge(s3.activeMergeDraftId);
ok(cm3.ok, cm3.error || '更新 head 后合并成功');
ok(s3.model.rects.some((r) => r.name === '第二来源矩形') && s3.model.rects.some((r) => r.name === '插入矩形'), '最终合并包含三方内容');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
