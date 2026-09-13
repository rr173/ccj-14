// 真实 HTTP 后端 e2e：实验建立/批量求解/持久化/刷新一致/幂等/暂停继续取消/
// 损坏容忍/另存分支/服务端结构校验。用法：先启动 server（8099）。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { Store } = await import('../web/js/geom/store.js');
const { newRect } = await import('../web/js/geom/model.js');

const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

await fetch(BASE + '/api/reset', { method: 'POST' });

const store = new Store({ base: BASE, tickMs: 5 });
await store.load();
const target = store.model.rects.find((r) => r.name === '锁定D').id;
const A = store.model.rects.find((r) => r.name === '卡片A').id;

// 1) 建立 + 批量运行 + 完整产物落盘
const cr = store.createExperiment([
  { name: '方案一', rects: [{ id: target, x: 100, y: 100 }] },
  { name: '方案二', rects: [{ id: target, x: 300, y: 200, w: 80, h: 80 }] },
  { name: '空对照' },
], { name: 'HTTP 实验' });
ok(cr.ok && !cr.idempotent, '建立实验并开始批量求解');
const expId = cr.experiment.id;
await store.experimentSettled(expId);
await store.flushed();
const exp = store.experimentById(expId);
ok(exp.runState === 'done', '实验完成');
ok(exp.variants.every((v) => v.status === 'done'), '全部变体完成');
ok(exp.variants[0].result.report.rects[target].x === 100, '变体位置正确');
ok(exp.variants[0].result.conflicts !== undefined && exp.variants[0].result.hash, '结果含冲突链与指纹');

// 2) 幂等
const again = store.createExperiment([
  { rects: [{ id: target, x: 100, y: 100 }] },
  { rects: [{ id: target, x: 300, y: 200, w: 80, h: 80 }] },
  {},
], { name: '另一个名字' });
ok(again.idempotent && again.experiment.id === expId, '相同配置重复提交幂等，返回同一实验');

// 3) 刷新后定义/顺序/结果一致
const store2 = new Store({ base: BASE, tickMs: 5 });
await store2.load();
const e2 = store2.experiments.find((x) => x.id === expId);
ok(!!e2 && e2.variants.length === 3, '刷新后实验与变体顺序一致');
ok(e2.variants.map((v) => v.result.hash).join() === exp.variants.map((v) => v.result.hash).join(),
  '刷新后完成结果指纹逐字节一致');

// 4) 暂停 / 继续 / 取消（跨刷新）
const cr2 = store2.createExperiment(
  Array.from({ length: 6 }, (_, i) => ({ name: `v${i}`, rects: [{ id: target, y: 60 + i * 30 }] })),
  { name: '暂停取消实验' },
);
ok(cr2.ok, '建立第二个实验（6 变体）');
store2.pauseExperiment(cr2.experiment.id);
await sleep(30);
const paused = store2.experimentById(cr2.experiment.id);
ok(paused.runState === 'paused', '实验已暂停');
await store2.flushed();

const store3 = new Store({ base: BASE, tickMs: 5 });
await store3.load();
const e3 = store3.experiments.find((x) => x.id === cr2.experiment.id);
ok(e3.runState === 'paused', '刷新后暂停状态保持');
const queuedAtPause = e3.variants.filter((v) => v.status === 'queued').length;
ok(queuedAtPause >= 1, '刷新后排队列状态保持');
store3.resumeExperiment(e3.id);
await sleep(20);
const cancelling = store3.experimentById(e3.id);
const doneBeforeCancel = cancelling.variants.filter((v) => v.status === 'done').length;
store3.cancelExperiment(e3.id);
await store3.flushed();
const e3b = store3.experimentById(e3.id);
ok(e3b.runState === 'cancelled', '取消后实验为已取消');
ok(e3b.variants.some((v) => v.status === 'cancelled'), '排队变体被取消');
ok(e3b.variants.filter((v) => v.status === 'done').length === doneBeforeCancel
  && e3b.variants.filter((v) => v.status === 'done').every((v) => v.result), '取消前完成结果保留不覆盖');

// 5) 损坏变体容忍：篡改服务端文档里某变体结果
await store3.flushed();
let doc = await (await fetch(BASE + '/api/doc')).json();
const targetExp = doc.experiments.find((x) => x.id === expId);
const badVariant = targetExp.variants[1];
const goodHash = badVariant.result.hash;
badVariant.result.model.rects.find((r) => r.id === target).x += 53; // 改结果模型，保留 hash
const put = await fetch(BASE + '/api/doc', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...doc, baseRev: doc.rev, baseHeads: Object.fromEntries(doc.branches.map((b) => [b.id, b.headEventId])) }),
});
ok(put.ok, '含实验的文档保存成功（HTTP ' + put.status + '）');

const store4 = new Store({ base: BASE, tickMs: 5 });
await store4.load();
const e4 = store4.experiments.find((x) => x.id === expId);
ok(e4.variants[1].corrupt, '损坏变体被明确标出无法回放');
ok(e4.variants[1].status === 'done', '损坏变体记录保留');
ok(!e4.variants[0].corrupt && e4.variants[0].result.hash === exp.variants[0].result.hash, '其余变体仍可查看');
ok(!!store4.experimentWarnings.find((w) => new RegExp(e4.variants[1].name).test(w.text)), '健康检查明确警告');

// 6) 好变体另存为新分支（实验来源）
const fk = store4.forkExperimentVariant(expId, e4.variants[0].id, 'E2E 实验胜出方案');
ok(fk.ok, '完成变体另存为新分支');
ok(fk.event.provenance.kind === 'experiment' && fk.event.provenance.experimentId === expId, '分支保留实验来源关系');
ok(fk.event.hash === exp.variants[0].result.hash, '新分支起点与变体结果同指纹');
ok(store4.branch.experimentSource.experimentId === expId, '分支带 experimentSource');
store4.commit((m) => m.rects.push(newRect(50, 50, 40, 40, '分支续点')));
await store4.flushed();

// 实验结果未被改写
const e4b = store4.experiments.find((x) => x.id === expId);
ok(e4b.variants[0].result.hash === exp.variants[0].result.hash, '另存分支后实验结果未被改写');

// 7) 与基准比较
const d = store4.diffVariant(expId, e4.variants[0].id);
ok(!!d && d.rects.moved.some((r) => r.id === target), '可查看变体与基准的矩形差异');
ok(store4.diffVariant(expId, e4.variants[1].id) === null, '损坏变体不能比较');

// 8) 服务端结构校验：坏实验文档被拒
doc = await (await fetch(BASE + '/api/doc')).json();
const badDoc = { ...doc, experiments: [{ id: 'x', name: '坏' }], baseRev: doc.rev };
const rej = await fetch(BASE + '/api/doc', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badDoc) });
ok(rej.status === 422, '缺 baseModel/variants 的实验文档被服务端拒绝（' + rej.status + '）');

// 9) 重启最终一致性：所有实验/变体/分支仍在
const store5 = new Store({ base: BASE, tickMs: 5 });
await store5.load();
ok(store5.experiments.length === 2, '重启后全部实验仍在（' + store5.experiments.length + '，重复提交幂等未产生副本）');
ok(store5.branches.some((b) => b.name === 'E2E 实验胜出方案' && b.experimentSource?.experimentId === expId),
  '重启后实验来源分支保持');
const order = store5.experiments.find((x) => x.id === expId).variants.map((v) => v.name);
ok(order.join() === exp.variants.map((v) => v.name).join(), '结果顺序重启后一致');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
