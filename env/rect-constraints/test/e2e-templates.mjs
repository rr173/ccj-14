// 端到端：模板 / 实例经真实 HTTP 后端持久化与多页签草稿乐观并发。
// 用法：先启动 server 并 POST /api/reset，再 node test/e2e-templates.mjs
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};

const { Store } = await import('../web/js/geom/store.js');
const { newRect } = await import('../web/js/geom/model.js');

const BASE = 'http://127.0.0.1:8080';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

await fetch(BASE + '/api/reset', { method: 'POST' });

const s1 = new Store({ base: BASE });
await s1.load();
const byName = (store, n) => store.model.rects.find((r) => r.name === n).id;
const A = byName(s1, '卡片A'), B = byName(s1, '标签B');

// 1) 创建并发布模板（真实保存）
const created = s1.createTemplateFromSelection('E2E对齐', [A, B], { publish: true });
ok(created.ok, '创建并发布模板 v1');
const tplId = created.template.id;
await s1.flushed();

// 2) 应用到同一组槽位映射，真实保存
const v = created.template.versions[0];
const mapping = {};
for (const slot of v.slots) mapping[slot.id] = slot.label.includes('A') ? A : B;
const applied = s1.applyTemplate({ templateId: tplId, versionNo: 1, mapping });
ok(applied.ok, '应用模板成功：' + (applied.error || ''));
const insId = applied.instance.id;
await s1.flushed();

// 3) 重复应用被幂等拒绝
const dup = s1.applyTemplate({ templateId: tplId, versionNo: 1, mapping });
ok(!dup.ok && dup.duplicate, '重复应用同槽位映射被拒绝');

// 4) 发布 v2（改优先级）后升级实例
const snapKey = v.constraints.find((c) => c.kind === 'snap').key;
s1.updateTemplateDraft(tplId, (d) => { const c = d.constraints.find((x) => x.key === snapKey); c.priority = 333; c.overrides.priority.value = 333; }, 1);
const pub2 = s1.publishTemplate(tplId);
ok(pub2.ok && pub2.no === 2, '发布 v2');
await s1.flushed();
const up = s1.upgradeInstance(insId, 2);
ok(up.ok, '实例升级到 v2：' + (up.error || ''));
ok(s1.model.constraints.find((c) => c.tpl?.instanceId === insId && c.tpl.key === snapKey)?.priority === 333, '升级后约束优先级为 333');
await s1.flushed();

// 5) 第二个页面加载：模板版本、实例链接、覆盖、升级结果一致
const s2 = new Store({ base: BASE });
await s2.load();
const t2 = s2.templateById(tplId);
ok(t2 && t2.versions.length === 2, '刷新后模板有 2 个只读版本');
const ins2 = s2.instanceById(insId);
ok(ins2 && ins2.versionNo === 2, `刷新后实例在 v2（实际 ${ins2?.versionNo}）`);
ok(s2.instanceLinks().get(insId)?.status === 'linked', '刷新后实例链接状态 linked');
ok(s2.model.constraints.find((c) => c.tpl?.instanceId === insId && c.tpl.key === snapKey)?.priority === 333, '刷新后升级结果一致');

// 6) 多页签草稿乐观并发：s2 基于旧草稿 rev=2，s1 先保存 rev=3
const ed1 = s1.updateTemplateDraft(tplId, (d) => { d.slots[0].label = '页面一'; }, t2.draftRev);
ok(ed1.ok, '页面一保存草稿 rev ' + ed1.draftRev);
await s1.flushed();
const ed2 = s2.updateTemplateDraft(tplId, (d) => { d.slots[0].label = '页面二'; }, t2.draftRev);
ok(!ed2.ok && ed2.conflict, '页面二基于旧草稿保存被拒（版本冲突），本地草稿保留');
ok(s2.templateConflict?.templateId === tplId, '页面二进入模板冲突状态');
ok(s2.templateById(tplId).draft.slots[0].label === '页面一', '权威模板是页面一的版本');

// 7) 模板/实例随跨分支合流不丢失：s2 解除冲突前几何保存仍可进行（用服务端权威模板外发）
s2.commit((m) => m.rects.push(newRect(50, 600, 60, 40, '冲突页几何')), { label: '冲突页几何提交' });
await s2.flushed();
const s3 = new Store({ base: BASE });
await s3.load();
ok(s3.templateInstances.some((i) => i.id === insId), '合流后实例仍在');
ok(s3.templates.some((t) => t.id === tplId && t.versions.length === 2), '合流后模板两个版本仍在');
ok(s3.model.rects.some((r) => r.name === '冲突页几何'), '冲突页几何编辑未被模板冲突阻塞');
// 草稿仍是页面一的 rev（页面二本地草稿未覆盖）
ok(s3.templateById(tplId).draft.slots[0].label === '页面一', '本地过期草稿未覆盖对方草稿');

console.log(`\n模板 e2e：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
