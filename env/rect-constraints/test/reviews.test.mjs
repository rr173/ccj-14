// 可恢复审阅会话：创建快照（筛选/顺序/指纹）/ 决定记录与变更历史 /
// 进度与未处理节点 / 损坏·缺失·指纹变化·分支推进自动转待复核 / 刷新基线 /
// 409 乐观并发（另一窗口 rev 前进、节点漂移；本地决定保留、逐项合并）/
// 重启一致性（对账确定性重建）/ 跨分支合流 / 服务端同构判定 / 报告导出。
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

/** 隔离 localStorage 的新窗口（HTTP 仍连同一内存服务端）：模拟两个独立浏览器窗口在线协作。 */
function isolatedStorage() {
  const own = new Map();
  const ls = { getItem: (k) => (own.has(k) ? own.get(k) : null), setItem: (k, v) => own.set(k, v), removeItem: (k) => own.delete(k) };
  return {
    ls,
    use() { activeLocalStorage = ls; },
    release() { activeLocalStorage = realLocalStorage; },
  };
}

const pendingTimers = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = _setTimeout(fn, ms, ...args);
  pendingTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); return _clearTimeout(id); };

const { Store } = await import('../web/js/geom/store.js');
const {
  createReviewSession, reconcileSession, recordDecision, mergeReviewItem,
  rebaseSession, completeReview, reopenReview, sanitizeReviewSessions,
  mergeReviewSessions, assessServerReviewConflict, buildReviewReport,
  sessionProgress, effectiveDecision, reviewTimelineHash, nodeFingerprint,
  normalizeReviewPolicy, signReviewNode, mergeReviewSignature, signatureState,
  activeSignatures, finalReviewVerdict,
  DRIFT_TEXT,
} = await import('../web/js/geom/reviews.js');
const { filterNodes, buildExport, stableStringify, exportChecksum } = await import('../web/js/geom/auditbench.js');
const { mergeDocs, MAIN_BRANCH } = await import('../web/js/geom/audit.js');

function makeHarness() {
  let gen = 0;
  // 内存服务端权威文档（独立于浏览器 localStorage，模拟真实 server.py）
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
      const reject = (info) => Promise.resolve({
        ok: false, status: 409, json: () => Promise.resolve({ rev: curRev, ...info }),
      });
      const accept = (doc, extra = {}) => { serverDoc = doc; return jsonOk({ ok: true, rev: doc.rev, ...extra }); };
      // 审阅会话乐观并发优先（与 server.py 一致）
      const rc = assessServerReviewConflict(serverDoc, body);
      if (rc) return reject({ error: 'review-conflict', ...rc, session: (serverDoc?.reviewSessions || []).find((x) => x.id === rc.sessionId) || null });
      if (body.baseRev !== curRev) {
        if (!serverDoc) {
          const doc = { ...body, rev: 1 };
          delete doc.baseRev; delete doc.baseHeads; delete doc.baseReviewRevs;
          return accept(doc);
        }
        // 与真实 server.py 一致：合流前先做审阅会话乐观锁/节点完整性判定
        const reviewVerdict = assessServerReviewConflict(serverDoc, body);
        if (reviewVerdict) {
          return reject({
            error: 'review-conflict', ...reviewVerdict,
            session: (serverDoc.reviewSessions || []).find((x) => x.id === reviewVerdict.sessionId) || null,
          });
        }
        const verdict = mergeVerdict(serverDoc, body);
        if (!verdict.mergeable) return reject(verdict);
        const merged = mergeDocs(serverDoc, body);
        merged.reviewSessions = mergeReviewSessions(serverDoc.reviewSessions || [], body.reviewSessions || []);
        delete merged.baseRev; delete merged.baseHeads; delete merged.baseReviewRevs;
        merged.rev = curRev + 1;
        return accept(merged, { merged: true, doc: merged });
      }
      // 与真实 server.py 一致：即使文档 rev 相同，审阅会话乐观锁/节点完整性也要先核验
      const sameRevReview = assessServerReviewConflict(serverDoc, body);
      if (sameRevReview) {
        return reject({
          error: 'review-conflict', ...sameRevReview,
          session: (serverDoc.reviewSessions || []).find((x) => x.id === sameRevReview.sessionId) || null,
        });
      }
      const doc0 = { ...body, rev: curRev + 1 };
      delete doc0.baseRev; delete doc0.baseHeads; delete doc0.baseReviewRevs;
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

// 与 server.py 同构的审阅冲突判定（测试模型用 JS 版即可，语义在 Python e2e 中复验）
function mergeVerdict(serverDoc, body) {
  const rc = assessServerReviewConflict(serverDoc, body);
  if (rc) return { mergeable: false, ...rc };
  // 分支合流判定（与现有 harness 一致：直接允许 mergeDocs）
  return { mergeable: true };
}

const harness = makeHarness();
activeFetch = harness.fetchImpl;

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
async function settle(s, expId) {
  for (let i = 0; i < 2000; i++) {
    const exp = s.experiments.find((x) => x.id === expId);
    if (exp && !exp.variants.some((v) => v.status === 'running' || v.status === 'queued')) return exp;
    await (exp && s._runners.has(expId) ? s._tick() : Promise.resolve());
  }
  throw new Error('settle timeout');
}

const moveRectSpec = (rect, x) => [{ name: '变体', rects: [{ id: rect, x }] }];

async function buildFixture() {
  const s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第一步' });
  s.commit((m) => { m.rects[0].x += 10; }, { label: '第二步' });
  const res = s.createExperiment(moveRectSpec(s.model.rects[0].id, 200), { name: '审阅实验' });
  await settle(s, res.experiment.id);
  await s.flushed();
  return { s, expId: res.experiment.id };
}

/* ---------- 创建快照 ---------- */

test('创建审阅会话：快照筛选条件、节点顺序、每节点指纹、基线哈希；节点初始未处理', async () => {
  const { s } = await buildFixture();
  s.setWorkbench({ filter: { branchId: MAIN_BRANCH } });
  const r = s.createReview('首次审阅');
  assert.equal(r.ok, true);
  const sess = r.session;
  assert.equal(sess.filter.branchId, MAIN_BRANCH);
  assert.ok(sess.baseline.timelineHash.length === 8);
  assert.ok(sess.baseline.orderHash.length === 8);
  assert.ok(sess.nodes.length >= 2);
  assert.ok(sess.nodes.every((n) => n.decision === 'pending' && n.fingerprint));
  // 会话顺序 = 当前筛选顺序
  const w = s.workbench();
  const list = filterNodes(w.nodes, sess.filter);
  assert.deepEqual(sess.nodes.map((n) => n.key), list.map((n) => n.key));
  assert.equal(s.activeReviewId, sess.id);
});

test('空筛选结果不能创建会话', async () => {
  const { s } = await buildFixture();
  s.setWorkbench({ filter: { text: '不可能存在的标题zzz' } });
  const r = s.createReview('空');
  assert.equal(r.ok, false);
});

test('纯函数：同输入两次创建的基线 timelineHash 一致（不依赖会话 id）', async () => {
  const { s } = await buildFixture();
  const w = s.workbench();
  const list = filterNodes(w.nodes, {});
  const a = createReviewSession({ name: 'a', nodes: list, branches: s.branches, now: 1000 });
  const b = createReviewSession({ name: 'b', nodes: list, branches: s.branches, now: 2000 });
  assert.equal(a.baseline.timelineHash, b.baseline.timelineHash);
  assert.equal(a.baseline.orderHash, b.baseline.orderHash);
});

/* ---------- 决定 / 进度 / 变更历史 ---------- */

test('记录通过/驳回/待复核与理由；驳回与待复核必须有理由；进度与未处理数正确', async () => {
  const { s } = await buildFixture();
  const r = s.createReview('审阅');
  const id = r.session.id;
  const nodes = r.session.nodes;
  const [n0, n1, n2] = nodes;
  assert.equal(s.submitReviewDecision(id, n0.key, 'pass', '').ok, true);
  assert.equal(s.submitReviewDecision(id, n1.key, 'reject', '').ok, false); // 理由必填
  assert.equal(s.submitReviewDecision(id, n1.key, 'reject', '冲突未消解').ok, true);
  // 无理由待复核也被拒绝
  assert.equal(s.submitReviewDecision(id, n2.key, 'review', '').ok, false);
  assert.equal(s.submitReviewDecision(id, n2.key, 'review', '需人工确认').ok, true);
  // 剩余节点全部通过
  for (const n of nodes.slice(3)) assert.equal(s.submitReviewDecision(id, n.key, 'pass', '').ok, true);
  const v = s.reviewView(id);
  assert.deepEqual({ pass: v.progress.pass, reject: v.progress.reject, review: v.progress.review, pending: v.progress.pending, done: v.progress.done, total: v.progress.total },
    { pass: nodes.length - 2, reject: 1, review: 1, pending: 0, done: nodes.length, total: nodes.length });
  assert.equal(v.progress.complete, true);
  const decided = v.session.nodes[0];
  assert.equal(decided.decidedBy, s.actor || '未署名');
  assert.ok(decided.decidedAt > 0);
});

test('修改决定追加变更记录（from→to + 理由 + 时间 + 决定人），相同决定不同理由也记录', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const key = s.activeReview.nodes[0].key;
  s.submitReviewDecision(id, key, 'pass', '初判');
  s.submitReviewDecision(id, key, 'reject', '复核发现冲突');
  s.submitReviewDecision(id, key, 'reject', '补充理由');
  const sn = s.reviewView(id).session.nodes.find((n) => n.key === key);
  assert.equal(sn.history.length, 2);
  assert.equal(sn.history[0].from, 'pass');
  assert.equal(sn.history[0].to, 'reject');
  assert.equal(sn.history[1].reason, '补充理由');
  assert.equal(sn.reason, '补充理由');
});

test('全部处理完可标记完成；完成后可重开；仍有未处理/待复核时完成被拒绝', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const nodes = s.activeReview.nodes;
  const r0 = s.completeReview(id);
  assert.equal(r0.ok, false);
  for (const n of nodes) assert.equal(s.submitReviewDecision(id, n.key, 'pass', '').ok, true);
  assert.equal(s.completeReview(id).ok, true);
  assert.equal(s.activeReview.status, 'completed');
  assert.equal(s.reopenReview(id).ok, true);
  assert.equal(s.activeReview.status, 'active');
});

/* ---------- 多人签署流程 ---------- */

function signPolicy(over = {}) {
  return { mode: 'signoff', signers: ['甲', '乙', '丙'], required: 2, completeRule: 'all-decided', ...over };
}

test('多人签署：按节点名单/人数/完成条件确认；未列入不能签，人数不足不能完成；报告列出已签未签', async () => {
  const { s } = await buildFixture();
  const created = s.createReview('多人审阅', { policy: signPolicy() });
  assert.equal(created.ok, true);
  const id = created.session.id;
  const key = created.session.nodes[0].key;
  s.setActor('甲');
  let res = s.submitReviewSignature(id, key, 'pass', '');
  assert.equal(res.ok, true);
  let sn = s.reviewView(id).session.nodes[0];
  assert.equal(signatureState(sn, created.session.policy).confirmed, false);
  assert.deepEqual(activeSignatures(sn).map((x) => x.by), ['甲']);
  assert.equal(s.completeReview(id).ok, false);

  s.setActor('外人');
  res = s.submitReviewSignature(id, key, 'pass', '');
  assert.equal(res.status, 403);
  assert.equal(res.reason, 'signer-not-allowed');
  assert.equal(s.reviewProposals(id).length, 0);

  s.setActor('乙');
  res = s.submitReviewSignature(id, key, 'pass', '');
  assert.equal(res.ok, true);
  sn = s.reviewView(id).session.nodes[0];
  const st = signatureState(sn, created.session.policy);
  assert.equal(st.confirmed, true);
  assert.equal(st.decision, 'pass');
  assert.deepEqual(st.active.map((x) => x.by), ['甲', '乙']);
  assert.deepEqual(st.unsignedSigners, ['丙']);
  assert.ok(sn.confirmedAt > 0);

  const report = s.reviewReport(id, { generatedAt: 'fixed' });
  const rn = report.nodes[0];
  assert.equal(rn.confirmed, true);
  assert.equal(rn.signing.activeCount, 2);
  assert.deepEqual(rn.signing.unsignedSigners, ['丙']);
  assert.equal(report.session.policy.required, 2);
});

test('多人签名重复提交幂等；同一签署人改判保留旧签名并标记 superseded；平票转待复核', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('签名幂等', { policy: signPolicy({ required: 2 }) }).session.id;
  const n0 = s.reviewSessionById(id).nodes[0].key;
  const n1 = s.reviewSessionById(id).nodes[1].key;
  s.setActor('甲');
  const first = s.submitReviewSignature(id, n0, 'pass', '');
  const revAfterFirst = s.reviewSessionById(id).rev;
  const again = s.submitReviewSignature(id, n0, 'pass', '');
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(s.reviewSessionById(id).rev, revAfterFirst);
  assert.equal(activeSignatures(s.reviewSessionById(id).nodes[0]).length, 1);

  // 同签署人改判：旧记录保留但立即失效，新签名生效
  s.submitReviewSignature(id, n0, 'reject', '发现问题');
  const sn0 = s.reviewSessionById(id).nodes[0];
  assert.equal(activeSignatures(sn0).length, 1);
  assert.equal(sn0.signatures[0].invalid.code, 'superseded');
  assert.equal(sn0.signatures[1].decision, 'reject');

  // 两票通过/驳回平票：确定性转待复核，节点仍已确认但聚合决定为 review
  s.setActor('甲');
  s.submitReviewSignature(id, n1, 'pass', '');
  s.setActor('乙');
  s.submitReviewSignature(id, n1, 'reject', '存在风险');
  const st1 = signatureState(s.reviewView(id).session.nodes[1], signPolicy());
  assert.equal(st1.confirmed, true);
  assert.equal(st1.decision, 'review');
});

test('完成条件 no-reject：节点均确认但有驳回时不能完成；改判通过后完成并给出最终判定', async () => {
  const { s } = await buildFixture();
  const policy = signPolicy({ required: 1, completeRule: 'no-reject' });
  const id = s.createReview('无驳回完成', { policy }).session.id;
  s.setActor('甲');
  for (const n of s.reviewSessionById(id).nodes) {
    s.submitReviewSignature(id, n.key, 'pass', '');
  }
  assert.equal(s.completeReview(id).ok, true);
  assert.equal(s.reopenReview(id).ok, true);
  const key = s.reviewSessionById(id).nodes[0].key;
  s.submitReviewSignature(id, key, 'reject', '重新发现问题');
  assert.equal(s.completeReview(id).ok, false);
  s.submitReviewSignature(id, key, 'pass', '问题已修复');
  const done = s.completeReview(id);
  assert.equal(done.ok, true);
  assert.equal(done.session.completedAt > 0, true);
});

test('多人节点指纹变化：已有签名保留、按原因失效、节点重新待签署；恢复后旧签名也不自动复活', async () => {
  const { s } = await buildFixture();
  const created = s.createReview('签名失效', { policy: signPolicy() });
  const id = created.session.id;
  const target = created.session.nodes[0].key;
  s.setActor('甲'); s.submitReviewSignature(id, target, 'pass', '');
  s.setActor('乙'); s.submitReviewSignature(id, target, 'pass', '');
  const w = s.workbench();
  let view = reconcileSession(s.reviewSessionById(id), w);
  assert.equal(activeSignatures(view.session.nodes[0]).length, 2);

  const live = w.byKey.get(target);
  const changed = structuredClone(live);
  changed.hashAfter = '11112222';
  const wbBad = { ...w, byKey: new Map(w.byKey).set(target, changed), nodes: w.nodes.map((n) => n.key === target ? changed : n) };
  view = reconcileSession(view.session, wbBad);
  let sn = view.session.nodes.find((n) => n.key === target);
  assert.equal(activeSignatures(sn).length, 0);
  assert.ok(sn.signatures.every((sg) => sg.invalid?.codes.includes('fingerprint-changed')));
  assert.equal(signatureState(sn, created.session.policy).confirmed, false);

  view = reconcileSession(view.session, w);
  sn = view.session.nodes.find((n) => n.key === target);
  assert.equal(activeSignatures(sn).length, 0);
  assert.ok(sn.autoReview === null);
  assert.ok(sn.signatures.every((sg) => sg.invalid?.code === 'fingerprint-changed'));
});

test('多人签名刷新后规则、签名顺序、失效原因与完成状态保持一致', async () => {
  let s = await freshStore();
  s.commit((m) => { m.rects[0].x += 33; }, { label: '签名基线' });
  const oldHead = s.branch.headEventId;
  const id = s.createReview('重启签名', { policy: signPolicy({ required: 2 }) }).session.id;
  const key = `event:${oldHead}`;
  s.setActor('甲'); s.submitReviewSignature(id, key, 'pass', '一');
  s.setActor('乙'); s.submitReviewSignature(id, key, 'reject', '二');
  s.undo();
  s.commit((m) => { m.rects[0].x += 77; }, { label: '新分支头' });
  await s.flushed();

  const doc = JSON.parse(JSON.stringify(s._payload()));
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  s2.selectReview(id);
  const sn1 = s2.reviewView(id).session.nodes.find((n) => n.key === key);
  assert.equal(sn1.signatures.length, 2);
  assert.ok(sn1.signatures.every((sg) => sg.invalid?.codes.includes('branch-advanced')));
  assert.equal(sn1.signatures[0].by, '甲');
  assert.equal(sn1.signatures[1].by, '乙');
  assert.equal(s2.reviewSessionById(id).policy.required, 2);
  assert.equal(s2.completeReview(id).ok, false);

  const s3 = new Store({ base: '', tickMs: 1 });
  await s3._adopt(JSON.parse(JSON.stringify(doc)), { seed: false });
  const sn2 = s3.reviewView(id).session.nodes.find((n) => n.key === key);
  assert.deepEqual(sn2.signatures.map((sg) => [sg.by, sg.invalid.code]), sn1.signatures.map((sg) => [sg.by, sg.invalid.code]));
});

test('两个窗口同时签同一节点：后提交者 409 且本地签名保留；逐项合并后节点确认', async () => {
  const { s: s1 } = await buildFixture();
  const id = s1.createReview('并发签名', { policy: signPolicy({ required: 2 }) }).session.id;
  await s1.flushed();
  const iso = isolatedStorage(); iso.use();
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  iso.release();

  const key = s1.reviewSessionById(id).nodes[0].key;
  s1.setActor('甲');
  assert.equal(s1.submitReviewSignature(id, key, 'pass', '窗口甲').ok, true);
  await s1.flushed();

  s2.setActor('乙');
  const local = s2.submitReviewSignature(id, key, 'pass', '窗口乙');
  assert.equal(local.ok, true);
  await s2.flushed();
  assert.equal(s2.reviewConflict?.reason, 'review-advanced');
  const prop = s2.reviewProposals(id).find((p) => p.type === 'signature' && p.by === '乙');
  assert.ok(prop);
  const merged = s2.mergeReviewItem(id, key, prop.decision, prop.reason, { proposal: prop, by: prop.by });
  assert.equal(merged.ok, true);
  await s2.flushed();
  const server = harness.doc.reviewSessions.find((x) => x.id === id);
  const sn = server.nodes.find((n) => n.key === key);
  assert.deepEqual(activeSignatures(sn).map((x) => x.by).sort(), ['乙', '甲']);
  assert.equal(signatureState(sn, server.policy).confirmed, true);
});

test('服务端校验：不在名单的新签名/同一签署人重复有效签名不能推进会话', () => {
  const mk = (by) => ({ id: 'sg' + by, seq: 0, at: 1, by, decision: 'pass', reason: '', invalid: null });
  const baseSession = {
    id: 'rp', rev: 2, policy: signPolicy({ required: 2 }),
    nodes: [{ key: 'event:e1', fingerprint: 'h1', branchId: 'main', signatures: [] }],
  };
  const server = {
    events: [{ id: 'e1', hash: 'h1', branch: 'main', parentId: null }],
    branches: [{ id: 'main', headEventId: 'e1' }], experiments: [],
    reviewSessions: [{ ...baseSession, rev: 1 }],
  };
  const badActor = {
    reviewSessions: [{ ...baseSession, nodes: [{ ...baseSession.nodes[0], signatures: [mk('外人')] }] }],
    baseReviewRevs: { rp: 1 },
  };
  assert.equal(assessServerReviewConflict(server, badActor).reason, 'review-signer-not-allowed');
  const dup = {
    reviewSessions: [{ ...baseSession, nodes: [{ ...baseSession.nodes[0], signatures: [mk('甲'), { ...mk('甲'), id: 'sg2' }] }] }],
    baseReviewRevs: { rp: 1 },
  };
  assert.equal(assessServerReviewConflict(server, dup).reason, 'review-duplicate-signer');
  const oldSig = mk('甲');
  const existingSigServer = {
    events: server.events, branches: server.branches, experiments: [],
    reviewSessions: [{
      ...baseSession, rev: 1,
      nodes: [{ ...baseSession.nodes[0], signatures: [oldSig], decision: 'pending' }],
    }],
  };
  const changedHistory = {
    reviewSessions: [{
      ...baseSession, rev: 2,
      nodes: [{ ...baseSession.nodes[0], signatures: [{ ...oldSig, reason: '历史被改写' }] }],
    }],
    baseReviewRevs: { rp: 1 },
  };
  assert.equal(assessServerReviewConflict(existingSigServer, changedHistory).reason, 'review-signature-history-changed');
  const shortCompleted = {
    reviewSessions: [{ ...baseSession, status: 'completed', rev: 2, nodes: [{ ...baseSession.nodes[0], signatures: [mk('甲')] }] }],
    baseReviewRevs: { rp: 1 },
  };
  assert.equal(assessServerReviewConflict(server, shortCompleted).reason, 'review-signature-shortfall');
});

/* ---------- 损坏 / 缺失 / 指纹变化 / 分支推进：自动转待复核 ---------- */

test('节点损坏（指纹校验失败）：原决定保留，有效状态转待复核并说明原因，冲突记录未决', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event');
  s.submitReviewDecision(id, target.key, 'pass', '通过');
  await s.flushed();

  // 篡改服务端文档中该事件的模型（保留 hash）→ 加载时重算指纹失败
  const doc = JSON.parse(JSON.stringify(harness.doc));
  const ev = doc.events.find((e) => e.id === target.key.slice(6));
  ev.model.canvas.w += 321;
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const v = s2.reviewView(id);
  const sn = v.session.nodes.find((n) => n.key === target.key);
  assert.equal(sn.decision, 'pass');                 // 原决定保留
  assert.equal(sn.reason, '通过');
  assert.equal(effectiveDecision(sn), 'review');     // 有效状态转待复核
  assert.ok(sn.autoReview.codes.includes('corrupt'));
  assert.match(sn.autoReview.reason, /损坏/);
  const open = v.session.conflicts.filter((c) => !c.resolved);
  assert.ok(open.some((c) => c.code === 'corrupt' && c.nodeKey === target.key));
  assert.equal(v.progress.needsWork >= 1, true);
});

test('节点缺失（事件/变体不在时间线）：absent 标记、原决定保留、转待复核；无法直接提交', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event');
  s.submitReviewDecision(id, target.key, 'reject', '驳回理由');
  await s.flushed();

  const doc = JSON.parse(JSON.stringify(harness.doc));
  doc.events = doc.events.filter((e) => e.id !== target.key.slice(6));
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const v = s2.reviewView(id);
  const sn = v.session.nodes.find((n) => n.key === target.key);
  assert.equal(sn.absent, true);
  assert.equal(sn.decision, 'reject');
  assert.equal(effectiveDecision(sn), 'review');
  assert.ok(sn.autoReview.codes.includes('node-missing'));
  // 直接提交被 409 拒绝，本地决定保留为提案
  const res = s2.submitReviewDecision(id, target.key, 'pass', '重试');
  assert.equal(res.status, 409);
  assert.equal(res.reason, 'node-missing');
  assert.equal(s2.reviewProposals(id).length, 1);
});

test('指纹变化（事件 hash 被外部改写且与记录一致地重算）：fingerprint-changed 转待复核', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event');
  s.submitReviewDecision(id, target.key, 'pass', '');
  await s.flushed();
  // 直接替换会话节点指纹为一个确定不存在的 8 位指纹（不触发损坏，只触发指纹漂移）
  const doc = JSON.parse(JSON.stringify(harness.doc));
  const rs = doc.reviewSessions.find((x) => x.id === id);
  rs.nodes.find((n) => n.key === target.key).fingerprint = '00000000';
  rs.conflicts = [];
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const sn = s2.reviewView(id).session.nodes.find((n) => n.key === target.key);
  assert.equal(effectiveDecision(sn), 'review');
  assert.ok(sn.autoReview.codes.includes('fingerprint-changed'));
});

test('分支推进（undo 后新提交产生支线）：支线事件节点转待复核，新链节点不转', async () => {
  let s = await freshStore();
  s.commit((m) => { m.rects[0].x += 30; }, { label: 'A' });
  const oldHead = s.branch.headEventId;
  const id = s.createReview('审阅').session.id;
  s.submitReviewDecision(id, `event:${oldHead}`, 'pass', '');
  s.undo();
  s.commit((m) => { m.rects[0].x += 80; }, { label: 'B' });
  await s.flushed();
  // 重载后对账：模拟刷新（从已保存文档装载；支线判定只依赖事件/分支数据）
  const doc = JSON.parse(JSON.stringify(s._payload()));
  s = new Store({ base: '', tickMs: 1 });
  await s._adopt(doc, { seed: false });
  s.selectReview(id);
  const v = s.reviewView(id);
  const oldSn = v.session.nodes.find((n) => n.key === `event:${oldHead}`);
  assert.equal(effectiveDecision(oldSn), 'review');
  assert.ok(oldSn.autoReview.codes.includes('branch-advanced'));
  assert.match(oldSn.autoReview.reason, /分支已推进/);
});

test('对账幂等：重复对账不产生重复冲突记录、不改变 rev，标注确定性', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event');
  s.submitReviewDecision(id, target.key, 'pass', '');
  await s.flushed();
  const doc = JSON.parse(JSON.stringify(harness.doc));
  doc.events.find((e) => e.id === target.key.slice(6)).model.canvas.w += 100;
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const revBefore = s2.reviewSessionById(id).rev;
  const v1 = s2.reviewView(id);
  const v2 = reconcileSession(v1.session, s2.workbench()).session;
  const v3 = reconcileSession(v2, s2.workbench()).session;
  const count = (sess) => sess.conflicts.filter((c) => c.code === 'corrupt' && c.nodeKey === target.key).length;
  assert.equal(count(v1.session), 1);
  assert.equal(count(v3), 1);
  assert.equal(revBefore, s2.reviewSessionById(id).rev);
  assert.deepEqual(JSON.parse(stableStringify(v1.session.nodes)), JSON.parse(stableStringify(v3.nodes)));
});

test('节点恢复后清除自动待复核并关闭派生冲突', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event');
  s.submitReviewDecision(id, target.key, 'pass', '');
  // 用纯函数模拟：先损坏后恢复
  const w = s.workbench();
  let view = reconcileSession(s.activeReview, w);
  const goodLive = w.byKey.get(target.key);
  // 制造一个指纹不同的 live 节点
  const tampered = structuredClone(goodLive);
  tampered.hashAfter = 'deadbeef';
  const wbBad = { ...w, byKey: new Map(w.byKey).set(target.key, tampered), nodes: w.nodes.map((n) => n.key === target.key ? tampered : n) };
  view = reconcileSession(view.session, wbBad);
  assert.ok(view.driftByKey.has(target.key));
  // 恢复
  view = reconcileSession(view.session, w);
  const sn = view.session.nodes.find((n) => n.key === target.key);
  assert.equal(sn.autoReview, null);
  assert.ok(view.session.conflicts.every((c) => c.nodeKey !== target.key || c.resolved));
});

/* ---------- 409 乐观并发：另一窗口 rev 前进 ---------- */

test('两个窗口审阅同一会话：后提交者收到 409（rev 前进），本地决定保留，几何编辑不被锁定', async () => {
  const { s: s1 } = await buildFixture();
  const created = s1.createReview('并发审阅');
  const id = created.session.id;
  await s1.flushed();

  // 第二窗口（独立 localStorage，连同一服务端）加载同一份文档
  const iso = isolatedStorage(); iso.use();
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  iso.release();
  assert.equal(s2.reviewSessionById(id).rev, 1); // 新会话创建后 rev=1
  // 窗口1先决定并保存
  const k1 = s1.activeReview.nodes[0].key;
  const r1 = s1.submitReviewDecision(id, k1, 'pass', '窗口1');
  assert.equal(r1.ok, true);
  await s1.flushed();
  assert.equal(s1.reviewSessionById(id).rev, 2);

  // 窗口2基于过期 rev 决定不同节点
  const k2 = s2.reviewSessionById(id).nodes[1].key;
  const r2 = s2.submitReviewDecision(id, k2, 'reject', '窗口2决定');
  assert.equal(r2.ok, true); // 本地先接受（节点未漂移）
  await s2.flushed();
  assert.ok(s2.reviewConflict, '应记录审阅冲突');
  assert.equal(s2.reviewConflict.sessionId, id);
  // 本地决定保留为提案
  const proposals = s2.reviewProposals(id);
  assert.ok(proposals.some((p) => p.nodeKey === k2 && p.decision === 'reject'));
  // 服务端最新会话已采用：含窗口1的决定，rev=2
  const adopted = s2.reviewSessionById(id);
  assert.equal(adopted.rev, 2);
  assert.equal(adopted.nodes.find((n) => n.key === k1).decision, 'pass');
  // 几何编辑不被审阅冲突锁定
  const commitRes = s2.commit((m) => { m.rects[0].x += 5; }, { label: '窗口2继续编辑' });
  assert.equal(commitRes.ok, true);
});

test('409 后逐项合并：采用本地决定落到最新快照，关闭冲突，rev 继续前进', async () => {
  const { s: s1 } = await buildFixture();
  const id = s1.createReview('并发审阅').session.id;
  await s1.flushed();
  const iso = isolatedStorage(); iso.use();
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  iso.release();

  const k1 = s1.activeReview.nodes[0].key;
  s1.submitReviewDecision(id, k1, 'pass', '窗口1');
  await s1.flushed();

  const k2 = s2.reviewSessionById(id).nodes[1].key;
  s2.submitReviewDecision(id, k2, 'reject', '窗口2理由');
  await s2.flushed();
  assert.ok(s2.reviewConflict);
  // 逐项合并：以本地决定强制接受
  const mr = s2.mergeReviewItem(id, k2, 'reject', '窗口2理由（合并）');
  assert.equal(mr.ok, true);
  await s2.flushed();
  assert.equal(s2.reviewConflict, null);
  const server = harness.doc.reviewSessions.find((x) => x.id === id);
  assert.equal(server.nodes.find((n) => n.key === k2).decision, 'reject');
  assert.ok(server.nodes.find((n) => n.key === k2).history.some((h) => h.merged));
  assert.equal(server.nodes.find((n) => n.key === k1).decision, 'pass'); // 窗口1决定保留
  assert.equal(s2.reviewProposals(id).length, 0);
});

test('409 后放弃本地提案：采用服务端值，提案清除', async () => {
  const { s: s1 } = await buildFixture();
  const id = s1.createReview('并发审阅').session.id;
  await s1.flushed();
  const iso = isolatedStorage(); iso.use();
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  iso.release();
  const k1 = s1.activeReview.nodes[0].key;
  s1.submitReviewDecision(id, k1, 'reject', '窗口1驳回');
  await s1.flushed();
  const k2 = s2.reviewSessionById(id).nodes[1].key;
  s2.submitReviewDecision(id, k2, 'review', '窗口2待复核');
  await s2.flushed();
  assert.equal(s2.reviewProposals(id).length, 1);
  s2.discardReviewProposal(id, k2);
  assert.equal(s2.reviewProposals(id).length, 0);
  // 会话节点 k2 仍是服务端状态 pending
  assert.equal(s2.reviewSessionById(id).nodes.find((n) => n.key === k2).decision, 'pending');
});

test('会话锁定期间提交直接 409 且保留提案，不写入会话', async () => {
  const { s: s1 } = await buildFixture();
  const id = s1.createReview('并发审阅').session.id;
  await s1.flushed();
  const iso = isolatedStorage(); iso.use();
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  iso.release();
  s1.submitReviewDecision(id, s1.activeReview.nodes[0].key, 'pass', 'w1');
  await s1.flushed();
  const k3 = s2.reviewSessionById(id).nodes[2].key;
  s2.submitReviewDecision(id, s2.reviewSessionById(id).nodes[1].key, 'pass', 'w2-a');
  await s2.flushed();
  const revLocked = s2.reviewSessionById(id).rev;
  const res = s2.submitReviewDecision(id, k3, 'reject', 'w2-b');
  assert.equal(res.status, 409);
  assert.equal(s2.reviewSessionById(id).rev, revLocked);
  assert.equal(s2.reviewProposals(id).length, 2);
});

/* ---------- 筛选基线变化 ---------- */

test('新节点进入筛选结果：基线漂移，未漂移节点仍可决定的提交被拒（baseline-changed），刷新基线后保留决定并接纳新节点', async () => {
  let s = await freshStore();
  s.commit((m) => { m.rects[0].x += 10; }, { label: 'A' });
  const id = s.createReview('审阅').session.id;
  const initialKeys = s.activeReview.nodes.map((n) => n.key);
  // 新提交产生一个新的事件节点
  s.commit((m) => { m.rects[0].x += 20; }, { label: 'B' });
  const v = s.reviewView(id);
  assert.equal(v.baselineChanged, true);
  assert.equal(v.newNodes.length, 1);
  // 对旧节点提交也被 baseline-changed 拒绝
  const oldKey = initialKeys.find((k) => k !== v.newNodes[0].key);
  const res = s.submitReviewDecision(id, oldKey, 'pass', '');
  assert.equal(res.status, 409);
  assert.equal(res.reason, 'baseline-changed');
  assert.equal(s.reviewProposals(id).length, 1);

  // 刷新基线：新节点纳入末尾之前（按时间线顺序），保留旧决定
  s.submitReviewDecision // noop
  s.discardReviewProposal(id, oldKey);
  // 先给一个旧节点决定（rebase 不要求基线一致）
  const rb = s.rebaseReview(id);
  assert.equal(rb.ok, true);
  assert.equal(rb.added, 1);
  const v2 = s.reviewView(id);
  assert.equal(v2.baselineChanged, false);
  assert.ok(v2.session.nodes.some((n) => n.key === v.newNodes[0].key && n.decision === 'pending'));
  // 基线冲突记录已关闭
  assert.ok(v2.session.conflicts.filter((c) => c.code === 'baseline-changed').every((c) => c.resolved));
});

test('刷新基线后顺序按最新时间线；缺失节点保留在末尾并保留决定', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  // 选一个 edit-event（叶子节点，删除后不连累其他事件）
  const target = [...s.activeReview.nodes].reverse().find((n) => n.kind === 'edit-event').key;
  s.submitReviewDecision(id, target, 'pass', '决定保留');
  await s.flushed();
  const doc = JSON.parse(JSON.stringify(harness.doc));
  doc.events = doc.events.filter((e) => e.id !== target.slice(6));
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const before = s2.reviewView(id).session.nodes;
  const rb = s2.rebaseReview(id);
  assert.equal(rb.ok, true);
  const after = rb.session.nodes;
  const missing = after.find((n) => n.key === target);
  assert.equal(missing.absent, true);
  assert.equal(missing.decision, 'pass');
  // 缺失节点在末尾
  assert.equal(after[after.length - 1].key, target);
  // 其他节点按当前筛选顺序
  const liveKeys = after.filter((n) => !n.absent).map((n) => n.key);
  const expectKeys = filterNodes(s2.workbench().nodes, rb.session.filter).map((n) => n.key);
  assert.deepEqual(liveKeys, expectKeys);
});

/* ---------- 重启一致性 ---------- */

test('刷新/重启后会话、进度、决定顺序、理由、变更记录与冲突记录全部保持', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('持久审阅').session.id;
  const nodes = s.activeReview.nodes;
  s.submitReviewDecision(id, nodes[0].key, 'pass', '');
  s.submitReviewDecision(id, nodes[1].key, 'reject', '驳回');
  s.submitReviewDecision(id, nodes[1].key, 'pass', '改判通过');
  await s.flushed();

  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  assert.equal(s2.activeReviewId, id);
  const sess = s2.activeReview;
  assert.equal(sess.name, '持久审阅');
  assert.deepEqual(sess.nodes.map((n) => n.key), nodes.map((n) => n.key));
  assert.equal(sess.nodes[0].decision, 'pass');
  assert.equal(sess.nodes[1].reason, '改判通过');
  assert.equal(sess.nodes[1].history.length, 1);
  const p = s2.reviewView(id).progress;
  assert.equal(p.pass, 2);
  assert.equal(sess.nodes.length - p.done, p.needsWork);
});

test('损坏导致的转待复核与冲突记录在重启后确定性重建（同 id、同原因）', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event').key;
  s.submitReviewDecision(id, target, 'pass', '');
  await s.flushed();
  const doc = JSON.parse(JSON.stringify(harness.doc));
  doc.events.find((e) => e.id === target.slice(6)).model.canvas.w += 500;
  harness.doc = doc;

  const s1 = new Store({ base: '', tickMs: 1 });
  await s1.load();
  const c1 = s1.activeReview.conflicts.filter((c) => c.nodeKey === target).map((c) => c.id);
  const reason1 = s1.activeReview.nodes.find((n) => n.key === target).autoReview.reason;

  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  const c2 = s2.activeReview.conflicts.filter((c) => c.nodeKey === target).map((c) => c.id);
  const reason2 = s2.activeReview.nodes.find((n) => n.key === target).autoReview.reason;
  assert.deepEqual(c1, c2);
  assert.equal(reason1, reason2);
});

/* ---------- 合流 / 服务端同构判定 ---------- */

test('不同分支编辑与审阅会话跨分支合流：会话并集，两边内容都保留', async () => {
  const { s: s1 } = await buildFixture();
  const id = s1.createReview('会话A').session.id;
  await s1.flushed();
  // 另一窗口在新分支上编辑（不同分支 → merged 路径）
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2.load();
  s2.forkFromEvent(s2.events[0].id, '合流分支');
  s2.commit((m) => { m.rects[0].x += 7; }, { label: '分支编辑' });
  await s2.flushed();
  const merged = harness.doc;
  assert.ok(merged.reviewSessions.some((x) => x.id === id));
  assert.ok(merged.branches.some((b) => b.name === '合流分支'));
});

test('mergeReviewSessions：按 id 并集，rev 大者胜，冲突记录并集', () => {
  const mk = (id, rev, dec, conflicts = []) => ({
    id, rev, nodes: [{ key: 'event:x', decision: dec, history: [] }], conflicts,
  });
  const out = mergeReviewSessions(
    [mk('a', 3, 'pass', [{ id: 'c1', resolved: false }])],
    [mk('a', 2, 'reject', [{ id: 'c2', resolved: false }]), mk('b', 1, 'pending')],
  );
  const a = out.find((x) => x.id === 'a');
  assert.equal(a.rev, 3);
  assert.equal(a.nodes[0].decision, 'pass');
  const cids = a.conflicts.map((c) => c.id).sort();
  assert.deepEqual(cids, ['c1', 'c2']);
  assert.ok(out.some((x) => x.id === 'b'));
});

test('assessServerReviewConflict：未推进会话不拦截几何保存；推进会话 rev 不符 → review-advanced', () => {
  const mkSession = (id, rev) => ({ id, rev, nodes: [{ key: 'event:e1', fingerprint: 'h1', branchId: 'main' }] });
  const server = {
    events: [{ id: 'e1', hash: 'h1', branch: 'main', parentId: null }],
    branches: [{ id: 'main', headEventId: 'e1' }],
    experiments: [],
    reviewSessions: [mkSession('r1', 2)],
  };
  // 未推进（同 rev 重放保存）：不拦截
  assert.equal(assessServerReviewConflict(server, {
    reviewSessions: [mkSession('r1', 2)],
    baseReviewRevs: { r1: 2 },
  }), null);
  // 推进且基线落后：review-advanced
  const conflict = assessServerReviewConflict(server, {
    reviewSessions: [mkSession('r1', 3)],
    baseReviewRevs: { r1: 1 },
  });
  assert.equal(conflict.reason, 'review-advanced');
  // 新会话（服务端没有）：不拦截
  assert.equal(assessServerReviewConflict(server, {
    reviewSessions: [mkSession('r9', 1)],
    baseReviewRevs: { r9: 0 },
  }), null);
});

test('assessServerReviewConflict：节点缺失 / 指纹变化 / 分支推进', () => {
  const server = {
    events: [
      { id: 'e0', hash: 'h0', branch: 'main', parentId: null },
      { id: 'e1', hash: 'h1', branch: 'main', parentId: 'e0' },
    ],
    branches: [
      { id: 'main', headEventId: 'e1' },
      { id: 'b2', headEventId: 'e0' },
    ],
    experiments: [],
    reviewSessions: [],
  };
  // 指纹变化
  let c = assessServerReviewConflict(server, {
    reviewSessions: [{ id: 'r', rev: 2, nodes: [{ key: 'event:e1', fingerprint: 'OLD', branchId: 'main' }] }],
    baseReviewRevs: { r: 1 },
  });
  assert.equal(c.reason, 'review-fingerprint-changed');
  // 节点缺失
  c = assessServerReviewConflict(server, {
    reviewSessions: [{ id: 'r', rev: 2, nodes: [{ key: 'event:gone', fingerprint: 'h', branchId: 'main' }] }],
    baseReviewRevs: { r: 1 },
  });
  assert.equal(c.reason, 'review-node-missing');
  // 分支推进：e1 不在分支 b2 的链上
  c = assessServerReviewConflict(server, {
    reviewSessions: [{ id: 'r', rev: 2, nodes: [{ key: 'event:e1', fingerprint: 'h1', branchId: 'b2' }] }],
    baseReviewRevs: { r: 1 },
  });
  assert.equal(c.reason, 'review-branch-advanced');
  // 合法推进（同指纹、在链上）
  assert.equal(assessServerReviewConflict(server, {
    reviewSessions: [{ id: 'r', rev: 2, nodes: [{ key: 'event:e1', fingerprint: 'h1', branchId: 'main' }] }],
    baseReviewRevs: { r: 1 },
  }), null);
});

/* ---------- 逐项合并（纯函数）/ 刷新基线纯函数 ---------- */

test('mergeReviewItem：漂移节点也可强制合并，关闭该节点未决冲突，保留 absent', async () => {
  const { s } = await buildFixture();
  const sess0 = s.createReview('审阅').session;
  const w = s.workbench();
  let view = reconcileSession(sess0, w);
  const target = view.session.nodes[0].key;
  // 制造漂移
  const tampered = structuredClone(w.byKey.get(target));
  tampered.hashAfter = 'abcd1234';
  const wbBad = { ...w, byKey: new Map(w.byKey).set(target, tampered), nodes: w.nodes.map((n) => n.key === target ? tampered : n) };
  view = reconcileSession(view.session, wbBad);
  const res = mergeReviewItem(view.session, target, 'reject', '确认驳回最新状态');
  assert.equal(res.status, 200);
  const sn = res.session.nodes.find((n) => n.key === target);
  assert.equal(sn.decision, 'reject');
  assert.equal(sn.autoReview, null);
  assert.ok(res.session.conflicts.filter((c) => c.nodeKey === target).every((c) => c.resolved));
  assert.equal(res.session.rev, sess0.rev + 1);
});

/* ---------- 导出审阅报告 ---------- */

test('审阅报告含快照、进度、每节点决定理由、变更记录、冲突与当前漂移；输出确定 + 校验和', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('报告审阅').session.id;
  const n0 = s.activeReview.nodes[0];
  s.submitReviewDecision(id, n0.key, 'reject', '报告驳回理由');
  const report = s.reviewReport(id, { generatedAt: 'fixed' });
  assert.equal(report.format, 'rect-constraints/review-report');
  assert.equal(report.session.name, '报告审阅');
  assert.equal(report.filter.branchId, null);
  assert.ok(report.baseline.timelineHash);
  assert.equal(report.progress.total, s.activeReview.nodes.length);
  const node = report.nodes.find((n) => n.key === n0.key);
  assert.equal(node.decision, 'reject');
  assert.equal(node.reason, '报告驳回理由');
  assert.equal(report.changeLog.length, 1);
  assert.equal(report.changeLog[0].to, 'reject');
  assert.ok(Array.isArray(report.conflicts));
  // 确定性
  const t1 = stableStringify(report);
  const t2 = stableStringify(JSON.parse(JSON.stringify(report)));
  assert.equal(t1, t2);
  assert.match(exportChecksum(t1), /^[0-9a-f]{8}$/);
});

test('报告中漂移节点 effectiveDecision=review 且带 autoReview 原因与当前指纹', async () => {
  const { s } = await buildFixture();
  const id = s.createReview('审阅').session.id;
  const target = s.activeReview.nodes.find((n) => n.kind === 'edit-event');
  s.submitReviewDecision(id, target.key, 'pass', '');
  await s.flushed();
  const doc = JSON.parse(JSON.stringify(harness.doc));
  doc.events.find((e) => e.id === target.key.slice(6)).model.canvas.w += 900;
  const s2 = new Store({ base: '', tickMs: 1 });
  await s2._adopt(doc, { seed: false });
  const report = s2.reviewReport(id, { generatedAt: 'fixed' });
  const node = report.nodes.find((n) => n.key === target.key);
  assert.equal(node.decision, 'pass');
  assert.equal(node.effectiveDecision, 'review');
  assert.ok(node.autoReview.reason);
  assert.equal(report.openConflicts.some((c) => c.nodeKey === target.key), true);
});

/* ---------- 加载清洗容错 ---------- */

test('sanitizeReviewSessions：丢弃无节点/重复/结构损坏会话，非法决定归一，字段裁剪', async () => {
  const { s } = await buildFixture();
  const w = s.workbench();
  const good = createReviewSession({ name: 'good', nodes: filterNodes(w.nodes, {}).slice(0, 2), branches: s.branches });
  const raw = [
    null,
    { id: 'rv_empty', name: '无节点', nodes: [] },
    { id: good.id, name: '重复', nodes: good.nodes },
    good,
    {
      id: 'rv_weird', name: 12345, nodes: [{
        key: 'event:x', decision: 'bogus', reason: 777, fingerprint: 'zz',
        history: [{ to: 'pass', from: 'weird' }, { to: 'bad' }],
      }],
      conflicts: [{ id: 'c', code: 'corrupt' }, null, { noid: true }],
      baseline: { timelineHash: 't' }, rev: -5,
    },
  ];
  // 不传 workbench：只验证结构清洗 / 字段裁剪（不做对账派生冲突）
  const out = sanitizeReviewSessions(raw, null);
  assert.equal(out.length, 2);
  const weird = out.find((x) => x.id === 'rv_weird');
  assert.equal(weird.nodes[0].decision, 'pending');
  assert.equal(weird.nodes[0].reason, '777');
  assert.equal(weird.nodes[0].history.length, 1); // 只保留合法 to
  assert.equal(weird.rev, 1);
  assert.equal(weird.conflicts.length, 1);
});

/* ---------- 注册：串行 suite ---------- */

const _realFetch = globalThis.fetch;
const _realLocalStorage = globalThis.localStorage;
const _realSetTimeout = globalThis.setTimeout;
const _realClearTimeout = globalThis.clearTimeout;

rawTest('可恢复审阅会话', { concurrency: false }, async (t) => {
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
