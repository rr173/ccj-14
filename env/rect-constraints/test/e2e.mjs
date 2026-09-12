// 端到端冒烟：Store 经真实 HTTP 后端存取，校验撤销/重做、环拒绝、刷新一致性。
// 用法：先启动 server，再 node test/e2e.mjs
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { Store } = await import('../web/js/geom/store.js');
const { newRect, newSnap, newMinGap, newContain, newLock } = await import('../web/js/geom/model.js');

const BASE = "http://127.0.0.1:8080";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

// 全新文档（确保 404 -> seed）
await fetch('http://127.0.0.1:8080/api/reset', { method: 'POST' });

const store = new Store({ base: BASE });
await store.load();
const seedHash = store.report.hash;
ok(store.model.rects.length === 4, `种子文档加载（4 个矩形，实际 ${store.model.rects.length}）`);
ok(store.report.conflicts.length === 0, '种子文档零冲突');
console.log('  seed hash =', seedHash);

// 1) 加矩形
const before = store.current.hash;
store.commit((m) => m.rects.push(newRect(300, 300, 100, 60, '新矩形')));
ok(store.model.rects.length === 5, '添加矩形');
ok(store.canUndo, '可以撤销');

// 2) 加贴齐约束
const A = store.model.rects[0].id, B = store.model.rects[1].id;
const r1 = store.commit((m) => m.constraints.push(newSnap(B, A, 'x', 'l', 'l', 0, 55)));
ok(r1.ok, '添加无环贴齐约束成功');

// 3) 造环：A -> B 与 B 链回 A（x 轴）
const cyc = store.commit((m) => m.constraints.push(newSnap(A, B, 'x', 'r', 'r', 0, 55)));
ok(!cyc.ok && cyc.cycle, '成环提交被拒绝');
ok(cyc.cycle.nodeIds.includes(A) && cyc.cycle.nodeIds.includes(B), '环定位到 A/B');
ok(cyc.cycle.cids.length === 2, `环上约束被列出（${cyc.cycle.cids.length} 条）`);

// 4) 制造冲突：同一矩形两条矛盾的高优先级约束
const C = store.model.rects.find((r) => r.name === '按钮组C').id;
store.commit((m) => {
  m.constraints.push(newSnap(C, A, 'x', 'l', 'l', 0, 80));
  m.constraints.push(newSnap(C, A, 'x', 'r', 'l', 0, 20));
});
const conf = store.report.conflicts;
ok(conf.length >= 1, `冲突被报告（${conf.length} 条）而非静默丢弃`);
const c0 = conf.find((c) => c.label.includes('贴齐'));
ok(c0 && c0.chain.length >= 1 && c0.blockerIds.length >= 1, '冲突链给出让步方');
console.log('  示例冲突:', c0?.label, ' <- ', c0?.chain.join(' / '));

const conflictState = { idx: store.idx, hash: store.current.hash };

// 5) undo 回到种子
while (store.canUndo) store.undo();
ok(store.current.hash === seedHash, `撤销链回到种子同 hash（${store.current.hash}）`);
ok(store.report.conflicts.length === 0, '撤销后冲突结果也恢复');
ok(store.model.rects.length === 4, '撤销恢复矩形数量');

// 6) redo 回到冲突状态
while (store.canRedo) store.redo();
ok(store.idx === conflictState.idx && store.current.hash === conflictState.hash,
  '重做恢复到冲突状态同一 hash');
ok(store.report.conflicts.length >= 1, '重做恢复冲突结果');

// 7) 模拟“刷新页面”：新建 Store 从后端重新加载（等防抖落盘）
await store.flushed?.();
const store2 = new Store({ base: BASE });
await store2.load();
ok(store2.current.hash === conflictState.hash, `刷新后当前文档 hash 一致（${store2.current.hash}）`);
ok(store2.idx === store.idx, '刷新后历史指针一致');
ok(store2.report.conflicts.length === store.report.conflicts.length, '刷新后冲突数量一致');
ok(JSON.stringify(store2.report.conflicts.map((c) => [c.cid, c.blockerIds])) ===
   JSON.stringify(store.report.conflicts.map((c) => [c.cid, c.blockerIds])), '刷新后冲突链逐字节一致');

// 8) 刷新后 undo 仍然可用且结果可重复：s2 撤销一次(→idx1)落盘；
//    s3 从 idx1 刷新加载后再撤销(→idx0)，必须等于 s2 再撤销一次的结果
store2.undo();
await store2.flushed();
const reloaded = new Store({ base: BASE });
await reloaded.load();
ok(reloaded.current.hash === store2.current.hash, '刷新后停在同一历史位置');
reloaded.undo();
store2.undo();
ok(reloaded.current.hash === store2.current.hash, '刷新后继续撤销，结果一致');

// 9) 坏文档不应炸服务
const resBad = await fetch('http://127.0.0.1:8080/api/doc', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"hello":1}',
});
ok(resBad.status === 422, `非法文档被拒（${resBad.status}）`);

// 10) 幂等：对当前模型再求解一次，hash 不变
const { solve } = await import('../web/js/geom/solver.js');
const rep2 = solve(store2.model, null);
ok(rep2.hash === store2.report.hash, '同一模型重复求解 hash 不变（确定性）');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
