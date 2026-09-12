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

// 11) 布局版本：保存 / 比较 / 恢复 / 删除保护 / 发布标记
const { compareVersions } = await import('../web/js/geom/versions.js');
const vs = new Store({ base: BASE });
await vs.load();
const sv1 = vs.saveVersion('初版');
ok(sv1.ok, '保存版本「初版」（矩形+约束+求解结果+冲突报告）');
ok(vs.currentVersionId === sv1.version.id, '保存后它成为当前版本');
ok(!vs.saveVersion('初版').ok, '同名版本被拒绝');
ok(!vs.saveVersion('   ').ok, '空名称被拒绝');

// 继续编辑：新增一对矩形 + 两条互相矛盾的约束（制造冲突），再移动锚点矩形。
// 用全新矩形做锚点/跟随者：它们没有既有约束边，保证不成环、位置不被求解器回拉。
const cr1 = vs.commit((m) => {
  const n1 = newRect(600, 480, 110, 70, '比较甲');
  const n2 = newRect(100, 480, 110, 70, '比较乙');
  m.rects.push(n1, n2);
  m.constraints.push(newSnap(n2.id, n1.id, 'x', 'l', 'l', 0, 95));
  m.constraints.push(newSnap(n2.id, n1.id, 'x', 'r', 'l', 0, 5));
});
ok(cr1.ok, '新增矩形与矛盾约束提交成功');
const anchorId = vs.model.rects.find((r) => r.name === '比较甲').id;
const existingId = vs.model.rects.find((r) => r.name === '卡片A').id;
const cr2 = vs.commit((m) => {
  const r = m.rects.find((x) => x.id === anchorId);
  r.x += 137; r.y += 49;
  const e = m.rects.find((x) => x.id === existingId);
  e.x += 60; e.y += 40; // 移动一个 sv1 中已存在的矩形，供 moved 检出
});
ok(cr2.ok, '移动锚点矩形提交成功');
const sv2 = vs.saveVersion('第二版');
ok(sv2.ok, '保存版本「第二版」');

const diff = vs.compareById(sv1.version.id, sv2.version.id);
ok(diff.rects.moved.some((x) => x.id === existingId), '比较检出矩形位置变化');
ok(diff.rects.added.length === 2, `比较检出新增矩形（${diff.rects.added.length} 个）`);
ok(diff.constraints.added.length === 2, `比较检出新增约束（${diff.constraints.added.length} 条）`);
ok(diff.conflicts.after > diff.conflicts.before, `比较检出冲突数量变化（${diff.conflicts.before} → ${diff.conflicts.after}）`);
ok(diff.conflicts.newUnmet.length >= 1, '比较检出新增未满足项');

// 恢复初版：成为新的当前编辑版本，原版本只读不变
const v1Hash = sv1.version.hash;
ok(vs.restoreVersion(sv1.version.id).ok, '恢复「初版」成功');
ok(vs.currentVersionId === sv1.version.id, '恢复后当前版本指向「初版」');
ok(vs.current.hash === v1Hash, '恢复后的解与版本快照逐字节一致（确定性）');
ok(vs.versions.find((v) => v.id === sv1.version.id).hash === v1Hash, '原版本未被改写');
ok(vs.canUndo, '恢复本身可撤销');

// 删除保护：当前版本 / 已发布版本
ok(!vs.deleteVersion(sv1.version.id).ok, '当前版本不能删除');
vs.setPublished(sv2.version.id, true);
ok(!vs.deleteVersion(sv2.version.id).ok, '已发布版本不能删除');
vs.setPublished(sv2.version.id, false);
vs.setCompare(sv1.version.id, sv2.version.id);
ok(vs.deleteVersion(sv2.version.id).ok, '取消发布后可删除');
ok(vs.compare.b === null, '被删版本从比较选择中移除');

// 再编辑并存第三版（带发布标记），固定比较对后落盘
vs.commit((m) => m.rects.push(newRect(700, 100, 100, 70, '第三版矩形')));
const n3id = vs.model.rects.find((r) => r.name === '第三版矩形').id;
vs.commit((m) => { const r = m.rects.find((x) => x.id === n3id); r.x += 88; r.y += 44; });
const sv3 = vs.saveVersion('第三版');
vs.setPublished(sv3.version.id, true);
vs.setCompare(sv1.version.id, sv3.version.id);
await vs.flushed();

// 12) 刷新一致性：版本列表 / 当前版本 / 发布标记 / 比较选择与比较结果
const reload1 = new Store({ base: BASE });
await reload1.load();
ok(reload1.versions.length === vs.versions.length, `刷新后版本列表一致（${reload1.versions.length} 个）`);
ok(reload1.currentVersionId === vs.currentVersionId, '刷新后当前版本一致');
ok(reload1.versions.find((v) => v.id === sv3.version.id)?.published === true, '刷新后发布标记一致');
ok(reload1.compare.a === sv1.version.id && reload1.compare.b === sv3.version.id, '刷新后比较选择一致');
ok(JSON.stringify(reload1.compareById(sv1.version.id, sv3.version.id)) ===
   JSON.stringify(vs.compareById(sv1.version.id, sv3.version.id)), '刷新后比较结果逐字节一致');
ok(!reload1.deleteVersion(sv3.version.id).ok, '刷新后已发布版本仍不能删除');

// 13) 并发：两个页面基于同一版本编辑，旧页面保存必须冲突且不覆盖
const page1 = new Store({ base: BASE });
await page1.load();
const page2 = new Store({ base: BASE });
await page2.load();
ok(page1.rev === page2.rev, '两个页面基于同一服务端版本号');

page1.commit((m) => m.rects.push(newRect(50, 550, 90, 60, '页面1的矩形')));
await page1.flushed();
ok(!page1.saveConflict, '页面1 保存成功');

page2.commit((m) => m.rects.push(newRect(850, 550, 90, 60, '页面2的矩形')));
await page2.flushed();
ok(page2.saveConflict === true, '页面2 的旧版本提交被检测为版本冲突');
ok(page2.model.rects.some((r) => r.name === '页面2的矩形'), '页面2 的本地修改仍保留（未丢失）');

const check = new Store({ base: BASE });
await check.load();
ok(check.model.rects.some((r) => r.name === '页面1的矩形'), '服务器保留页面1的内容');
ok(!check.model.rects.some((r) => r.name === '页面2的矩形'), '页面2的提交没有覆盖服务器');
ok(check.rev === page1.rev, '服务器版本号只被页面1推进');

// 14) 原始 HTTP：过期 baseRev 返回 409，缺少 baseRev 返回 422
const curDoc = await (await fetch(BASE + '/api/doc')).json();
ok(Number.isFinite(curDoc.rev), 'GET 返回文档版本号');
const stale = await fetch(BASE + '/api/doc', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...curDoc, baseRev: curDoc.rev - 1 }),
});
ok(stale.status === 409, `过期 baseRev 被服务器拒绝（${stale.status}）`);
const staleBody = await stale.json();
ok(staleBody.rev === curDoc.rev, '409 响应带回当前版本号');
const noRev = await fetch(BASE + '/api/doc', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ entries: curDoc.entries, idx: curDoc.idx }),
});
ok(noRev.status === 422, `缺少 baseRev 的提交被拒（${noRev.status}）`);
const goodPut = await fetch(BASE + '/api/doc', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...curDoc, baseRev: curDoc.rev }),
});
ok(goodPut.status === 200, '正确 baseRev 保存成功');
const afterDoc = await (await fetch(BASE + '/api/doc')).json();
ok(afterDoc.rev === curDoc.rev + 1, '保存后版本号 +1');
ok(afterDoc.versions.length === curDoc.versions.length, '版本列表在保存后保持');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
