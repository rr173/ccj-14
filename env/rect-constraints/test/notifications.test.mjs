// 审阅通知与升级中心：事件派生（决定/签署/冲突/完成）/ 规则与多级升级 /
// 按事件×级别×接收人幂等物化 / 规则修改不补发旧事件 / 确认抑制升级 /
// 确认·稍后·转交·重发 / 断网队列 FIFO 与退避重试（幂等）/ 重启确定性重建 /
// 跨窗口乐观冲突（规则 rev、通知项状态）/ 跨分支合流 / 时间线报告。
import { test as rawTest } from 'node:test';
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

const pendingTimers = new Set();
const _setTimeout = globalThis.setTimeout;
const _setInterval = globalThis.setInterval;
const _clearTimeout = globalThis.clearTimeout;
const _clearInterval = globalThis.clearInterval;
globalThis.setTimeout = (fn, ms, ...args) => { const id = _setTimeout(fn, ms, ...args); pendingTimers.add(id); return id; };
globalThis.setInterval = (fn, ms, ...args) => { const id = _setInterval(fn, ms, ...args); pendingTimers.add(id); return id; };
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); return _clearTimeout(id); };
globalThis.clearInterval = (id) => { pendingTimers.delete(id); return _clearInterval(id); };

const { Store } = await import('../web/js/geom/store.js');
const N = await import('../web/js/geom/notifications.js');
const {
  createRule, editRule, normalizeRule, syncNotifyEvents, materializeNotifications,
  pumpNotifications, recordDeliveryAttempt, acknowledgeNotification, snoozeNotification,
  transferNotification, retryNotification, sanitizeNotifyEvents, sanitizeRules,
  sanitizeNotifications, sanitizeOutbox, mergeRules, mergeNotifyEvents, mergeNotifications,
  mergeOutbox, assessServerNotifyConflict, buildNotifyReport, notifyItemId, outboxItemId,
  mergeBatches, mergeDrafts,
  MAX_ATTEMPTS,
  normalizeSchedule, nextOpenAt, readyAtFor, scheduleIsOpenAt, minuteOfWeek,
  applyBatchNotifications, makeBatchRecord, sanitizeBatches, makeDraft, sanitizeDrafts,
  WEEK_MIN,
} = N;
const { stableStringify, exportChecksum, filterNodes } = await import('../web/js/geom/auditbench.js');
const { mergeDocs } = await import('../web/js/geom/audit.js');

// 简化内存服务端：复用 JS 版同构判定（真实 HTTP 语义在 e2e-notify.mjs 复验）
const reviewsMod = await import('../web/js/geom/reviews.js');
function makeServer() {
  let gen = 0;
  let serverDoc = null;
  const fetchImpl = (url, opts = {}) => {
    const myGen = gen;
    const method = opts.method || 'GET';
    const jsonOk = (obj) => ({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(obj)) });
    if (method === 'GET') {
      if (myGen !== gen || !serverDoc) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(jsonOk(serverDoc));
    }
    if (method === 'PUT') {
      if (myGen !== gen) return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) });
      const body = JSON.parse(opts.body);
      const curRev = serverDoc?.rev ?? 0;
      const reject = (info) => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ rev: curRev, ...info }) });
      // 审阅冲突优先，其次通知冲突
      const rc = reviewsMod.assessServerReviewConflict(serverDoc, body);
      if (rc) return reject({ error: 'review-conflict', ...rc });
      const nc = assessServerNotifyConflict(serverDoc, body);
      if (nc) return reject({ error: 'notify-conflict', ...nc });
      if (body.baseRev !== curRev) {
        if (!serverDoc) {
          const doc = { ...body, rev: 1 };
          for (const k of ['baseRev', 'baseHeads', 'baseReviewRevs', 'baseNotifyRuleRevs', 'baseNotifyItemRevs', 'notifyOutboxTombstones']) delete doc[k];
          serverDoc = doc; return Promise.resolve(jsonOk({ ok: true, rev: 1 }));
        }
        const tombs = Array.isArray(body.notifyOutboxTombstones) ? body.notifyOutboxTombstones : [];
        const merged = mergeDocs(serverDoc, body);
        merged.reviewSessions = reviewsMod.mergeReviewSessions(serverDoc.reviewSessions || [], body.reviewSessions || []);
        merged.notifyEvents = mergeNotifyEvents(serverDoc.notifyEvents || [], body.notifyEvents || []);
        merged.notifyRules = mergeRules(serverDoc.notifyRules || [], body.notifyRules || []);
        merged.notifications = mergeNotifications(serverDoc.notifications || [], body.notifications || []);
        merged.notifyOutbox = mergeOutbox(serverDoc.notifyOutbox || [], body.notifyOutbox || [], tombs);
        merged.notifyBatches = mergeBatches(serverDoc.notifyBatches || [], body.notifyBatches || []);
        merged.notifyDrafts = mergeDrafts(serverDoc.notifyDrafts || [], body.notifyDrafts || []);
        merged.rev = curRev + 1;
        for (const k of ['baseRev', 'baseHeads', 'baseReviewRevs', 'baseNotifyRuleRevs', 'baseNotifyItemRevs', 'notifyOutboxTombstones']) delete merged[k];
        serverDoc = merged;
        return Promise.resolve(jsonOk({ ok: true, rev: merged.rev, merged: true, doc: merged }));
      }
      const doc = { ...body, rev: curRev + 1 };
      for (const k of ['baseRev', 'baseHeads', 'baseReviewRevs', 'baseNotifyRuleRevs', 'baseNotifyItemRevs', 'notifyOutboxTombstones']) delete doc[k];
      // 直存：客户端即权威，仅按其墓碑兜底过滤
      const tombs = new Set(Array.isArray(body.notifyOutboxTombstones) ? body.notifyOutboxTombstones : []);
      if (tombs.size && Array.isArray(doc.notifyOutbox)) doc.notifyOutbox = doc.notifyOutbox.filter((o) => !tombs.has(o.id));
      serverDoc = doc;
      return Promise.resolve(jsonOk({ ok: true, rev: doc.rev }));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return {
    fetchImpl,
    nextGen() { gen++; },
    clear() { serverDoc = null; gen++; },
    get doc() { return serverDoc; },
    set doc(v) { serverDoc = v; },
  };
}

const harness = makeServer();
activeFetch = harness.fetchImpl;

const freshStore = async () => {
  for (const id of pendingTimers) _clearInterval(id) || _clearTimeout(id);
  pendingTimers.clear();
  mem.clear();
  harness.clear();
  const s = new Store({ base: '', tickMs: 1 });
  s._startNotifyTicker = () => {}; // 单元测试不跑真实定时器
  await s.load();
  return s;
};
const sleep = (ms) => new Promise((r) => _setTimeout(r, ms));

async function fixture() {
  const s = await freshStore();
  s.setActor('甲');
  s.commit((m) => { m.rects[0].x += 10; }, { label: '编辑一' });
  s.commit((m) => { m.rects[0].x += 10; }, { label: '编辑二' });
  await s.flushed();
  const created = s.createReview('通知用审阅');
  await s.flushed();
  return { s, sid: created.session.id, session: created.session };
}

const twoLevels = () => ([
  { delayMin: 0, recipients: ['甲', '乙'] },
  { delayMin: 30, recipients: ['经理丙'] },
]);

/* ---------- 事件派生 ---------- */

test('决定/完成事件从审阅状态确定性派生，按 id 幂等', async () => {
  const { s, sid } = await fixture();
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  let events = syncNotifyEvents([], s.reviewSessions).events;
  assert.ok(events.some((e) => e.type === 'decision' && e.nodeKey === node.key && e.decision === 'pass'));
  // 再派生一次：同一决定不产生副本
  const again = syncNotifyEvents([], s.reviewSessions).events;
  assert.equal(again.length, events.length);
  assert.deepEqual(again.map((e) => e.id), events.map((e) => e.id));
  // 全部节点通过 → 完成事件
  for (const n of s.activeReview.nodes) {
    if (n.key !== node.key) s.submitReviewDecision(sid, n.key, 'pass', '');
  }
  s.completeReview(sid);
  events = syncNotifyEvents(events, s.reviewSessions).events;
  assert.ok(events.some((e) => e.type === 'session-completed'));
});

test('多人签署：每条有效签名一个 signature 事件，达人数产生 node-confirmed', async () => {
  const s = await freshStore();
  s.setActor('甲');
  s.commit((m) => { m.rects[0].x += 5; }, { label: '编辑' });
  const policy = { mode: 'signoff', signers: ['甲', '乙'], required: 2, completeRule: 'all-decided' };
  const { session } = s.createReview('多人', { policy });
  const sid = session.id; const key = session.nodes[0].key;
  s.submitReviewSignature(sid, key, 'pass', '甲签');
  let ev = syncNotifyEvents([], s.reviewSessions).events;
  assert.ok(ev.some((e) => e.type === 'signature' && e.actor === '甲'));
  assert.ok(!ev.some((e) => e.type === 'node-confirmed'));
  s.setActor('乙');
  s.submitReviewSignature(sid, key, 'pass', '乙签');
  ev = syncNotifyEvents(ev, s.reviewSessions).events;
  const confirmed = ev.filter((e) => e.type === 'node-confirmed');
  assert.equal(confirmed.length, 1);
  // 幂等：重复派生不增加
  assert.equal(syncNotifyEvents(ev, s.reviewSessions).events.length, ev.length);
});

test('节点冲突（系统转待复核）派生 conflict 事件', async () => {
  const { s, sid } = await fixture();
  // 直接构造一个 autoReview 节点来验证派生
  const sess = s.reviewSessionById(sid);
  const node = sess.nodes[0];
  const tampered = { ...sess, nodes: sess.nodes.map((n) => n.key === node.key ? { ...n, autoReview: { code: 'corrupt', codes: ['corrupt'], reason: '损坏', at: 12345 } } : n) };
  const ev = syncNotifyEvents([], [tampered]).events;
  const c = ev.filter((e) => e.type === 'conflict' && e.nodeKey === node.key);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].codes, ['corrupt']);
});

/* ---------- 规则 ---------- */

test('规则规范化：去重接收人、剔除空级别、缺省触发器全开', () => {
  const r = normalizeRule({
    sessionId: 'x',
    levels: [{ delayMin: 0, recipients: ['甲', '甲', ' 乙 '] }, { delayMin: 10, recipients: [] }],
  });
  assert.deepEqual(r.levels[0].recipients, ['甲', '乙']);
  assert.equal(r.levels.length, 1);
  assert.deepEqual(Object.values(r.triggers), [true, true, true, true]);
});

test('编辑规则推进 rev 并更新 revisedAt 水位；启停不推进 rev', async () => {
  const { s, sid } = await fixture();
  const r = s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: twoLevels() }).rule;
  const rev0 = r.rev;
  const edited = editRule(r, { triggers: { decision: false, conflict: true } }, { now: r.createdAt + 1000 });
  assert.equal(edited.rev, rev0 + 1);
  assert.ok(edited.revisedAt > r.revisedAt);
  const toggled = editRule(edited, { enabled: false });
  assert.equal(toggled.rev, edited.rev);
  assert.equal(toggled.enabled, false);
  assert.equal(toggled.revisedAt, edited.revisedAt);
});

/* ---------- 幂等物化 + 规则水位 ---------- */

function setupWithDecision(s, sid) {
  const node = s.activeReview.nodes[0];
  const t = Date.now();
  s.submitReviewDecision(sid, node.key, 'pass', '');
  return syncNotifyEvents([], s.reviewSessions, { now: t }).events;
}

test('通知按事件×级别×接收人幂等物化；重复物化无副本', async () => {
  const { s, sid } = await fixture();
  const events = setupWithDecision(s, sid);
  const rule = createRule({ sessionId: sid, name: 'r', levels: twoLevels(), actor: '甲', now: events[0].at - 1 });
  const m1 = materializeNotifications([], [rule], events);
  // 1 个 decision 事件 × (2 + 1) 接收人 = 3 项
  const dec = events.filter((e) => e.type === 'decision');
  assert.equal(m1.items.length, dec.length * 3);
  const m2 = materializeNotifications(m1.items, [rule], events);
  assert.equal(m2.items.length, m1.items.length);
  assert.equal(m2.added.length, 0);
});

test('规则修改后旧事件不重复发送（revisedAt 水位），但已有项保留', async () => {
  const { s, sid } = await fixture();
  const events = setupWithDecision(s, sid);
  const t0 = events[0].at;
  // 旧规则：只发给甲，创建于事件之前
  const old = createRule({ sessionId: sid, name: 'r', triggers: { decision: true },
    levels: [{ delayMin: 0, recipients: ['甲'] }], actor: '甲', now: t0 - 100 });
  const m1 = materializeNotifications([], [old], events, { now: t0 });
  assert.equal(m1.items.length, events.filter((e) => e.type === 'decision').length);
  // 修改规则：新增接收人乙，水位推进到事件【之后】
  const edited = editRule(old, { levels: [{ delayMin: 0, recipients: ['甲', '乙'] }] }, { now: t0 + 1000 });
  const m2 = materializeNotifications(m1.items, [edited], events, { now: t0 + 1000 });
  // 甲的旧通知（旧 rev id）保留；乙不应为旧事件补发
  const recipients = new Set(m2.items.map((i) => i.recipient));
  assert.ok(recipients.has('甲'));
  assert.ok(!recipients.has('乙'), '旧事件不应对新接收人补发');
});

test('规则晚于事件创建：旧事件不补发', async () => {
  const { s, sid } = await fixture();
  const events = setupWithDecision(s, sid);
  const late = createRule({ sessionId: sid, name: 'late', triggers: { decision: true },
    levels: [{ delayMin: 0, recipients: ['甲'] }], actor: '甲', now: events[0].at + 5000 });
  const m = materializeNotifications([], [late], events, { now: events[0].at + 5000 });
  assert.equal(m.items.length, 0);
});

/* ---------- 升级：延迟、确认抑制、pump ---------- */

test('延迟级别先 scheduled，到期 pump 转 pending 并入 FIFO 队列', async () => {
  const { s, sid } = await fixture();
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  const events0 = syncNotifyEvents([], s.reviewSessions).events.filter((e) => e.type === 'decision');
  const t0 = events0[0].at;
  const events = events0;
  const rule = createRule({ sessionId: sid, name: 'r', levels: twoLevels(), actor: '甲', now: t0 - 1 });
  const m = materializeNotifications([], [rule], events, { now: t0 });
  // 初始 now=t0：L0 pending，L1 scheduled
  const l1 = m.items.filter((i) => i.level === 1);
  assert.ok(l1.every((i) => i.status === 'scheduled'));
  // 30 分钟前：仍不升级
  let pumped = pumpNotifications(m.items, [], { now: t0 + 29 * 60_000 });
  assert.equal(pumped.items.filter((i) => i.status === 'pending').length, events.length * 2);
  assert.equal(pumped.outbox.length, events.length * 2);
  // 30 分钟后：L1 转 pending 并入队（队列追加，保持 FIFO）
  pumped = pumpNotifications(pumped.items, pumped.outbox, { now: t0 + 31 * 60_000 });
  assert.equal(pumped.items.filter((i) => i.level === 1 && i.status === 'pending').length, events.length);
  assert.equal(pumped.outbox.length, events.length * 3);
  // outbox 顺序：enqueuedAt 升序
  const t = pumped.outbox.map((o) => o.enqueuedAt);
  assert.deepEqual(t, [...t].sort((a, b) => a - b));
});

test('L0 确认后：L1 到期被取消（不再升级），已送达项保留', async () => {
  const { s, sid } = await fixture();
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  const events = syncNotifyEvents([], s.reviewSessions).events.filter((e) => e.type === 'decision');
  const t0 = events[0].at;
  const rule = createRule({ sessionId: sid, name: 'r', levels: twoLevels(), actor: '甲', now: t0 - 1 });
  let { items } = materializeNotifications([], [rule], events, { now: t0 });
  // L0 任一接收人确认即抑制升级：确认两个 L0 接收人
  for (const l0 of items.filter((i) => i.level === 0)) {
    const r = acknowledgeNotification(items, l0.id, { by: l0.recipient, now: t0 + 1000 });
    items = r.items;
  }
  // L1 到期 pump：应被取消
  const pumped = pumpNotifications(items, [], { now: t0 + 31 * 60_000 });
  const l1 = pumped.items.filter((i) => i.level === 1);
  assert.ok(l1.every((i) => i.status === 'cancelled'));
  assert.equal(pumped.outbox.length, 0);
});

/* ---------- 页面操作 ---------- */

test('确认幂等；稍后提醒到点回到 pending；转交终态+新通知，重复转交幂等', async () => {
  const { s, sid } = await fixture();
  const events = setupWithDecision(s, sid);
  const rule = createRule({ sessionId: sid, name: 'r', levels: [{ delayMin: 0, recipients: ['甲'] }], actor: '甲', now: events[0].at - 1 });
  let { items } = materializeNotifications([], [rule], events, { now: events[0].at });
  const id = items[0].id;
  const a1 = acknowledgeNotification(items, id, { by: '甲', now: 1 });
  assert.equal(a1.status, 200);
  const a2 = acknowledgeNotification(a1.items, id, { by: '甲', now: 2 });
  assert.equal(a2.idempotent, true);
  items = a1.items;

  // 稍后提醒
  let fresh = materializeNotifications([], [rule], events, { now: events[0].at }).items;
  const sn = snoozeNotification(fresh, fresh[0].id, 15, { by: '甲', now: 100 });
  assert.equal(sn.status, 200);
  assert.equal(sn.items.find((x) => x.id === fresh[0].id).status, 'snoozed');
  const before = pumpNotifications(sn.items, [], { now: 100 + 14 * 60_000 });
  assert.equal(before.items.find((x) => x.id === fresh[0].id).status, 'snoozed');
  const after = pumpNotifications(sn.items, [], { now: 100 + 16 * 60_000 });
  assert.equal(after.items.find((x) => x.id === fresh[0].id).status, 'pending');

  // 转交
  let base = materializeNotifications([], [rule], events, { now: events[0].at }).items;
  const tr = transferNotification(base, base[0].id, '丁', { by: '甲', now: 200 });
  assert.equal(tr.status, 200);
  assert.equal(tr.items.find((x) => x.id === base[0].id).status, 'transferred');
  const newItem = tr.items.find((x) => x.id === tr.newId);
  assert.equal(newItem.recipient, '丁');
  assert.equal(newItem.status, 'pending');
  assert.equal(newItem.transferOf, base[0].id);
  const tr2 = transferNotification(tr.items, base[0].id, '丁', { by: '甲', now: 300 });
  assert.equal(tr2.status, 409); // 原项已终态，不能再转
});

test('失败项手动重排队：attempts 清零并回到 pending', () => {
  const failed = [{ id: 'n1', anchorKey: 'r|e', ruleId: 'r', ruleRev: 1, sessionId: 's', eventId: 'e',
    eventType: 'decision', level: 0, recipient: '甲', title: 't', summary: '', eventAt: 1, createdAt: 1,
    dueAt: 1, status: 'failed', attempts: MAX_ATTEMPTS, history: [] }];
  const r = retryNotification(failed, 'n1', { now: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.items[0].status, 'pending');
  assert.equal(r.items[0].attempts, 0);
});

/* ---------- 队列：退避重试 / 上限失败 / 幂等 ---------- */

test('发送失败：attempts 累加且留在队列按 FIFO 重试；达到上限置 failed 并移出队列', () => {
  let items = [{ id: 'n1', anchorKey: 'r|e', ruleId: 'r', ruleRev: 1, sessionId: 's', eventId: 'e',
    eventType: 'decision', level: 0, recipient: '甲', title: 't', summary: '', eventAt: 1, createdAt: 1,
    dueAt: 1, status: 'pending', attempts: 0, history: [] }];
  let outbox = [{ id: outboxItemId('n1'), notifyId: 'n1', enqueuedAt: 1, attempts: 0, status: 'queued' }];
  const backoff = 30_000;
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const r = recordDeliveryAttempt(items, outbox, 'n1', { ok: false, error: 'network' }, { now: 1000 * i, backoffMs: backoff });
    items = r.items; outbox = r.outbox;
    assert.equal(outbox[0].attempts, i);
    assert.equal(outbox[0].status, 'queued');
    assert.equal(items[0].attempts, i);
    assert.ok(outbox[0].nextAttemptAt > 1000 * i);
  }
  // 第 MAX 次失败 → 出队、failed
  const fin = recordDeliveryAttempt(items, outbox, 'n1', { ok: false, error: 'network' }, { now: 9000, backoffMs: backoff });
  assert.equal(fin.outbox.length, 0);
  assert.equal(fin.items[0].status, 'failed');
  assert.equal(fin.items[0].attempts, MAX_ATTEMPTS);
  assert.equal(fin.items[0].lastError, 'network');
  // 成功回调幂等：重复 ok 不重复计数 / 不改时间
  let okItems = [{ ...fin.items[0], status: 'pending' }];
  const ok1 = recordDeliveryAttempt(okItems, [{ id: outboxItemId('n1'), notifyId: 'n1', enqueuedAt: 1, attempts: 5, status: 'queued' }], 'n1', { ok: true }, { now: 10000 });
  const ok2 = recordDeliveryAttempt(ok1.items, ok1.outbox, 'n1', { ok: true }, { now: 11000 });
  assert.equal(ok1.items[0].deliveredAt, 10000);
  assert.equal(ok2.items[0].deliveredAt, 10000);
});

/* ---------- Store 集成：物化、收件箱、确认、断网队列 ---------- */

test('Store：建规则后决定立即物化 L0 通知，进入本人收件箱', async () => {
  const { s, sid } = await fixture();
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  await s.flushed();
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'reject', '理由');
  const inbox = s.notifyInbox('甲');
  assert.ok(inbox.some((n) => n.title === node.title && n.eventType === 'decision'));
});

test('Store：确认后从收件箱消失并抑制升级；确认记录持久化', async () => {
  const { s, sid } = await fixture();
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: twoLevels() });
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  const mine = s.notifyInbox('甲').find((n) => n.title === node.title);
  const res = s.ackNotification(mine.id, '已处理');
  assert.ok(res.ok);
  assert.ok(!s.notifyInbox('甲').some((n) => n.id === mine.id));
  const stored = s.notificationById(mine.id);
  assert.equal(stored.status, 'acknowledged');
  assert.equal(stored.ackedBy, '甲');
  assert.ok(stored.ackedAt);
});

test('Store：注入断网通道时通知留在队列；恢复后按原顺序发送且不重复', async () => {
  const { s, sid } = await fixture();
  let online = false;
  const sent = [];
  s.setNotifyTransport({
    isOnline: () => online,
    send: async (item) => { sent.push(item.id); return { ok: true, detail: 'sent' }; },
  });
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  s.online = false;
  await s.flushOutbox();
  assert.equal(s.notifyOutbox.length, 1, '断网：通知留在队列');
  assert.equal(sent.length, 0);
  // 再触发物化 / pump 不会让同一项重复入队
  s.pumpNotify({});
  assert.equal(s.notifyOutbox.length, 1);
  // 恢复：按序发送
  online = true; s.notifyOnline();
  await s.flushOutbox();
  assert.equal(s.notifyOutbox.length, 0);
  assert.equal(sent.length, 1);
  const delivered = s.notifications.filter((n) => n.status === 'delivered');
  assert.equal(delivered.length, 1);
  // 再 flush：已送达项不重复发送
  await s.flushOutbox();
  assert.equal(sent.length, 1);
});

test('Store：通知项版本冲突锁不阻塞无关队列项，恢复后按 FIFO 继续发送', async () => {
  const { s, sid } = await fixture();
  let online = false; // 装载 transport 即离线，避免规则保存时提前送达
  const sent = [];
  s.online = false;
  s.setNotifyTransport({
    isOnline: () => online,
    send: async (item) => { sent.push(item.id); return { ok: true, detail: 'sent' }; },
  });
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  // 断网状态下为多个节点产生待处理决定：全部留在队列、无一被提前送达
  for (const n0 of s.activeReview.nodes) s.submitReviewDecision(sid, n0.key, 'pass', '');
  await s.flushOutbox();
  const queued = [...s.notifyOutbox].sort((a, b) => (a.enqueuedAt - b.enqueuedAt) || (a.id < b.id ? -1 : 1));
  assert.ok(queued.length >= 2, `至少两项待发送（实际 ${queued.length}）`);
  // 任意一个队中项在另一窗口被处理 → 本窗口 409 锁定该项（本地动作保留为草稿）。
  // 选 FIFO 队头（enqueuedAt 相同按 outbox id 确定序），它被冻结不发送，其余项按序照常发送。
  const lockedId = queued[0].notifyId;
  const rest = queued.slice(1).map((o) => o.notifyId);
  s._notifyLockedItems.add(lockedId);
  s.pumpNotify({}); // 锁定项移出队列（保留 pending 状态，等冲突解决后重试）
  assert.ok(!s.notifyOutbox.some((o) => o.notifyId === lockedId), '锁定项不在发送队列');
  // 恢复网络：锁定项冻结在队头，后续无关待处理决定必须照常按序发出
  online = true; s.notifyOnline();
  await s.flushOutbox();
  assert.deepEqual(sent, rest, '无关的待处理决定不被冲突锁阻塞，保持 FIFO 顺序');
  assert.ok(sent.every((id) => id !== lockedId), '锁定项未发送');
  assert.ok(!s.notifications.find((n) => n.id === lockedId && n.status === 'delivered'), '锁定项未被标记送达');
  // 冲突解决（解锁）后重新 pump：锁定项重新入队并按 FIFO 补发；已送达项不重复
  s._notifyLockedItems.delete(lockedId);
  s.pumpNotify({});
  await s.flushOutbox();
  assert.deepEqual(sent, [...rest, lockedId], '解锁后重新入队并按原 FIFO 顺序补发');
  assert.equal(s.notifyOutbox.length, 0);
});

test('Store：送达结果迟到时该项已被 409 锁定/终态 → 丢弃迟到结果，不覆盖权威状态', async () => {
  const { s, sid } = await fixture();
  let releaseSend;
  const sent = [];
  s.setNotifyTransport({
    isOnline: () => true,
    send: (item) => { sent.push(item.id); return new Promise((resolve) => { releaseSend = () => resolve({ ok: true }); }); },
  });
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  const flushP = s.flushOutbox();
  await sleep(5);
  const nid = s.notifications.find((n) => n.status === 'pending')?.id;
  assert.ok(nid);
  // 发送在飞期间，该项被 409 流程回滚为服务端权威 acknowledged 并锁定
  s.notifications = s.notifications.map((n) => (n.id === nid
    ? { ...n, status: 'acknowledged', ackedAt: Date.now(), ackedBy: '窗口2' } : n));
  s._notifyLockedItems.add(nid);
  releaseSend();
  await flushP;
  assert.equal(s.notificationById(nid).status, 'acknowledged', '迟到送达不覆盖权威状态');
  assert.equal(s.notificationById(nid).ackedBy, '窗口2');
  assert.equal(s.notifyOutbox.filter((o) => o.notifyId === nid).length, 0, '终态项队列条目被清理');
});

/* ---------- 刷新 / 重启一致性 ---------- */

test('刷新后规则、队列、重试次数、确认记录、送达结果确定性重建', async () => {
  const { s, sid } = await fixture();
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: twoLevels() });
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  const mine = s.notifyInbox('甲').find((n) => n.title === node.title);
  s.ackNotification(mine.id, 'ok');
  await s.flushed();
  const doc = structuredClone(s._payload());
  // 新窗口装载同一文档（离线，纯本地重建）
  const s2 = await freshStore();
  await s2._adopt(doc, { seed: false });
  const rule = s2.notifyRules.find((r) => r.sessionId === sid);
  assert.ok(rule);
  assert.equal(rule.levels.length, 2);
  const item = s2.notificationById(mine.id);
  assert.equal(item.status, 'acknowledged');
  assert.equal(item.ackedBy, '甲');
  // 重建幂等：再 adopt 一次，事件/通知数量不变
  const n1 = s2.notifyEvents.length; const i1 = s2.notifications.length;
  await s2._adopt(structuredClone(s2._payload()), { seed: false });
  assert.equal(s2.notifyEvents.length, n1);
  assert.equal(s2.notifications.length, i1);
});

/* ---------- 乐观并发 ---------- */

test('规则被另一窗口前进 → 409，本地编辑保留为 draft，可作为新修订重提', async () => {
  const { s, sid } = await fixture();
  const created = s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  await s.flushed();
  const rid = created.rule.id;
  // 另一窗口前进同一规则（直接 PUT）
  const server = harness.doc;
  const advanced = structuredClone(server);
  const ruleOnServer = advanced.notifyRules.find((r) => r.id === rid);
  ruleOnServer.name = '窗口2改的名';
  ruleOnServer.rev = ruleOnServer.rev + 1;
  ruleOnServer.updatedAt = Date.now();
  ruleOnServer.revisedAt = Date.now();
  advanced.baseRev = server.rev;
  advanced.baseHeads = Object.fromEntries(server.branches.map((b) => [b.id, b.headEventId]));
  advanced.baseNotifyRuleRevs = { [rid]: server.notifyRules.find((r) => r.id === rid).rev };
  const put = await activeFetch('/api/doc', { method: 'PUT', body: JSON.stringify(advanced) });
  assert.equal(put.status, 200);
  // 本窗口基于旧 rev 再改（本地乐观接受），随后保存被服务端 409
  const res = s.saveNotifyRule(sid, { name: '窗口1改的名', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['乙'] }] }, { editId: rid });
  assert.ok(res.ok, '本地先乐观接受规则编辑');
  await s.flushed();
  await sleep(30);
  assert.equal(s.notifyConflict?.reason, 'notify-rule-advanced');
  assert.ok(s._notifyLockedRules.has(rid));
  assert.ok(s.notifyRuleDrafts(rid), '本地规则编辑保留为 draft');
  assert.equal(s.notifyRuleById(rid).name, '窗口2改的名', '已回滚到服务端权威版本');
  // 几何 / 其他保存不被通知锁拦截
  const geo = s.commit((m) => { m.rects[0].x += 3; }, { label: '通知冲突期间几何' });
  assert.ok(geo.ok);
  // 采用本地：作为新修订提交成功
  const re = s.reapplyNotifyRuleDraft(rid);
  assert.ok(re.ok, re.error);
  assert.ok(!s._notifyLockedRules.has(rid));
  assert.equal(s.notifyRuleById(rid).levels[0].recipients.includes('乙'), true);
  await s.flushed();
});

test('同一通知被两个窗口处理：后处理者收到 notify-item-advanced，本地动作保留', async () => {
  const { s, sid } = await fixture();
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'pass', '');
  await s.flushed();
  const nid = s.notifyInbox('甲')[0]?.id || s.notifications.find((n) => n.recipient === '甲' && n.title === node.title)?.id;
  // 窗口2已在服务端确认（基线取服务端当前项状态，模拟真实第二窗口）
  const server = harness.doc;
  const adv = structuredClone(server);
  const serverItem = adv.notifications.find((x) => x.id === nid);
  assert.ok(serverItem, '服务端已有该通知项');
  const serverBase = { status: serverItem.status, ackedAt: serverItem.ackedAt ?? null };
  serverItem.status = 'acknowledged'; serverItem.ackedAt = 12345; serverItem.ackedBy = '窗口2';
  serverItem.history.push({ at: 12345, action: 'acknowledge', by: '窗口2', detail: 'x' });
  adv.baseRev = server.rev;
  adv.baseHeads = Object.fromEntries(server.branches.map((b) => [b.id, b.headEventId]));
  adv.baseNotifyItemRevs = { [nid]: serverBase };
  adv.baseNotifyRuleRevs = Object.fromEntries((server.notifyRules || []).map((r) => [r.id, Math.max(r.rev || 0, r.deleteRev || 0)]));
  adv.baseReviewRevs = Object.fromEntries((server.reviewSessions || []).map((x) => [x.id, x.rev]));
  const put = await activeFetch('/api/doc', { method: 'PUT', body: JSON.stringify(adv) });
  assert.equal(put.status, 200);
  // 本窗口尝试转交（本地乐观接受），随后保存被服务端 409：回滚并保留草稿
  const res = s.transferNotification(nid, '丁', '本地转交');
  assert.ok(res.ok, '本地先乐观应用转交');
  await s.flushed();
  await sleep(30);
  assert.equal(s.notifyConflict?.reason, 'notify-item-advanced');
  assert.ok(s._notifyLockedItems.has(nid));
  const drafts = s.notifyItemDrafts(nid);
  assert.ok(drafts.some((d) => d.action === 'transfer' && d.payload.to === '丁'));
  // 本地乐观产生的转交新通知已回滚移除，原项恢复服务端权威状态
  assert.equal(s.notificationById(nid).status, 'acknowledged');
  assert.ok(!s.notifications.some((n) => n.transferOf === nid));
});

test('服务端拒绝：规则引用不存在的会话 → notify-session-missing；孤儿事件 → notify-event-orphan', () => {
  const server = { reviewSessions: [], notifyRules: [], notifications: [], notifyEvents: [] };
  const body = {
    reviewSessions: [],
    notifyRules: [{ id: 'nr_x', sessionId: 'rv_none', rev: 1, levels: [{ level: 0, recipients: ['甲'] }], triggers: {} }],
    notifications: [], notifyEvents: [],
    baseNotifyRuleRevs: { nr_x: 0 },
  };
  assert.equal(assessServerNotifyConflict(server, body).reason, 'notify-session-missing');
  const body2 = {
    reviewSessions: [], notifyRules: [], notifications: [],
    notifyEvents: [{ id: 'ne_1', sessionId: 'rv_none', type: 'decision', at: 1 }],
    baseNotifyRuleRevs: {},
  };
  assert.equal(assessServerNotifyConflict(server, body2).reason, 'notify-event-orphan');
});

/* ---------- 合流 ---------- */

test('跨分支合流：事件并集、规则 rev 胜出、通知状态远端胜出 + 历史并集、队列并集', () => {
  const events = mergeNotifyEvents([{ id: 'e1', type: 'decision', at: 1 }], [{ id: 'e2', type: 'conflict', at: 2 }]);
  assert.equal(events.length, 2);
  const rules = mergeRules(
    [{ id: 'r1', sessionId: 's', rev: 1, levels: [], createdAt: 1 }],
    [{ id: 'r1', sessionId: 's', rev: 3, levels: [], name: 'new', createdAt: 1 }]);
  assert.equal(rules[0].rev, 3);
  assert.equal(rules[0].name, 'new');
  // 删除墓碑不能被旧副本复活
  const merged2 = mergeRules(
    [{ id: 'r1', sessionId: 's', rev: 3, levels: [], createdAt: 1 }],
    [{ id: 'r1', sessionId: 's', rev: 2, deleted: true, deleteRev: 4, levels: [], createdAt: 1 }]);
  assert.equal(merged2[0].deleted, true);
  const items = mergeNotifications(
    [{ id: 'n1', status: 'pending', attempts: 1, history: [{ at: 1, action: 'created', detail: 'a' }], dueAt: 1, eventAt: 1, level: 0 }],
    [{ id: 'n1', status: 'acknowledged', attempts: 2, history: [{ at: 2, action: 'acknowledge', detail: 'b' }], dueAt: 1, eventAt: 1, level: 0 }]);
  assert.equal(items[0].status, 'acknowledged');
  assert.equal(items[0].attempts, 2);
  assert.equal(items[0].history.length, 2);
  const ob = mergeOutbox(
    [{ id: 'o1', notifyId: 'n1', enqueuedAt: 5, attempts: 1 }, { id: 'o2', notifyId: 'n2', enqueuedAt: 9, attempts: 0 }],
    [{ id: 'o1', notifyId: 'n1', enqueuedAt: 3, attempts: 2 }]);
  assert.equal(ob.length, 2);
  assert.equal(ob[0].attempts, 2);
  assert.equal(ob[0].enqueuedAt, 3);
});

/* ---------- 报告 ---------- */

test('按会话的通知时间线报告：事件→通知项→送达/确认/失败，导出确定+校验和', async () => {
  const { s, sid } = await fixture();
  s.saveNotifyRule(sid, { name: '规则', triggers: { decision: true }, levels: [{ delayMin: 0, recipients: ['甲'] }] });
  const node = s.activeReview.nodes[0];
  s.submitReviewDecision(sid, node.key, 'reject', '报告理由');
  const rep = s.notifyReport(sid, { generatedAt: 'fixed' });
  assert.equal(rep.format, 'rect-constraints/notify-report');
  assert.ok(rep.timeline.some((ev) => ev.notifications.some((n) => n.recipient === '甲')));
  assert.equal(rep.rules.length, 1);
  assert.ok(rep.delivery.total >= 1);
  const t1 = stableStringify(rep);
  const t2 = stableStringify(JSON.parse(JSON.stringify(rep)));
  assert.equal(t1, t2);
  assert.match(exportChecksum(t1), /^[0-9a-f]{8}$/);
});

test('报告含失败原因与重试次数', async () => {
  const items = [{ id: 'n1', anchorKey: 'r|e', ruleId: 'r', ruleRev: 1, sessionId: 's', eventId: 'e',
    eventType: 'decision', level: 0, recipient: '甲', title: 't', summary: '', eventAt: 1, createdAt: 1,
    dueAt: 1, status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'network-down', history: [] }];
  const events = [{ id: 'e', sessionId: 's', type: 'decision', at: 1, title: 't', actor: '甲' }];
  const rules = [{ id: 'r', sessionId: 's', name: 'r', enabled: true, deleted: false, rev: 1,
    triggers: { decision: true }, levels: [{ level: 0, delayMin: 0, recipients: ['甲'] }], createdAt: 1 }];
  const rep = buildNotifyReport('s', { rules, events, items, outbox: [], generatedAt: 'fixed' });
  assert.equal(rep.delivery.failed, 1);
  assert.equal(rep.delivery.failures[0].error, 'network-down');
  assert.equal(rep.delivery.failures[0].attempts, MAX_ATTEMPTS);
});

/* ---------- 清洗（损坏容忍） ---------- */

test('加载清洗：非法事件/规则/通知项/队列条目被剔除，字段归一', () => {
  const events = sanitizeNotifyEvents([
    { id: 'a', sessionId: 's', type: 'decision', at: 2 },
    { id: 'b', sessionId: 's', type: 'bogus' },
    null,
    { id: 'a', sessionId: 's', type: 'decision', at: 1 }, // 重复 id
  ]);
  assert.equal(events.length, 1);
  const rules = sanitizeRules([{ id: 'r', sessionId: 's', levels: [{ recipients: ['甲'] }] }, null]);
  assert.equal(rules.length, 1);
  const items = sanitizeNotifications([
    { id: 'n', ruleId: 'r', eventId: 'e', recipient: '甲', status: 'weird' },
    { id: 'bad' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'scheduled');
  const ob = sanitizeOutbox([{ id: 'o', notifyId: 'n' }, { id: 'x' }]);
  assert.equal(ob.length, 1);
});

// 运行
let pass = 0, fail = 0;
for (const [name, fn] of collected) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n   ', e); }
}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
