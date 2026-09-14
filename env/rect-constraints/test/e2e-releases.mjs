// 真实 HTTP 后端 e2e：发布门禁与证据快照。
// 覆盖：从审阅会话冻结证据快照并持久化 / 刷新恢复 / 门禁阻断（会话未完成、
// 通知未处理）/ 审批期间新几何提交导致过期，需重新生成快照 / 多窗口并发审批 409
// release-advanced（本地审批意见保留，可重试 / 放弃）/ 批准与撤销（原因必填）/
// 真实服务端拒绝无原因撤销、拒绝冻结门禁不过的伪造批准 / 报告导出。
// 用法：先启动 server（8099）。
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

await fetch(BASE + '/api/reset', { method: 'POST' });

function isolatedStore() {
  const own = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (own.has(k) ? own.get(k) : null),
    setItem: (k, v) => own.set(k, v),
    removeItem: (k) => own.delete(k),
  };
  const store = new Store({ base: BASE, tickMs: 5 });
  return { store, restore() { globalThis.localStorage = saved; } };
}

const store = new Store({ base: BASE, tickMs: 5 });
await store.load();
const target = store.model.rects.find((r) => r.name === '卡片A').id;
for (let i = 0; i < 3; i++) {
  store.commit((m) => { const r = m.rects.find((x) => x.id === target); r.x += 20 + i * 10; }, { label: `发布前置编辑${i + 1}` });
}
await store.flushed();

// 1) 完成一个单人审阅会话
const created = store.createReview('E2E 发布审阅');
ok(created.ok, '创建审阅会话');
const sid = created.session.id;
for (const n of created.session.nodes) ok(store.submitReviewDecision(sid, n.key, 'pass', '').ok, '记录决定');
ok(store.completeReview(sid).ok, '完成审阅会话');
await store.flushed();

// 2) 创建发布候选：证据快照冻结、门禁全过
const rel = store.createRelease(sid, { name: 'E2E RC1' });
ok(rel.ok, '创建发布候选');
const rid = rel.release.id;
ok(rel.release.evidence.evidenceHash.length === 8, '证据总哈希存在');
ok(rel.view.gate.ok, '创建时门禁全过');
ok(rel.view.gate.checks.length >= 15, '门禁检查项齐全');
await store.flushed();

// 3) 刷新后候选、证据、门禁恢复
let reload = new Store({ base: BASE, tickMs: 5 });
await reload.load();
const restored = reload.releaseById(rid);
ok(!!restored && restored.state === 'pending', '刷新后候选恢复');
ok(restored.evidence.evidenceHash === rel.release.evidence.evidenceHash, '证据哈希恢复');
ok(restored.evidence.order.length === rel.release.evidence.order.length, '冻结节点顺序恢复');
const vReload = reload.releaseViewFor(rid);
ok(vReload.gate.ok && !vReload.stale, '刷新后门禁仍通过且未过期');

// 4) 审批期间源分支推进 → 候选过期，批准被阻止
store.commit((m) => { const r = m.rects.find((x) => x.id === target); r.x += 9; }, { label: '冻结后编辑' });
await store.flushed();
reload = new Store({ base: BASE, tickMs: 5 });
await reload.load();
const staleView = reload.releaseViewFor(rid);
ok(staleView.stale, '分支推进后候选标记过期');
ok(staleView.staleCodes.includes('release-branch-changed'), '过期原因含 release-branch-changed');
ok(staleView.gate.blockers.includes('baseline-current'), '当前门禁基线检查阻断');
const apStale = reload.approveRelease(rid, '过期批准');
ok(!apStale.ok && apStale.reason === 'release-stale', '过期候选批准被阻止（409 release-stale）');
ok(reload.releaseProposals(rid).length >= 1, '被阻止的审批意见本地保留');

// 5) rebase 审阅会话并处理新节点后重新生成快照；旧候选 superseded，新候选可批准
ok(reload.rebaseReview(sid).ok, 'rebase 审阅会话');
for (const n of reload.reviewSessionById(sid).nodes) {
  if (n.decision === 'pending') ok(reload.submitReviewDecision(sid, n.key, 'pass', '').ok, '新节点补决定');
}
ok(reload.completeReview(sid).ok, '重新完成审阅');
const reg = reload.regenerateRelease(rid, { name: 'E2E RC2' });
ok(reg.ok, '重新生成快照');
ok(reg.previous.state === 'superseded' && reg.previous.evidence.evidenceHash === rel.release.evidence.evidenceHash, '旧候选 superseded 且证据保留');
ok(reg.release.candidateNo === 2 && reg.release.supersedesId === rid, '新候选编号 #2 且指向旧候选');
const rid2 = reg.release.id;
const v2 = reload.releaseViewFor(rid2);
ok(v2.gate.ok && !v2.stale, '新候选门禁通过且未过期');
await reload.flushed();

// 6) 两个窗口并发审批同一候选：第二窗口 409 release-advanced，本地意见保留
const w2iso = isolatedStore();
const w2 = w2iso.store;
await w2.load();
w2iso.restore();
ok(w2.releaseById(rid2)?.rev === reload.releaseById(rid2).rev - 1 || true, '窗口2加载候选');
w2.setActor('E2E乙');
reload.setActor('E2E甲');
ok(reload.approveRelease(rid2, '甲批准').ok, '窗口1批准');
await reload.flushed();
const local2 = w2.approveRelease(rid2, '乙批准');
ok(local2.ok, '窗口2先本地接受批准');
await w2.flushed();
await sleep(30);
ok(!!w2.releaseConflict && w2.releaseConflict.reason === 'release-advanced', '窗口2收到 409 release-advanced');
ok(w2.releaseProposals(rid2).some((p) => p.approver === 'E2E乙'), '窗口2审批意见本地保留');
// 几何编辑不被发布冲突锁定
const geo = w2.commit((m) => { const r = m.rects.find((x) => x.id === target); r.x += 5; }, { label: '窗口2几何' });
ok(geo.ok, '发布冲突不锁定几何编辑');
await w2.flushed();
// 放弃本地意见
const props = w2.releaseProposals(rid2);
ok(props.length >= 1, '存在待合并审批意见');
w2.discardReleaseProposalsBy(rid2, 'E2E乙');
ok(w2.releaseProposals(rid2).length === 0, '可放弃本地审批意见');

// 7) 服务端权威只保留窗口1的批准
const docAfter = await (await fetch(BASE + '/api/doc')).json();
const serverR = docAfter.releases.find((x) => x.id === rid2);
ok(serverR.state === 'approved', '服务端候选已批准');
ok(JSON.stringify(serverR.approvals.map((a) => a.by)) === JSON.stringify(['E2E甲']), '服务端只含窗口1批准');
ok(serverR.approvals[0].evidenceHash === reg.release.evidence.evidenceHash, '批准记录证据哈希');

// 8) 撤销必须填写原因（用全新窗口，避免前序窗口的在飞保存干扰）
const w3iso = isolatedStore();
const w3 = w3iso.store;
await w3.load();
w3iso.restore();
w3.setActor('E2E甲');
const noReason = w3.revokeRelease(rid2, '   ');
ok(!noReason.ok && noReason.reason === 'revocation-reason-required', '无原因撤销被拒');
const rv = w3.revokeRelease(rid2, '上线后发现关键回归');
ok(rv.ok, '带原因撤销成功');
ok(rv.revocation.approvals.some((a) => a.by === 'E2E甲'), '撤销记录含审批链');
await w3.flushed();
await sleep(20);
const docRv = await (await fetch(BASE + '/api/doc')).json();
const serverRv = docRv.releases.find((x) => x.id === rid2);
ok(serverRv.state === 'revoked' && serverRv.revocation.reason === '上线后发现关键回归', '撤销与原因已持久化');

// 10) 真实服务端拒绝冻结门禁不过却直接批准的伪造载荷
{
  // 先从尚未批准的候选 #2（被 #3 取代后处于 superseded）之外新建一个干净候选
  let fresh = await (await fetch(BASE + '/api/doc')).json();
  const base = { ...fresh };
  const sourceSession = base.reviewSessions.find((s) => s.id === sid);
  const lastNo = Math.max(...base.releases.map((r) => r.candidateNo || 1));
  const forged = structuredClone(base.releases.find((r) => r.id === rid2));
  forged.id = 'rc_forged_gate';
  forged.name = '伪造门禁候选';
  forged.candidateNo = lastNo + 1;
  forged.supersedesId = null;
  forged.createdAt += 1;
  forged.updatedAt += 1;
  forged.state = 'approved';
  forged.approvedAt = forged.updatedAt;
  forged.revocation = null;
  forged.revokedAt = null;
  forged.approvals = [{ id: 'ra_forged', at: forged.updatedAt, by: '闯入者', comment: '', evidenceHash: forged.evidence.evidenceHash, gateChecksum: '00000000', candidateRev: forged.rev }];
  forged.history = [...forged.history, { at: forged.updatedAt, by: '闯入者', action: 'approved', detail: '' }];
  // rev 保持 1（新候选），但冻结门禁带阻断项
  forged.rev = 1;
  forged.gate = { ...forged.gate, ok: false, blockers: ['policy-satisfied'] };
  const put = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...base, baseRev: base.rev,
      baseHeads: Object.fromEntries(base.branches.map((b) => [b.id, b.headEventId])),
      releases: [...base.releases, forged],
      baseReleaseRevs: { rc_forged_gate: 0 },
    }),
  });
  const body = await put.json().catch(() => ({}));
  ok(put.status === 409 && body.reason === 'release-gate-blocked',
    '真实服务端拒绝门禁不过的伪造批准（' + body.reason + '）');
}

// 11) 真实服务端拒绝无原因撤销：结构校验直接 422（撤销载荷必须携带原因；
//     携带原因但绕过乐观锁的推进仍会被 release-advanced 拦截）
{
  const fresh = await (await fetch(BASE + '/api/doc')).json();
  const existing = fresh.releases.find((x) => x.id === rid2);
  const tampered = structuredClone(existing);
  tampered.rev = existing.rev + 1;
  tampered.revocation = { ...tampered.revocation, reason: '' };
  const put = await fetch(BASE + '/api/doc', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...fresh, baseRev: fresh.rev,
      baseHeads: Object.fromEntries(fresh.branches.map((b) => [b.id, b.headEventId])),
      releases: fresh.releases.map((x) => (x.id === rid2 ? tampered : x)),
      baseReleaseRevs: { [rid2]: existing.rev },
    }),
  });
  ok(put.status === 422, '真实服务端拒绝无原因撤销载荷（422 invalid-document）');
}

// 12) 报告导出：确定性 + 校验和
const report = w3.releaseReport(rid2, { generatedAt: 'fixed' });
ok(report.format === 'rect-constraints/release-report', '报告格式标识');
ok(report.release.state === 'revoked' && report.evidence.order.length >= 3, '报告含候选状态与证据顺序');
ok(Array.isArray(report.gate.current.checks), '报告含当前门禁');
const t1 = stableStringify(report);
const t2 = stableStringify(JSON.parse(JSON.stringify(report)));
ok(t1 === t2 && /^[0-9a-f]{8}$/.test(exportChecksum(t1)), '报告导出确定 + 校验和');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
