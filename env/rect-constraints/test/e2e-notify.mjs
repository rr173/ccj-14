// 真实 HTTP 后端 e2e：审阅通知与升级中心。
// 规则多级升级与按事件×接收人幂等 / 规则修改不补发旧事件 / 确认抑制升级 /
// 确认·稍后·转交 / 断网留队列恢复按序重试不重复 / 重启后规则·队列·重试·确认·送达一致 /
// 多窗口规则 409（本地编辑保留为新修订）/ 通知项 409（本地动作保留）/ 报告导出。
// 用法：先启动 server（端口 8099）。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { Store } = await import('../web/js/geom/store.js');
const { stableStringify, exportChecksum } = await import('../web/js/geom/auditbench.js');

const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

const getDoc = async () => (await (await fetch(BASE + '/api/doc')).json());
/** 读取服务端文档、施加变更并以“当前基线”PUT（无并发，不触发 revision 冲突）。 */
async function mutateDoc(fn) {
  const doc = await getDoc();
  fn(doc);
  const res = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...doc,
      baseRev: doc.rev,
      baseHeads: Object.fromEntries(doc.branches.map((b) => [b.id, b.headEventId])),
    }),
  });
  if (res.status !== 200) throw new Error('mutateDoc failed ' + res.status + ' ' + JSON.stringify(await res.json().catch(() => ({}))));
  return res.json();
}

await fetch(BASE + '/api/reset', { method: 'POST' });

function isolatedStore() {
  const own = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (own.has(k) ? own.get(k) : null),
    setItem: (k, v) => own.set(k, v),
    removeItem: (k) => own.delete(k),
  };
  const s = new Store({ base: BASE, tickMs: 5 });
  return { store: s, restore() { globalThis.localStorage = saved; } };
}

/* ================= 主窗口：规则 / 决定 / 升级 / 幂等 ================= */

const store = new Store({ base: BASE, tickMs: 5 });
await store.load();
store.setActor('E2E甲');
const target = store.model.rects.find((r) => r.name === '卡片A').id;
for (let i = 0; i < 6; i++) store.commit((m) => { m.rects.find((x) => x.id === target).x += 12 + i * 4; }, { label: `通知前置${i}` });
await store.flushed();
const created = store.createReview('E2E 通知审阅');
await store.flushed();
const sid = created.session.id;
const nodes = created.session.nodes;
ok(nodes.length >= 6, `审阅会话含足够节点（${nodes.length}）`);

let online = true;
const sent = [];
// 测试传输通道：在线则送达并等待当前保存落定（不递归 flush 通知队列），离线则失败留队列。
store.setNotifyTransport({
  isOnline: () => online,
  send: async (it) => {
    if (!online) return { ok: false, error: '离线，保留在队列' };
    await store._waitSaveSettled();
    sent.push(it.id);
    return { ok: true, detail: '已送达' };
  },
});

const ruleRes = store.saveNotifyRule(sid, {
  name: 'E2E 升级规则',
  triggers: { decision: true, signoff: true, conflict: true, completed: true },
  levels: [
    { delayMin: 0, recipients: ['E2E甲', 'E2E乙'] },
    { delayMin: 30, recipients: ['经理'] },
  ],
});
ok(ruleRes.ok, '创建两级升级规则');
const rid = ruleRes.rule.id;
await store.flushed();

store.submitReviewDecision(sid, nodes[0].key, 'reject', 'E2E 驳回');
await store.flushed();
ok(store.notifyInbox('E2E甲').some((n) => n.title === nodes[0].title), 'L0 通知进入甲收件箱');
ok(store.notifyInbox('E2E乙').some((n) => n.title === nodes[0].title), '乙也收到 L0');
ok(!store.notifyInbox('经理').length, '经理在升级延迟前收不到');

const beforeCount = store.notifications.length;
store.pumpNotify({}); store.pumpNotify({});
ok(store.notifications.length === beforeCount, '通知按事件×级别×接收人幂等（重复 pump 无副本）');

// 规则修改不补发旧事件
store.saveNotifyRule(sid, {
  name: 'E2E 升级规则（改）', triggers: { decision: true },
  levels: [{ delayMin: 0, recipients: ['E2E甲', '新人丙'] }],
}, { editId: rid });
await store.flushed();
ok(!store.notifications.some((n) => n.recipient === '新人丙'), '旧事件不对新接收人补发');

// 确认抑制升级
const l1 = store.notifications.find((n) => n.level === 1 && n.recipient === '经理');
ok(!!l1 && l1.status === 'scheduled', '升级级别初始 scheduled');
const ackItem = store.notifyInbox('E2E甲').find((n) => n.title === nodes[0].title);
store.ackNotification(ackItem.id, 'E2E 已处理');
await store.flushed();
ok(store.notificationById(ackItem.id).status === 'acknowledged'
  && store.notificationById(ackItem.id).ackedBy === 'E2E甲', '确认记录持久化');

// 稍后提醒 / 转交（第二个节点）
store.submitReviewDecision(sid, nodes[1].key, 'pass', '');
await store.flushed();
const snoozeItem = store.notifyInbox('E2E甲').find((n) => n.title === nodes[1].title);
ok(!!snoozeItem, '第二个决定产生待处理通知');
ok(store.snoozeNotification(snoozeItem.id, 60).ok, '稍后提醒：snoozed');
ok(!store.notifyInbox('E2E甲').some((n) => n.id === snoozeItem.id), '稍后期间不在收件箱');
{
  const N = await import('../web/js/geom/notifications.js');
  const until = store.notificationById(snoozeItem.id).snoozeUntil;
  const pumped = N.pumpNotifications(store.notifications, store.notifyOutbox, { now: until + 1000 });
  store.notifications = pumped.items; store.notifyOutbox = pumped.outbox;
  ok(store.notificationById(snoozeItem.id).status === 'pending', '稍后到期后回到待处理');
}
const tr = store.transferNotification(snoozeItem.id, '代理人丁', 'E2E 转交说明');
ok(tr.ok, '转交通知');
ok(store.notificationById(snoozeItem.id).status === 'transferred', '原项进入 transferred 终态');
ok(store.notificationById(tr.newId)?.recipient === '代理人丁', '派生新通知给代理人');
await store.flushed();

/* ================= 第二窗口：断网留队列 / 恢复按序重试 ================= */

{
  const iso = isolatedStore();
  const w2 = iso.store;
  w2.online = false; // 装载即离线，避免恢复装载时已在队列的通知被自动发送
  await w2.load();
  iso.restore();
  let w2online = false;
  const w2sent = [];
  w2.setNotifyTransport({ isOnline: () => w2online, send: async (it) => { w2sent.push(it.id); return { ok: true }; } });
  w2.setActor('E2E甲');
  // 选一个主窗口还没决定的节点，窗口2决定 → 产生新通知；断网期间留队列
  const freshNode = w2.reviewSessionById(sid).nodes[2];
  w2.submitReviewDecision(sid, freshNode.key, 'pass', '窗口2决定');
  await w2.flushOutbox();
  const queuedBefore = w2.notifyOutbox.map((o) => o.notifyId);
  ok(w2.notifyOutbox.length >= 1 && w2sent.length === 0, '断网：待发送通知留在队列、未发出');
  const mine = w2.notifications.filter((n) => n.title === freshNode.title && n.status === 'pending').map((n) => n.id);
  w2online = true;
  w2.notifyOnline();
  await w2.flushOutbox();
  await w2.flushed();
  await sleep(30);
  ok(mine.every((id) => w2sent.includes(id)), '网络恢复后窗口2的新通知已发送');
  ok(w2.notifyOutbox.every((o) => mine.includes(o.notifyId)) === false || w2.notifyOutbox.length === 0,
    '窗口2新通知已离队（队列剩余与本次决定无关）');
  ok(!w2.notifyOutbox.some((o) => mine.includes(o.notifyId)), '本次离线通知不在队列中（已发送）');
  // FIFO：本次新通知的发送顺序与离线时队列中的相对顺序一致
  const sentMine = w2sent.filter((id) => mine.includes(id));
  const queuedMine = queuedBefore.filter((id) => mine.includes(id));
  ok(JSON.stringify(sentMine) === JSON.stringify(queuedMine), '按原 FIFO 顺序发送');
  const again = w2sent.length;
  await w2.flushOutbox();
  ok(w2sent.length === again, '重复 flush 不重复发送');
  await w2.flushed();
}

/* ================= 多窗口规则 409 ================= */

{
  // 两个独立窗口都基于当前服务端
  const isoA = isolatedStore();
  const wa = isoA.store;
  await wa.load();
  isoA.restore();
  const isoB = isolatedStore();
  const wb = isoB.store;
  await wb.load();
  isoB.restore();

  // 窗口A 前进规则
  const adv = wa.saveNotifyRule(sid, {
    name: '窗口A规则', triggers: { decision: true },
    levels: [{ delayMin: 0, recipients: ['E2E甲'] }],
  }, { editId: rid });
  ok(adv.ok, '窗口A推进规则');
  await wa.flushed();

  // 窗口B 基于旧 rev 改同一规则（本地乐观接受），保存被 409
  const stale = wb.saveNotifyRule(sid, {
    name: '窗口B本地名', triggers: { decision: true },
    levels: [{ delayMin: 0, recipients: ['窗口B接收人'] }],
  }, { editId: rid });
  ok(stale.ok, '窗口B本地先乐观接受规则编辑');
  await wb.flushed();
  await sleep(50);
  ok(wb.notifyConflict?.reason === 'notify-rule-advanced', '窗口B收到规则 409 notify-rule-advanced');
  ok(wb._notifyLockedRules.has(rid), '冲突规则被锁定');
  ok(!!wb.notifyRuleDrafts(rid), '窗口B本地规则编辑保留为草稿');
  // 几何编辑不被通知锁拦截
  const geo = wb.commit((m) => { m.rects.find((x) => x.id === target).x += 5; }, { label: '规则冲突期间几何' });
  ok(geo.ok, '规则冲突期间几何保存不被拦截');
  // 采用本地：作为新修订提交
  const reapply = wb.reapplyNotifyRuleDraft(rid);
  ok(reapply.ok, '采用本地规则编辑作为新修订');
  await wb.flushed();
  await sleep(30);
  ok(!wb._notifyLockedRules.has(rid), '重提成功后解锁');
  const finalDoc = await getDoc();
  const finalRule = finalDoc.notifyRules.find((x) => x.id === rid);
  ok(finalRule.name === '窗口B本地名' && finalRule.levels[0].recipients.includes('窗口B接收人'),
    '服务端采纳窗口B本地修订（更高 rev）');
}

/* ================= 多窗口通知项 409（同一通知两人处理） ================= */

{
  await sleep(300); // 等前序各窗口的在飞保存全部落定，避免与本次离线决定竞争同一文档 rev
  // 窗口P：全新加载，离线产生一个待处理通知；若与其他窗口保存竞争而 409，重载重提
  let wpOnline = false;
  const makeOfflineWindow = () => {
    const iso = isolatedStore();
    const w = iso.store;
    w.online = false;
    return { w, restore: iso.restore };
  };
  let wpPkg = makeOfflineWindow();
  let wp = wpPkg.w;
  await wp.load();
  wpPkg.restore();
  wp.setNotifyTransport({ isOnline: () => wpOnline, send: async () => ({ ok: false, error: '离线' }) });
  wp.setActor('E2E甲');
  let pendingNode = nodes.find((n) => wp.reviewSessionById(sid).nodes.every((x) => x.key !== n.key || x.decision === 'pending'));
  let decision = wp.submitReviewDecision(sid, pendingNode.key, 'review', '待复核');
  await wp.flushed();
  for (let attempt = 0; attempt < 3 && decision.status === 409; attempt++) {
    wpPkg = makeOfflineWindow();
    wp = wpPkg.w;
    await wp.load();
    wpPkg.restore();
    wp.setNotifyTransport({ isOnline: () => wpOnline, send: async () => ({ ok: false, error: '离线' }) });
    wp.setActor('E2E甲');
    pendingNode = nodes.find((n) => wp.reviewSessionById(sid).nodes.every((x) => x.key !== n.key || x.decision === 'pending'));
    if (!pendingNode) break;
    decision = wp.submitReviewDecision(sid, pendingNode.key, 'review', '待复核');
    await wp.flushed();
  }
  ok(!!pendingNode && decision.ok, `窗口P离线产生待处理决定（${decision.status} ${decision.reason || ''}）`);
  const anyPending = wp.notifications.find((n) => n.title === pendingNode.title && n.status === 'pending');
  const sharedItemId = anyPending?.id;
  const sharedRecipient = anyPending?.recipient || 'E2E甲';
  // 轮询直到服务端有 pending 项（离线保存仍会把 pending 状态随文档 PUT）
  let serverHasPending = false;
  for (let i = 0; i < 25; i++) {
    if ((await getDoc()).notifications.find((x) => x.id === sharedItemId)?.status === 'pending') { serverHasPending = true; break; }
    wp._dirty = true; wp.persist(); await wp.flushed();
    await sleep(40);
  }
  const srvPending = (await getDoc()).notifications.find((x) => x.id === sharedItemId)?.status;
  ok(!!sharedItemId && serverHasPending, `产生待处理通知（服务端 pending，实际 ${srvPending}）`);

  // 窗口4 加载同一文档，抢先确认
  const iso = isolatedStore();
  const w4 = iso.store;
  w4.online = false;
  await w4.load();
  iso.restore();
  w4.online = true;
  w4.setActor(sharedRecipient);
  const theirItem = w4.notificationById(sharedItemId);
  ok(!!theirItem && theirItem.status === 'pending', '窗口4看到同一待处理通知');
  w4.ackNotification(sharedItemId, '窗口4抢先确认');
  await w4.flushed();
  for (let i = 0; i < 20; i++) {
    if ((await getDoc()).notifications.find((x) => x.id === sharedItemId)?.status === 'acknowledged') break;
    await sleep(30);
  }
  ok(!w4.notifyConflict, '窗口4确认成功（无冲突）');

  // 窗口P 恢复在线并尝试转交 → 本地乐观，保存被 409 拒绝并保留草稿
  wpOnline = true;
  wp.online = true;
  wp.setNotifyTransport({ isOnline: () => wpOnline, send: async () => ({ ok: true }) });
  const res = wp.transferNotification(sharedItemId, '临时接手人', '本地转交');
  ok(res.ok, '窗口P本地先乐观应用转交');
  await wp.flushed();
  for (let i = 0; i < 30 && wp.notifyConflict?.reason !== 'notify-item-advanced'; i++) {
    await sleep(40);
    if (wp.notifyConflict?.reason !== 'notify-item-advanced') {
      wp._dirty = true; wp.persist(); await wp.flushed();
    }
  }
  ok(wp.notifyConflict?.reason === 'notify-item-advanced', '窗口P收到通知项 409 notify-item-advanced');
  if (globalThis.__NDBG) {
    console.log('NDBG drafts', wp.notifyItemDrafts(sharedItemId).map((d) => d.action), 'status', wp.notificationById(sharedItemId)?.status, 'locked', [...wp._notifyLockedItems].map((x) => x === sharedItemId), 'logKeys', [...wp._notifyOptimisticLog.keys()].length, 'pendingKeys', [...wp._notifyPendingItemActions.keys()].length, 'infoItem?', !!wp.notifyConflict.serverStatus);
  }
  ok(wp.notifyItemDrafts(sharedItemId).some((d) => d.action === 'transfer' && d.payload.to === '临时接手人'),
    '窗口P本地转交动作保留为草稿');
  ok(wp.notificationById(sharedItemId)?.status === 'acknowledged', '原项回滚为服务端权威（窗口4已确认）');
}

/* ================= 重启一致性 ================= */

{
  const iso = isolatedStore();
  const w5 = iso.store;
  await w5.load();
  iso.restore();
  ok(!!w5.notifyRules.find((x) => x.id === rid), '重启后规则恢复');
  const acked = w5.notificationById(ackItem.id);
  ok(acked?.status === 'acknowledged' && acked.ackedBy === 'E2E甲', '重启后确认记录一致');
  const transferred = w5.notificationById(snoozeItem.id);
  ok(transferred?.status === 'transferred' && transferred.transferredTo === '代理人丁', '重启后转交终态一致');
  const derived = w5.notifications.find((n) => n.transferOf === snoozeItem.id);
  ok(derived?.recipient === '代理人丁', '重启后转交派生通知恢复');
  const e1 = w5.notifyEvents.length, i1 = w5.notifications.length;
  const iso2 = isolatedStore();
  const w6 = iso2.store;
  await w6.load();
  iso2.restore();
  ok(w6.notifyEvents.length === e1, `重启后通知事件数一致（${e1}）`);
  ok(w6.notifications.length === i1, `重启后通知项数一致（${i1}）`);
}

/* ================= 报告 ================= */

const report = store.notifyReport(sid, { generatedAt: 'fixed' });
ok(report.format === 'rect-constraints/notify-report', '通知报告格式标识');
ok(report.timeline.length > 0, '报告含按会话的事件时间线');
ok(report.rules.some((r) => r.id === rid), '报告含规则与修订');
const flat = report.timeline.flatMap((e) => e.notifications);
ok(flat.some((n) => n.status === 'acknowledged'), '报告含确认记录');
ok(report.delivery.total === flat.length, '报告送达统计一致');
const t1 = stableStringify(report);
ok(t1 === stableStringify(JSON.parse(JSON.stringify(report))) && /^[0-9a-f]{8}$/.test(exportChecksum(t1)), '报告导出确定 + 校验和');

/* ================= 服务端 409：规则基线落后即拒绝 ================= */

{
  const fresh = await getDoc();
  const targetRule = fresh.notifyRules.find((x) => x.id === rid);
  const body = {
    ...fresh,
    baseRev: fresh.rev,
    baseHeads: Object.fromEntries(fresh.branches.map((b) => [b.id, b.headEventId])),
    notifyRules: fresh.notifyRules.map((x) => (x.id === rid ? { ...x, name: '伪造' } : x)),
    baseNotifyRuleRevs: { [rid]: targetRule.rev - 1 },
  };
  const put = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await put.json().catch(() => ({}));
  ok(put.status === 409 && data.reason === 'notify-rule-advanced', '真实服务端 409 规则已前进（' + data.reason + '）');
  const after = await getDoc();
  ok(after.notifyRules.find((x) => x.id === rid).name !== '伪造', '409 后权威规则未被污染');
}

/* ================= 服务端 409：孤儿事件 / 缺失会话 ================= */

{
  const fresh = await getDoc();
  const body = {
    ...fresh,
    baseRev: fresh.rev,
    baseHeads: Object.fromEntries(fresh.branches.map((b) => [b.id, b.headEventId])),
    baseNotifyRuleRevs: Object.fromEntries((fresh.notifyRules || []).map((r) => [r.id, Math.max(r.rev || 0, r.deleteRev || 0)])),
    baseNotifyItemRevs: Object.fromEntries((fresh.notifications || []).map((n) => [n.id, { status: n.status, ackedAt: n.ackedAt ?? null }])),
    baseReviewRevs: Object.fromEntries((fresh.reviewSessions || []).map((x) => [x.id, x.rev])),
    notifyEvents: [...(fresh.notifyEvents || []), { id: 'ne_orphan', sessionId: 'rv_none', type: 'decision', at: 1 }],
  };
  const put = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await put.json().catch(() => ({}));
  ok(put.status === 409 && data.reason === 'notify-event-orphan', '真实服务端 409 孤儿通知事件（' + data.reason + '）');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
