// 发布门禁与证据快照：从审阅会话冻结证据快照（筛选/顺序/每节点最新决定与签署状态/
// 实验来源/通知处理摘要）/ 缺失·过期·待复核明确展示 / 门禁全过才能批准 /
// 审批期间会话·实验分支·通知变化 → 过期阻止批准，重新生成快照（旧候选 superseded）/
// 多窗口并发审批 409 release-advanced（本地意见保留、重试/放弃）/
// 撤销必须填写原因且保留完整审计链 / 重启一致性 / 服务端同构冲突判定 / 报告导出。
import { test as rawTest } from 'node:test';
import assert from 'node:assert/strict';

const collected = [];
const test = (name, fn) => collected.push([name, fn]);

let activeFetch = null;
const mem = new Map();
const realLocalStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
let activeLocalStorage = realLocalStorage;
globalThis.localStorage = {
  getItem: (k) => activeLocalStorage.getItem(k),
  setItem: (k, v) => activeLocalStorage.setItem(k, v),
  removeItem: (k) => activeLocalStorage.removeItem(k),
};
globalThis.fetch = (url, opts) => activeFetch ? activeFetch(url, opts)
  : Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve({}) });

function isolatedStorage() {
  const own = new Map();
  const ls = { getItem: (k) => (own.has(k) ? own.get(k) : null), setItem: (k, v) => own.set(k, v), removeItem: (k) => own.delete(k) };
  return { ls, use() { activeLocalStorage = ls; }, release() { activeLocalStorage = realLocalStorage; } };
}

const pendingTimers = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => { const id = _setTimeout(fn, ms, ...args); pendingTimers.add(id); return id; };
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); return _clearTimeout(id); };

const { Store } = await import('../web/js/geom/store.js');
const R = await import('../web/js/geom/releases.js');
const {
  createReleaseCandidate, reconcileRelease, approveRelease, revokeRelease, regenerateRelease,
  sanitizeReleases, mergeReleases, assessServerReleaseConflict, assessReleaseStaleAgainstDoc,
  freezeNotifySummary, buildReleaseReport, frozenGateBlocked, GATE_CHECKS,
} = R;
const { stableStringify, exportChecksum, filterNodes } = await import('../web/js/geom/auditbench.js');
const { mergeDocs, MAIN_BRANCH } = await import('../web/js/geom/audit.js');
const { mergeReviewSessions, assessServerReviewConflict } = await import('../web/js/geom/reviews.js');
const { assessServerNotifyConflict } = await import('../web/js/geom/notifications.js');

function makeHarness() {
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
      const accept = (doc, extra = {}) => { serverDoc = doc; return jsonOk({ ok: true, rev: doc.rev, ...extra }); };
      // 与真实 server.py 一致的冲突优先级：review → notify → release → 文档级
      const rc = assessServerReviewConflict(serverDoc, body);
      if (rc) return reject({ error: 'review-conflict', ...rc, session: (serverDoc?.reviewSessions || []).find((x) => x.id === rc.sessionId) || null });
      const nc = assessServerNotifyConflict(serverDoc, body);
      if (nc) return reject({ error: 'notify-conflict', ...nc });
      const staleBuilder = (srvDoc, clientDoc, release) => assessReleaseStaleAgainstDoc(srvDoc, clientDoc, release);
      const lc = assessServerReleaseConflict(serverDoc, body, staleBuilder);
      if (lc) return reject({ error: 'release-conflict', ...lc, release: (serverDoc?.releases || []).find((x) => x.id === lc.releaseId) || null });
      if (body.baseRev !== curRev) {
        if (!serverDoc) {
          const doc = { ...body, rev: 1 };
          delete doc.baseRev; delete doc.baseHeads; delete doc.baseReviewRevs; delete doc.baseNotifyRuleRevs; delete doc.baseNotifyItemRevs; delete doc.baseReleaseRevs;
          return accept(doc);
        }
        const merged = mergeDocs(serverDoc, body);
        merged.reviewSessions = mergeReviewSessions(serverDoc.reviewSessions || [], body.reviewSessions || []);
        merged.releases = mergeReleases(serverDoc.releases || [], body.releases || []);
        delete merged.baseRev; delete merged.baseHeads; delete merged.baseReviewRevs; delete merged.baseNotifyRuleRevs; delete merged.baseNotifyItemRevs; delete merged.baseReleaseRevs;
        merged.rev = curRev + 1;
        return accept(merged, { merged: true, doc: merged });
      }
      const doc0 = { ...body, rev: curRev + 1 };
      delete doc0.baseRev; delete doc0.baseHeads; delete doc0.baseReviewRevs; delete doc0.baseNotifyRuleRevs; delete doc0.baseNotifyItemRevs; delete doc0.baseReleaseRevs;
      return accept(doc0);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return {
    fetchImpl,
    nextGen() { gen++; },
    clear() { serverDoc = null; },
    get doc() { return serverDoc },
    set doc(v) { serverDoc = v; },
  };
}

const harness = makeHarness();
activeFetch = (url, opts) => harness.fetchImpl(url, opts);

const freshStore = async () => {
  for (const id of pendingTimers) _clearTimeout(id);
  pendingTimers.clear();
  mem.clear();
  harness.clear();
  harness.nextGen();
  const s = new Store({ base: '', tickMs: 1 });
  await s.load();
  return s;
};
const drain = () => new Promise((r) => _setTimeout(r, 0));

async function buildFixture({ signoff = false, notifyRule = false } = {}) {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第一步' });
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第二步' });
  const policy = signoff
    ? { mode: 'signoff', signers: ['甲', '乙'], required: 1, completeRule: 'all-decided' }
    : null;
  const created = s.createReview('发布前审阅', signoff ? { policy } : {});
  const sid = created.session.id;
  s.setActor('甲');
  if (notifyRule) {
    // 规则必须在签名之前创建：规则水位（revisedAt）之后的事件才物化通知
    s.saveNotifyRule(sid, {
      name: '规则', triggers: { decision: true, signoff: true, conflict: true, completed: true },
      levels: [{ delayMin: 0, recipients: ['收件人'] }],
    });
    for (let i = 0; i < 3; i++) await drain();
  }
  for (const n of s.reviewSessionById(sid).nodes) {
    if (signoff) s.submitReviewSignature(sid, n.key, 'pass', '');
    else s.submitReviewDecision(sid, n.key, 'pass', '');
  }
  s.completeReview(sid);
  if (notifyRule) {
    for (let i = 0; i < 5; i++) await drain();
    s.pumpNotify({});
  }
  await s.flushed();
  return { s, sid };
}

/* ---------- 创建候选与证据快照 ---------- */

test('创建发布候选：冻结筛选条件/节点顺序/每节点决定与签署状态/实验来源/通知摘要，并运行门禁', async () => {
  const { s, sid } = await buildFixture();
  const res = s.createRelease(sid, { name: 'RC-1' });
  assert.equal(res.ok, true);
  const r = res.release;
  assert.equal(r.state, 'pending');
  assert.equal(r.candidateNo, 1);
  assert.equal(r.evidence.session.sessionId, sid);
  assert.ok(/^[0-9a-f]{8}$/.test(r.evidence.evidenceHash));
  assert.ok(r.evidence.order.length >= 3);
  // 会话顺序与冻结一致
  assert.deepEqual(r.evidence.order, r.evidence.session.nodes.map((n) => n.key));
  // 每节点最新决定冻结
  assert.ok(r.evidence.session.nodes.every((n) => n.effectiveDecision === 'pass' && n.confirmed));
  // 通知摘要结构
  assert.equal(typeof r.evidence.notify.stateHash, 'string');
  assert.equal(r.evidence.notify.queued.length, 0);
  // 干净环境门禁全过
  assert.equal(res.view.gate.ok, true);
  assert.deepEqual(res.view.gate.blockers, []);
  assert.equal(res.view.stale, false);
});

test('门禁明确列出会话未完成、未达签署、通知未处理等阻断项', async () => {
  const { s, sid } = await buildFixture();
  // 未完成的会话（重开）不能通过 policy 检查
  const r0 = s.reopenReview(sid);
  assert.ok(r0.ok);
  const res = s.createRelease(sid, { name: 'RC-未完成' });
  const codes = res.view.gate.checks.filter((c) => !c.ok).map((c) => c.code);
  assert.ok(codes.includes('policy-satisfied'));
  // 门禁详情可读
  const detail = res.view.gate.checks.find((c) => c.code === 'policy-satisfied').detail;
  assert.match(detail, /尚未标记完成/);
  // 批准被拒
  const ap = s.approveRelease(res.release.id, 'x');
  assert.equal(ap.ok, false);
  assert.equal(ap.reason, 'release-gate-blocked');
  assert.ok(ap.blockers.includes('policy-satisfied'));
});

test('门禁明确列出待复核（驳回）与未达签署节点', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第一步' });
  const policy = { mode: 'signoff', signers: ['甲', '乙'], required: 2, completeRule: 'all-decided' };
  const sid = s.createReview('双人签审', { policy }).session.id;
  s.setActor('甲');
  const nodes = s.reviewSessionById(sid).nodes;
  // 只有甲签名（required=2）→ 节点未确认（签署不足时有效决定聚合为 pending，但签名计数保留）
  s.submitReviewSignature(sid, nodes[0].key, 'reject', '存在风险');
  // 会话保持 active（不完成）：创建候选时门禁应列出未确认
  const res = s.createRelease(sid, { name: 'RC-签署不足' });
  assert.ok(res.view.gate.blockers.includes('nodes-all-confirmed'));
  const evidence = res.view.release.evidence.session;
  assert.ok(evidence.nodes[0].signatures.some((sg) => sg.decision === 'reject' && !sg.invalid));
  assert.equal(evidence.nodes[0].activeSigners.join(','), '甲');
  assert.ok(evidence.progress.confirmed < evidence.progress.total);
});

test('通知队列有待处理项时门禁不通过；确认后因证据已过期需重新生成快照', async () => {
  const { s, sid } = await buildFixture({ notifyRule: true });
  assert.ok(s.notifications.length > 0);
  const actionable = s.notifications.filter((n) => ['pending', 'sent', 'delivered', 'snoozed', 'failed', 'deferred'].includes(n.status));
  assert.ok(actionable.length > 0);
  const res = s.createRelease(sid, { name: 'RC-通知' });
  assert.equal(res.view.gate.ok, false);
  assert.ok(res.view.gate.blockers.includes('notify-no-actionable'));
  // 先处理通知再创建 → 创建时即全过；随后再产生通知变化 → 候选过期
  for (const n of [...s.notifications]) {
    if (['pending', 'sent', 'delivered', 'snoozed', 'failed', 'deferred'].includes(n.status)) s.ackNotification(n.id, '已确认');
  }
  s.pumpNotify({});
  await s.flushed();
  const clean = s.createRelease(sid, { name: 'RC-干净' });
  assert.equal(clean.view.gate.ok, true);
  // 再新建规则触发新通知 → 证据过期
  s.saveNotifyRule(sid, {
    name: '规则2', triggers: { decision: true, signoff: false, conflict: false, completed: false },
    levels: [{ delayMin: 0, recipients: ['收件人2'] }],
  });
  s.pumpNotify({});
  const view = s.releaseViewFor(clean.release.id);
  assert.equal(view.stale, true);
  assert.ok(view.staleCodes.includes('release-notify-changed'));
  const ap = s.approveRelease(clean.release.id, 'x');
  assert.equal(ap.status, 409);
  assert.equal(ap.reason, 'release-stale');
  // 本地审批意见保留
  assert.ok(s.releaseProposals(clean.release.id).length >= 1);
});

/* ---------- 过期：会话 / 实验分支 / 基线变化 ---------- */

test('冻结后原审阅会话决定变化 → 候选过期并阻止批准；不影响已批准候选', async () => {
  const { s, sid } = await buildFixture();
  const res = s.createRelease(sid);
  const rid = res.release.id;
  assert.equal(s.releaseViewFor(rid).stale, false);
  // 重开会话并改判一个节点
  s.reopenReview(sid);
  const key = s.reviewSessionById(sid).nodes[0].key;
  s.submitReviewDecision(sid, key, 'reject', '复核发现问题');
  const view = s.releaseViewFor(rid);
  assert.equal(view.stale, true);
  assert.ok(view.staleCodes.includes('release-session-changed'));
  assert.equal(s.approveRelease(rid, 'x').reason, 'release-stale');
});

test('冻结后几何分支推进（新提交）→ release-branch-changed 且基线门禁阻断', async () => {
  const { s, sid } = await buildFixture();
  const res = s.createRelease(sid);
  s.commit((m) => { m.rects[0].x += 25; }, { label: '冻结后编辑' });
  const view = s.releaseViewFor(res.release.id);
  assert.equal(view.stale, true);
  assert.ok(view.staleCodes.includes('release-branch-changed'));
  assert.ok(view.staleCodes.includes('release-baseline-changed'));
  assert.ok(view.gate.blockers.includes('baseline-current'));
});

test('重新生成快照：旧候选 superseded 且证据/审批链保留，新候选 candidateNo+1 且 supersedesId 指向旧候选', async () => {
  const { s, sid } = await buildFixture();
  const first = s.createRelease(sid, { name: 'RC' }).release;
  s.commit((m) => { m.rects[0].x += 5; }, { label: '推进' });
  // rebase 审阅会话并处理新节点
  const rb = s.rebaseReview(sid);
  for (const n of s.reviewSessionById(sid).nodes) {
    if (n.decision === 'pending') s.submitReviewDecision(sid, n.key, 'pass', '');
  }
  s.completeReview(sid);
  const reg = s.regenerateRelease(first.id);
  assert.equal(reg.ok, true);
  assert.equal(reg.previous.state, 'superseded');
  assert.equal(reg.previous.supersededById, reg.release.id);
  assert.equal(reg.release.candidateNo, 2);
  assert.equal(reg.release.supersedesId, first.id);
  // 旧候选证据原样保留
  assert.equal(reg.previous.evidence.evidenceHash, first.evidence.evidenceHash);
  assert.ok(reg.previous.history.some((h) => h.action === 'superseded'));
  // 新候选干净可批准
  const view = s.releaseViewFor(reg.release.id);
  assert.equal(view.stale, false);
  assert.equal(view.gate.ok, true);
  // superseded 候选不能批准/重新生成
  assert.equal(s.approveRelease(first.id, 'x').reason, 'release-superseded');
  assert.equal(s.regenerateRelease(first.id).status, 409);
});

/* ---------- 批准 / 撤销 ---------- */

test('批准：记录审批人/意见/证据哈希/门禁校验和并 rev+1；同批准人同意见幂等', async () => {
  const { s, sid } = await buildFixture();
  const res = s.createRelease(sid);
  const rid = res.release.id;
  const beforeRev = s.releaseById(rid).rev;
  const ap = s.approveRelease(rid, '可以发布');
  assert.equal(ap.ok, true);
  assert.equal(ap.release.state, 'approved');
  assert.ok(ap.release.approvedAt > 0);
  assert.equal(ap.release.rev, beforeRev + 1);
  assert.equal(ap.approval.by, s.actor || '未署名');
  assert.equal(ap.approval.comment, '可以发布');
  assert.equal(ap.approval.evidenceHash, res.release.evidence.evidenceHash);
  assert.ok(/^[0-9a-f]{8}$/.test(ap.approval.gateChecksum));
  assert.ok(ap.release.history.some((h) => h.action === 'approved'));
  // 幂等
  const again = s.approveRelease(rid, '可以发布');
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(s.releaseById(rid).approvals.length, 1);
  assert.equal(s.releaseById(rid).rev, beforeRev + 1);
  // 已批准不允许重复不同意见
  const other = s.approveRelease(rid, '不同意见');
  assert.equal(other.reason, 'release-already-approved');
});

test('撤销必须填写原因；撤销记录包含审批链；撤销后不能再批准', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid).release.id;
  s.approveRelease(rid, '批准');
  const noReason = s.revokeRelease(rid, '   ');
  assert.equal(noReason.ok, false);
  assert.equal(noReason.reason, 'revocation-reason-required');
  const rv = s.revokeRelease(rid, '上线后发现严重回归');
  assert.equal(rv.ok, true);
  assert.equal(rv.release.state, 'revoked');
  assert.equal(rv.revocation.reason, '上线后发现严重回归');
  assert.ok(rv.revocation.approvals.length >= 1);
  assert.equal(rv.revocation.evidenceHash, rid ? s.releaseById(rid).evidence.evidenceHash : '');
  assert.ok(rv.release.history.some((h) => h.action === 'revoked'));
  assert.equal(s.approveRelease(rid, 'x').reason, 'release-revoked');
});

/* ---------- 多窗口并发审批：409 + 本地意见保留 ---------- */

test('两个窗口同时审批同一候选：后提交者收到 409 release-advanced，本地意见保留，可重试/放弃', async () => {
  const { s, sid } = await buildFixture();
  const created = s.createRelease(sid, { name: '并发 RC' });
  const rid = created.release.id;
  await s.flushed();
  assert.equal(s.releaseById(rid).rev, 1);

  // 第二窗口在批准前加载
  const iso = isolatedStorage();
  iso.use();
  const w2 = new Store({ base: '', tickMs: 1 });
  await w2.load();
  iso.release();
  assert.equal(w2.releaseById(rid).rev, 1);

  // 窗口1先批准并落盘（rev 2）
  s.setActor('甲');
  assert.equal(s.approveRelease(rid, '甲批准').ok, true);
  await s.flushed();

  // 窗口2基于过期 rev 批准 → 本地先接受、随后 409
  w2.setActor('乙');
  const local = w2.approveRelease(rid, '乙批准');
  assert.equal(local.ok, true);
  await w2.flushed();
  await drain(); await drain();
  if (!w2.releaseConflict) {
    console.log('DBG w2 releases:', w2.releases.map((r) => [r.state, r.rev, r.approvals?.map((a) => a.by)]));
    console.log('DBG server releases:', harness.doc.releases.map((r) => [r.state, r.rev, r.approvals?.map((a) => a.by)]));
  }
  assert.ok(w2.releaseConflict, '窗口2进入发布冲突');
  assert.equal(w2.releaseConflict.reason, 'release-advanced');
  assert.ok(w2.releaseProposals(rid).some((p) => p.approver === '乙'), '本地审批意见保留');

  // 几何编辑不被锁定
  const geo = w2.commit((m) => { m.rects[0].x += 3; }, { label: '窗口2几何' });
  assert.equal(geo.ok, true);
  await w2.flushed();

  // 候选已被另一窗口批准：在最新 rev 上重试 → release-already-approved（状态事实）；放弃提案可行
  const retry = w2.retryReleaseApproval(rid, w2.releaseProposals(rid)[0]);
  assert.equal(retry.ok, false);
  assert.equal(retry.status, 409);
  const proposal = w2.releaseProposals(rid)[0];
  assert.ok(proposal);
  w2.discardReleaseProposal(rid, proposal);
  assert.equal(w2.releaseProposals(rid).length, 0);

  // 服务端权威候选保持窗口1的批准
  const serverR = harness.doc.releases.find((x) => x.id === rid);
  assert.equal(serverR.state, 'approved');
  assert.deepEqual(serverR.approvals.map((a) => a.by), ['甲']);
});

test('两窗口并发撤销与批准：后到的状态转移被 409 拒绝，撤销原因仍由先到者持久化', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid).release.id;
  s.approveRelease(rid, '批准');
  await s.flushed();
  const iso = isolatedStorage();
  iso.use();
  const w2 = new Store({ base: '', tickMs: 1 });
  await w2.load();
  iso.release();
  // 窗口1撤销
  assert.equal(s.revokeRelease(rid, '撤回原因').ok, true);
  await s.flushed();
  // 窗口2基于旧 rev 撤销（幂等同原因也应被 409，因为服务端 rev 已前进）
  const rv2 = w2.revokeRelease(rid, '另一窗口原因');
  assert.equal(rv2.ok, true);
  await w2.flushed();
  await drain(); await drain();
  assert.equal(w2.releaseConflict?.reason, 'release-advanced');
  const serverR = harness.doc.releases.find((x) => x.id === rid);
  assert.equal(serverR.state, 'revoked');
  assert.equal(serverR.revocation.reason, '撤回原因');
});

/* ---------- 纯函数：冻结通知摘要 / 缺失会话 / 损坏容忍 ---------- */

test('freezeNotifySummary：状态分布/待处理/FIFO 队列/规则版本变化都会改变 stateHash', async () => {
  const a = freezeNotifySummary({ items: [{ id: 'n1', status: 'pending', recipient: 'r', level: 0 }], outbox: [{ notifyId: 'n1' }], events: [], rules: [] });
  const b = freezeNotifySummary({ items: [{ id: 'n1', status: 'acknowledged', recipient: 'r', level: 0 }], outbox: [], events: [], rules: [] });
  const c = freezeNotifySummary({ items: [{ id: 'n1', status: 'pending', recipient: 'r', level: 0 }], outbox: [{ notifyId: 'n1' }], events: [], rules: [] });
  assert.notEqual(a.stateHash, b.stateHash);
  assert.equal(a.stateHash, c.stateHash); // 确定性
  assert.equal(a.actionableCount, 1);
  assert.equal(a.queued.length, 1);
});

test('源审阅会话被删除：候选过期、会话门禁失败；已批准候选保留审计事实', async () => {
  const { s, sid } = await buildFixture();
  const pending = s.createRelease(sid).release;
  const approved = (() => { const r2 = s.createRelease(sid).release; s.approveRelease(r2.id, 'x'); return s.releaseById(r2.id); })();
  // 直接模拟“会话不在文档里”：用纯函数对账
  const ctx = { sessions: [], workbench: s.workbench(), branches: s.branches, experiments: s.experiments, notify: s._releaseNotifyState() };
  const vp = reconcileRelease(pending, ctx);
  assert.equal(vp.stale, true);
  assert.ok(vp.staleCodes.includes('release-session-changed'));
  assert.equal(vp.gate.ok, false);
  const va = reconcileRelease(approved, ctx);
  assert.equal(va.stale, false); // 已批准是审计事实，不再翻转为过期
  assert.equal(approved.state, 'approved');
});

/* ---------- 重启一致性 / 清洗 / 合流 ---------- */

test('刷新或重启后候选、证据、门禁、审批、撤销与报告导出保持一致', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid, { name: '持久化 RC' }).release.id;
  s.approveRelease(rid, '持久化批准');
  s.revokeRelease(rid, '持久化撤销原因');
  await s.flushed();

  const frozenDoc = structuredClone(harness.doc);
  const expectedHash = s.releaseById(rid).evidence.evidenceHash;

  // 模拟重启：全新 Store 从同一服务端文档加载
  const w = new Store({ base: '', tickMs: 1 });
  await w.load();
  const r2 = w.releaseById(rid);
  assert.ok(r2, '候选恢复');
  assert.equal(r2.state, 'revoked');
  assert.equal(r2.evidence.evidenceHash, expectedHash);
  assert.equal(r2.revocation.reason, '持久化撤销原因');
  assert.ok(r2.approvals.some((a) => a.comment === '持久化批准'));
  // 门禁检查项数量固定（旧版补全）
  assert.equal(r2.gate.checks.length, GATE_CHECKS.length);
  // 报告确定性 + 校验和
  const report = w.releaseReport(rid, { generatedAt: 'fixed' });
  assert.equal(report.format, 'rect-constraints/release-report');
  assert.equal(report.release.state, 'revoked');
  assert.equal(report.evidence.order.length, r2.evidence.order.length);
  const t1 = stableStringify(report);
  const t2 = stableStringify(JSON.parse(JSON.stringify(report)));
  assert.equal(t1, t2);
  assert.match(exportChecksum(t1), /^[0-9a-f]{8}$/);
  void frozenDoc;
});

test('sanitizeReleases：去重、补全缺失门禁检查项、撤销无原因时结构保留为待清洗状态', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid).release.id;
  const raw = s.releaseById(rid);
  const truncated = structuredClone(raw);
  truncated.gate.checks = truncated.gate.checks.slice(0, 3); // 旧版候选缺检查项
  truncated.gate.blockers = [];
  const [clean] = sanitizeReleases([truncated, truncated, { id: 'bad' }]);
  assert.equal(clean.gate.checks.length, GATE_CHECKS.length);
  assert.ok(clean.gate.blockers.length > 0, '缺失检查项按未通过处理，阻止伪造批准');
  assert.equal(clean.id, rid);
});

test('mergeReleases：按 id 并集，rev 更大者胜出，审批/历史记录按 id 并集不丢失', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid).release.id;
  await s.flushed();
  const base = structuredClone(s.releaseById(rid));
  const approved = structuredClone(base);
  approved.state = 'approved'; approved.rev = base.rev + 1; approved.approvedAt = 123;
  approved.approvals = [{ id: 'ra1', at: 123, by: '甲', comment: 'c1', evidenceHash: base.evidence.evidenceHash, gateChecksum: '12345678', candidateRev: base.rev }];
  approved.history = [...base.history, { at: 123, by: '甲', action: 'approved', detail: 'c1' }];
  const merged = mergeReleases([base], [approved]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].state, 'approved');
  assert.equal(merged[0].approvals.length, 1);
  // 旧 rev 携带额外审批（同 rev 竞态）→ 并集保留
  const alsoApproved = structuredClone(base);
  alsoApproved.rev = base.rev + 1;
  alsoApproved.approvals = [{ id: 'ra2', at: 124, by: '乙', comment: 'c2', evidenceHash: base.evidence.evidenceHash, gateChecksum: '12345678', candidateRev: base.rev }];
  const merged2 = mergeReleases([approved], [alsoApproved]);
  const bys = merged2[0].approvals.map((a) => a.by).sort();
  assert.deepEqual(bys, ['乙', '甲']);
});

/* ---------- 服务端同构判定 ---------- */

test('assessServerReleaseConflict：rev 前进 → release-advanced；批准过期证据 → release-stale；撤销无原因 → 409', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid).release.id;
  await s.flushed();
  const server = harness.doc;

  // 另一窗口先推进 rev
  const advanced = structuredClone(server);
  const srvR = advanced.releases.find((x) => x.id === rid);
  srvR.state = 'approved'; srvR.rev = 2;
  srvR.approvals = [{ id: 'ra1', at: 1, by: '甲', comment: '', evidenceHash: rid, gateChecksum: '1', candidateRev: 1 }];
  const clientApproved = structuredClone(server);
  clientApproved.releases.find((x) => x.id === rid).rev = 2;
  clientApproved.releases.find((x) => x.id === rid).state = 'approved';
  clientApproved.releases.find((x) => x.id === rid).approvals = [{ id: 'raX', at: 2, by: '乙', comment: '', evidenceHash: rid, gateChecksum: '1', candidateRev: 1 }];
  clientApproved.baseReleaseRevs = { [rid]: 1 };
  const conflict = assessServerReleaseConflict(advanced, clientApproved, () => []);
  assert.equal(conflict.reason, 'release-advanced');

  // 同 rev：源会话 rev 前进 → stale
  const movedSession = structuredClone(server);
  movedSession.reviewSessions[0].rev += 1;
  const staleClient = structuredClone(server);
  const cr = staleClient.releases.find((x) => x.id === rid);
  cr.rev = 2; cr.state = 'approved';
  cr.approvals = [{ id: 'raY', at: 3, by: '甲', comment: '', evidenceHash: rid, gateChecksum: '1', candidateRev: 1 }];
  staleClient.baseReleaseRevs = { [rid]: 1 };
  const staleConflict = assessServerReleaseConflict(movedSession, staleClient, (srvDoc, cDoc, rel) => assessReleaseStaleAgainstDoc(srvDoc, cDoc, rel));
  assert.equal(staleConflict.reason, 'release-stale');
  assert.ok(staleConflict.staleCodes.includes('release-session-changed'));

  // 撤销无原因
  const revokeClient = structuredClone(server);
  const rr = revokeClient.releases.find((x) => x.id === rid);
  rr.rev = 2; rr.state = 'revoked'; rr.revocation = { id: 'rr1', at: 1, by: '甲', reason: '', approvals: [] };
  revokeClient.baseReleaseRevs = { [rid]: 1 };
  assert.equal(assessServerReleaseConflict(server, revokeClient).reason, 'release-revocation-reason-required');

  // 未推进 rev 的候选不拦截无关保存
  const idle = structuredClone(server);
  idle.baseReleaseRevs = { [rid]: 1 };
  assert.equal(assessServerReleaseConflict(server, idle), null);
});

test('伪造门禁（冻结 gate 带 blockers）的批准载荷被拒绝', async () => {
  const { s, sid } = await buildFixture();
  const rid = s.createRelease(sid).release.id;
  await s.flushed();
  const server = harness.doc;
  const client = structuredClone(server);
  const r = client.releases.find((x) => x.id === rid);
  r.rev = 2; r.state = 'approved';
  r.gate = { ...r.gate, ok: false, blockers: ['policy-satisfied'] };
  r.approvals = [{ id: 'raF', at: 1, by: '甲', comment: '', evidenceHash: rid, gateChecksum: '0', candidateRev: 1 }];
  client.baseReleaseRevs = { [rid]: 1 };
  assert.equal(assessServerReleaseConflict(server, client).reason, 'release-gate-blocked');
  assert.deepEqual(frozenGateBlocked(r), ['policy-satisfied']);
});

/* ---------- 多人签署会话的证据冻结 ---------- */

test('多人签署会话：证据冻结每节点有效签名/未签人员；签名推进后候选过期', async () => {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第一步' });
  const policy = { mode: 'signoff', signers: ['甲', '乙'], required: 1, completeRule: 'all-decided' };
  const sid = s.createReview('双人签审', { policy }).session.id;
  s.setActor('甲');
  s.submitReviewSignature(sid, s.reviewSessionById(sid).nodes[0].key, 'pass', '');
  s.submitReviewSignature(sid, s.reviewSessionById(sid).nodes[1].key, 'pass', '');
  // 会话尚未标记完成时创建候选（门禁会因 policy-satisfied 阻断，但证据冻结有效）
  const res = s.createRelease(sid);
  const node0 = res.release.evidence.session.nodes[0];
  assert.deepEqual(node0.activeSigners, ['甲']);
  assert.equal(node0.activeCount, 1);
  // 乙再签一个节点 → 会话证据变化 → 过期
  s.setActor('乙');
  const key = s.reviewSessionById(sid).nodes[0].key;
  assert.equal(s.submitReviewSignature(sid, key, 'pass', '').ok, true);
  const view = s.releaseViewFor(res.release.id);
  assert.equal(view.stale, true);
  assert.ok(view.staleCodes.includes('release-session-changed'));
});

/* ---------- 注册：串行 suite ---------- */

const _realFetch = globalThis.fetch;
const _realLocalStorage = globalThis.localStorage;
const _realSetTimeout = globalThis.setTimeout;
const _realClearTimeout = globalThis.clearTimeout;

rawTest('发布门禁与证据快照', { concurrency: false }, async (t) => {
  t.after(() => {
    globalThis.fetch = _realFetch;
    globalThis.localStorage = _realLocalStorage;
    globalThis.setTimeout = _realSetTimeout;
    globalThis.clearTimeout = _realClearTimeout;
    activeFetch = null;
  });
  for (const [name, fn] of collected) {
    await t.test(name, async () => {
      try { await fn(); }
      finally {
        for (const id of pendingTimers) _clearTimeout(id);
        pendingTimers.clear();
        for (let i = 0; i < 5; i++) await drain();
        harness.nextGen();
        harness.clear();
        mem.clear();
      }
    });
  }
});
