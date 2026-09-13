// 真实 HTTP 后端 e2e：可恢复审阅会话的创建快照 / 决定记录与持久化 / 刷新恢复 /
// 多窗口 409（会话 rev 前进）+ 逐项合并 / 节点指纹变化 409 / 分支推进 409 /
// 与审阅无关的几何保存不被拦截 / 审阅报告导出。用法：先启动 server（8099）。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { Store } = await import('../web/js/geom/store.js');
const { filterNodes, stableStringify, exportChecksum } = await import('../web/js/geom/auditbench.js');

const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

await fetch(BASE + '/api/reset', { method: 'POST' });

// 独立 localStorage 的第二窗口（仍连同一服务端）
function isolatedStore() {
  const own = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (own.has(k) ? own.get(k) : null),
    setItem: (k, v) => own.set(k, v),
    removeItem: (k) => own.delete(k),
  };
  const store = new Store({ base: BASE, tickMs: 5 });
  return {
    store,
    restore() { globalThis.localStorage = saved; },
  };
}

const store = new Store({ base: BASE, tickMs: 5 });
await store.load();
const target = store.model.rects.find((r) => r.name === '卡片A').id;

// 1) 几何提交，保证时间线有足够多事件（≥4，给并发窗口留出未决定节点）
for (let i = 0; i < 3; i++) {
  store.commit((m) => { const r = m.rects.find((x) => x.id === target); r.x += 20 + i * 10; }, { label: `审阅前置编辑${i + 1}` });
}
await store.flushed();

// 2) 从当前筛选创建审阅会话并持久化（此时不记录任何决定）
const created = store.createReview('E2E 审阅');
ok(created.ok, '创建审阅会话');
const sid = created.session.id;
const nodes = created.session.nodes;
ok(nodes.length >= 3 && nodes.every((n) => n.fingerprint), '会话快照含节点顺序与每节点指纹（≥3 节点）');
await store.flushed();

// 3) 第二窗口在【任何决定之前】加载，拿到会话 rev=1
const other = isolatedStore();
const w2 = other.store;
await w2.load();
other.restore();
ok(w2.reviewSessionById(sid).rev === 1, '窗口2基于会话 rev=1');

// 4) 窗口1记录两个决定（会话前进到 rev=3）并持久化
const k0 = nodes[0].key, k1 = nodes[1].key;
ok(store.submitReviewDecision(sid, k0, 'pass', '').ok, '记录通过');
ok(!store.submitReviewDecision(sid, k1, 'reject', '').ok, '驳回无理由被拒');
ok(store.submitReviewDecision(sid, k1, 'reject', 'E2E 驳回理由').ok, '记录驳回（带理由）');
await store.flushed();

// 5) 刷新后会话、进度、决定、变更记录全部恢复
const store2 = new Store({ base: BASE, tickMs: 5 });
await store2.load();
store2.selectReview(sid);
const sess2 = store2.reviewSessionById(sid);
ok(!!sess2 && sess2.name === 'E2E 审阅', '刷新后会话恢复');
ok(sess2.nodes.find((n) => n.key === k0).decision === 'pass', '通过决定恢复');
ok(sess2.nodes.find((n) => n.key === k1).reason === 'E2E 驳回理由', '驳回理由恢复');
const v2 = store2.reviewView(sid);
ok(v2.progress.reject === 1 && v2.progress.pass === 1, '审阅进度恢复');

// 6) 窗口2基于过期 rev 决定第三个节点（固定取 rev1 会话的 index 2，避免与 k0/k1 冲突）→ 409
const k2 = w2.reviewSessionById(sid).nodes[2].key;
ok(!!k2, '窗口2找到可决定的节点');
const localRes = w2.submitReviewDecision(sid, k2, 'review', '窗口2待复核');
ok(localRes.ok, '窗口2本地先接受决定');
await w2.flushed();
await sleep(20);
ok(!!w2.reviewConflict && w2.reviewConflict.reason === 'review-advanced', '过期窗口收到 409 review-advanced');
ok(w2.reviewProposals(sid).some((p) => p.nodeKey === k2), '本地决定保留为待合并提案');
const geo = w2.commit((m) => { const r = m.rects.find((x) => x.id === target); r.x += 7; }, { label: '窗口2几何继续' });
ok(geo.ok, '审阅冲突不锁定几何编辑');
await w2.flushed();

// 7) 逐项合并：以本地决定落到最新快照，关闭冲突，rev 前进
const mergeRes = w2.mergeReviewItem(sid, k2, 'review', '窗口2待复核（合并）');
ok(mergeRes.ok, '逐项合并成功');
await w2.flushed();
ok(!w2.reviewConflict, '合并后冲突清除');

// 6) 服务端文档含三个窗口的决定
const doc = await (await fetch(BASE + '/api/doc')).json();
const serverSess = doc.reviewSessions.find((x) => x.id === sid);
ok(!!serverSess, '服务端持久化审阅会话');
ok(serverSess.nodes.find((n) => n.key === k0).decision === 'pass', '服务端含窗口1通过');
ok(serverSess.nodes.find((n) => n.key === k2).decision === 'review', '服务端含窗口2合并后的待复核');
ok(serverSess.nodes.find((n) => n.key === k2).history.some((h) => h.merged), '合并决定带 merged 变更记录');

// 7) 决定变更记录完整（驳回的首次决定 + 合并）
const changeCount = serverSess.nodes.reduce((a, n) => a + n.history.length, 0);
ok(changeCount >= 1, `决定变更记录已持久化（${changeCount} 条）`);

// 8) 服务端审阅乐观锁：节点指纹与服务端不一致的推进会话被 409（不污染权威文档）
{
  const fresh = await (await fetch(BASE + '/api/doc')).json();
  const existing = fresh.reviewSessions.find((x) => x.id === sid);
  const tamperedNode = structuredClone(existing.nodes.find((n) => n.key.startsWith('event:')));
  tamperedNode.fingerprint = '0badf00d'; // 节点指纹与服务端当前 hash 不一致
  tamperedNode.decision = 'reject';
  tamperedNode.reason = '伪造指纹提交';
  const tamperedSession = {
    ...structuredClone(existing),
    rev: existing.rev + 1,
    nodes: existing.nodes.map((n) => (n.key === tamperedNode.key ? tamperedNode : n)),
  };
  const put = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...fresh, baseRev: fresh.rev,
      baseHeads: Object.fromEntries(fresh.branches.map((b) => [b.id, b.headEventId])),
      reviewSessions: fresh.reviewSessions.map((x) => (x.id === sid ? tamperedSession : x)),
      baseReviewRevs: { [sid]: existing.rev },
    }),
  });
  const body = await put.json().catch(() => ({}));
  ok(put.status === 409 && body.reason === 'review-fingerprint-changed',
    '节点指纹变化的推进提交被服务端 409（' + body.reason + '）');
  // 权威文档未被污染
  const after = await (await fetch(BASE + '/api/doc')).json();
  ok(after.rev === fresh.rev, '409 后服务端文档 rev 不变');
}

// 9) 审阅报告导出：确定性 + 校验和
const report = store.reviewReport(sid, { generatedAt: 'fixed' });
ok(report.format === 'rect-constraints/review-report', '报告格式标识');
ok(report.nodes.length === serverSess.nodes.length, '报告含全部节点');
ok(Array.isArray(report.changeLog) && report.conflicts !== undefined, '报告含变更记录与冲突记录');
const t1 = stableStringify(report);
const t2 = stableStringify(JSON.parse(JSON.stringify(report)));
ok(t1 === t2 && /^[0-9a-f]{8}$/.test(exportChecksum(t1)), '报告导出确定 + 校验和');

// 10) 与审阅无关的几何保存不被审阅乐观锁拦截（用刷新后的最新窗口，避免过期 rev）
const storeFresh = new Store({ base: BASE, tickMs: 5 });
await storeFresh.load();
const beforeRev = (await (await fetch(BASE + '/api/doc')).json()).rev;
storeFresh.commit((m) => { const r = m.rects.find((x) => x.id === target); r.x += 3; }, { label: '纯几何保存' });
await storeFresh.flushed();
const afterRev = (await (await fetch(BASE + '/api/doc')).json()).rev;
ok(afterRev > beforeRev, '纯几何保存正常前进（rev ' + beforeRev + ' → ' + afterRev + '）');

// 11) 多人签署：规则持久化、名单外不能签、达到 required 前节点未确认、不能完成
const policy = { mode: 'signoff', signers: ['E2E甲', 'E2E乙', 'E2E丙'], required: 2, completeRule: 'all-decided' };
storeFresh.setActor('E2E甲');
const multiCreated = storeFresh.createReview('E2E 多人签署', { policy });
ok(multiCreated.ok, '创建多人签署会话');
const msid = multiCreated.session.id;
const mkey = multiCreated.session.nodes[0].key;
ok(storeFresh.submitReviewSignature(msid, mkey, 'pass', '甲签名').ok, '名单内审阅人签名');
storeFresh.setActor('E2E外人');
const denied = storeFresh.submitReviewSignature(msid, mkey, 'pass', '越权签名');
ok(denied.status === 403 && denied.reason === 'signer-not-allowed', '名单外审阅人签名被 403 拒绝');
storeFresh.setActor('E2E甲');
const idem = storeFresh.submitReviewSignature(msid, mkey, 'pass', '甲签名');
ok(idem.ok && idem.idempotent, '同一签署人重复签名幂等');
const beforeComplete = storeFresh.reviewSessionById(msid).rev;
ok(!storeFresh.completeReview(msid).ok, '签名人数不足时不能完成会话');
ok(storeFresh.reviewSessionById(msid).rev === beforeComplete, '完成被拒绝不前进会话 rev');
await storeFresh.flushed();

// 12) 两个窗口基于同一 rev 同时签同一节点：窗口1再由丙签署推进 rev，窗口2（乙）后提交收到 409，
//     本地签名保留，随后逐项合并；服务端同构校验保证不同人签名可并集，同会话旧 rev 不覆盖。
const srvBeforeSecond = await (await fetch(BASE + '/api/doc')).json();
ok(srvBeforeSecond.reviewSessions.find((x) => x.id === msid).rev === 2, '第二窗口加载前服务端会话已前进到 rev=2');
const w3iso = isolatedStore();
const w3 = w3iso.store;
await w3.load();
w3iso.restore();
ok(w3.reviewSessionById(msid).rev === 2, '第二窗口基于多人会话 rev=2');
storeFresh.setActor('E2E丙');
ok(storeFresh.submitReviewSignature(msid, mkey, 'pass', '丙先提交').ok, '窗口1第三名签署人先提交');
await storeFresh.flushed();
w3.setActor('E2E乙');
const localSig = w3.submitReviewSignature(msid, mkey, 'pass', '乙本地签名');
ok(localSig.ok, '第二窗口先在本地接受签名');
await w3.flushed();
await sleep(20);
ok(!!w3.reviewConflict && w3.reviewConflict.reason === 'review-advanced', '第二窗口后提交收到 409 review-advanced');
const sigProposal = w3.reviewProposals(msid).find((p) => p.type === 'signature' && p.by === 'E2E乙');
ok(!!sigProposal, '409 后本地签名完整保留');
const sigMerge = w3.mergeReviewItem(msid, mkey, sigProposal.decision, sigProposal.reason, { proposal: sigProposal, by: sigProposal.by });
ok(sigMerge.ok, '逐项合入本地签名');
await w3.flushed();
ok(!w3.reviewConflict, '签名逐项合并后冲突清除');

// 13) 刷新后规则、签名顺序、确认状态和报告明细保持一致
const w4iso = isolatedStore();
const w4 = w4iso.store;
await w4.load();
w4iso.restore();
const multiReload = w4.reviewSessionById(msid);
const mnode = multiReload.nodes.find((n) => n.key === mkey);
ok(multiReload.policy.required === 2 && multiReload.policy.signers.length === 3, '刷新后多人签署规则恢复');
ok(mnode.signatures.filter((s) => !s.invalid).length === 3, '刷新后三个有效签名恢复');
ok(JSON.stringify(mnode.signatures.filter((s) => !s.invalid).map((s) => s.by)) === JSON.stringify(['E2E甲', 'E2E丙', 'E2E乙']), '签名顺序持久化');
ok(!!mnode.confirmedAt && mnode.decision === 'pass', '达到人数后节点已确认且聚合判定为通过');
const mReport = w4.reviewReport(msid, { generatedAt: 'fixed' });
const mrNode = mReport.nodes.find((n) => n.key === mkey);
ok(mrNode.signing.confirmed && mrNode.signing.activeCount === 3 && mrNode.signing.unsignedSigners.length === 0,
  '报告包含每节点签署明细和未签人员');

// 14) 真实服务端拒绝名单外签名的推进会话
{
  const fresh = await (await fetch(BASE + '/api/doc')).json();
  const node0 = fresh.reviewSessions.find((x) => x.id === msid).nodes[0];
  const forgedSession = {
    id: 'rv_forged_signers',
    formatVersion: 1,
    name: '伪造签名',
    createdBy: '测试',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    status: 'active',
    filter: { branchId: null, experimentId: null, variantId: null, severity: 'all', text: '' },
    policy: { mode: 'signoff', signers: ['合法签署人'], required: 1, completeRule: 'all-decided' },
    baseline: { filterHash: 'x', orderHash: 'x', timelineHash: 'x', total: 1, replayable: 1, bad: 0, warn: 0, branchHeads: {} },
    rev: 1,
    conflicts: [],
    nodes: [{
      ...node0,
      decision: 'pending',
      reason: '',
      decidedBy: null,
      decidedAt: null,
      confirmedAt: null,
      signedBy: ['闯入者'],
      signatures: [{ id: 'sg_forged', seq: 0, at: 1, by: '闯入者', decision: 'pass', reason: '', invalid: null }],
      history: [],
      autoReview: null,
      absent: false,
    }],
  };
  const put = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...fresh,
      baseRev: fresh.rev,
      baseHeads: Object.fromEntries(fresh.branches.map((b) => [b.id, b.headEventId])),
      reviewSessions: [...fresh.reviewSessions, forgedSession],
      baseReviewRevs: { rv_forged_signers: 0 },
    }),
  });
  const body = await put.json().catch(() => ({}));
  ok(put.status === 409 && body.reason === 'review-signer-not-allowed',
    '真实服务端拒绝名单外签名（' + body.reason + '）');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
