/*
 * 发布门禁与证据快照：纯函数模块（无 DOM / 存储依赖）。
 *
 * 用户可以从一个审阅会话创建发布候选（release candidate）。创建时冻结一份
 * 不可变【证据快照】：创建时刻的筛选条件、节点顺序、每个节点的最新决定与签署
 * 状态、实验来源（含实验/变体指纹）与通知处理摘要（事件数 / 通知项状态分布 /
 * FIFO 队列内容），并明确列出缺失、过期（stale）或待复核项。
 *
 * 门禁（gate）只有在以下条件全部满足时才放行：
 *   - 每个节点都达到策略配置的有效签署人数（required）；
 *   - 没有待复核（含系统自动转待复核 autoReview）、没有未决冲突记录；
 *   - 没有损坏（corrupt）、缺失（missing）节点，没有指纹漂移 / 分支推进；
 *   - 会话基线没有变化（baselineChanged=false）；
 *   - 通知队列没有未处理项：FIFO outbox 为空，且没有待处理（actionable）通知项。
 *
 * 审批期间如果原审阅会话、实验分支或通知状态发生变化，候选被确定性地标记为
 * 【过期（stale）】并阻止批准，用户必须【重新生成快照】（旧候选保留为
 * superseded，新快照另立候选 id，完整审计链不丢）。
 *
 * 多个窗口同时审批同一候选：候选带单调递增 rev，保存携带 baseReleaseRevs，
 * 后提交者收到 409 release-advanced，本地审批意见（approver / comment）原样
 * 保留为提案，可在最新 rev 上重试或放弃。
 *
 * 已批准候选可以撤销（必须填写撤销原因），撤销记录与完整审计链永久保留。
 *
 * 候选、证据内容、门禁结果、审批意见、撤销记录与报告导出全部随文档持久化；
 * 加载时的对账（reconcileRelease / releaseView）是确定性、幂等的纯函数：
 * 刷新、重启、跨窗口合流后门禁结果与过期标注逐字节一致。
 */

import { uid } from './model.js';
import { hash32 } from './experiments.js';
import {
  normalizeFilter, normalizeActor, normalizeReviewPolicy, signatureState,
  activeSignatures, nodeFingerprint, reviewFilterHash, reviewOrderHash,
  reconcileSession, sessionProgress,
} from './reviews.js';
import { filterNodes } from './auditbench.js';

export const RELEASE_FORMAT = 1;

/** 候选生命周期：pending（待批准）→ approved（已批准）→ revoked（已撤销）；重新生成后旧候选为 superseded。 */
export const RELEASE_STATES = ['pending', 'approved', 'revoked', 'superseded'];

/** 门禁检查项（固定顺序；blocking=true 的检查项不过则阻止批准）。 */
export const GATE_CHECKS = [
  { code: 'session-exists', blocking: true },
  { code: 'nodes-all-confirmed', blocking: true },
  { code: 'no-review-pending', blocking: true },
  { code: 'no-missing-nodes', blocking: true },
  { code: 'no-corrupt-nodes', blocking: true },
  { code: 'no-fingerprint-drift', blocking: true },
  { code: 'no-branch-advanced', blocking: true },
  { code: 'no-open-conflicts', blocking: true },
  { code: 'baseline-current', blocking: true },
  { code: 'policy-satisfied', blocking: true },
  { code: 'notify-outbox-empty', blocking: true },
  { code: 'notify-no-actionable', blocking: true },
  { code: 'notify-no-scheduled', blocking: false }, // 未到期通知不阻止发布，只提示
  { code: 'experiments-intact', blocking: true },
  { code: 'branches-intact', blocking: true },
];

export const GATE_TEXT = {
  'session-exists': '原审阅会话仍存在',
  'nodes-all-confirmed': '所有节点达到配置的有效签署人数',
  'no-review-pending': '没有待复核 / 系统转待复核项',
  'no-missing-nodes': '没有缺失节点（审计事件 / 完成变体结果仍在时间线中）',
  'no-corrupt-nodes': '没有损坏（不可回放）节点',
  'no-fingerprint-drift': '节点指纹与证据快照一致（无漂移）',
  'no-branch-advanced': '没有节点所属分支已推进（支线事件）',
  'no-open-conflicts': '没有未决冲突记录',
  'baseline-current': '会话筛选基线与当前时间线一致',
  'policy-satisfied': '会话多人签署策略满足（完成条件 / 有效签名数）',
  'notify-outbox-empty': '通知发送队列（FIFO outbox）没有未处理项',
  'notify-no-actionable': '没有待处理通知项（待发送 / 已送达未确认 / 稍后 / 失败 / 静音延迟）',
  'notify-no-scheduled': '没有尚未到期的待发送通知（不阻止发布）',
  'experiments-intact': '快照中的实验与变体结果仍存在且指纹一致',
  'branches-intact': '快照引用的编辑分支仍存在（head 推进由过期判定拦截）',
};

/** 过期原因（对账确定性派生；approved / revoked 候选不被重新标记过期）。 */
export const STALE_TEXT = {
  'release-session-changed': '原审阅会话已变化（决定 / 签名 / 冲突 / 完成状态），证据快照已过期',
  'release-node-drift': '快照节点发生缺失 / 损坏 / 指纹漂移 / 分支推进，证据快照已过期',
  'release-baseline-changed': '审阅会话筛选基线已变化，证据快照已过期',
  'release-branch-changed': '相关编辑分支 head 已推进，证据快照已过期',
  'release-experiment-changed': '实验 / 变体结果发生变化（新增结果 / 指纹漂移 / 来源变化），证据快照已过期',
  'release-notify-changed': '通知状态发生变化（新事件 / 新通知项 / 队列变化 / 送达确认），证据快照已过期',
};

const ACTIONABLE = new Set(['pending', 'sent', 'delivered', 'snoozed', 'failed', 'deferred']);

/* ------------------------------- 工具 ------------------------------- */

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

function digest(v) { return hash32(canonical(v)); }

function clampReason(reason) { return String(reason || '').trim().slice(0, 2000); }

/* ------------------------------- 证据冻结 ------------------------------- */

function freezeNodeEvidence(sn) {
  const st = signatureState(sn, sn.policy);
  const signatures = (sn.signatures || []).slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.at || 0) - (b.at || 0) || (a.id < b.id ? -1 : 1))
    .map((sg) => ({
      id: sg.id, seq: sg.seq ?? 0, at: sg.at ?? 0, by: sg.by,
      decision: sg.decision, reason: sg.reason || '',
      invalid: sg.invalid ? { code: sg.invalid.code || 'invalid', codes: sg.invalid.codes || [sg.invalid.code || 'invalid'] } : null,
    }));
  return {
    key: sn.key,
    order: sn.order ?? 0,
    kind: sn.kind || null,
    title: sn.title || sn.key,
    branchId: sn.branchId || null,
    experimentId: sn.experimentId || null,
    variantId: sn.variantId || null,
    seqLabel: sn.seqLabel || null,
    fingerprint: typeof sn.fingerprint === 'string' ? sn.fingerprint : null,
    fingerprintBefore: typeof sn.fingerprintBefore === 'string' ? sn.fingerprintBefore : null,
    replayable: sn.replayable !== false,
    severity: ['ok', 'warn', 'bad'].includes(sn.severity) ? sn.severity : 'ok',
    absent: !!sn.absent,
    autoReview: sn.autoReview ? {
      code: sn.autoReview.code || 'auto-review',
      codes: Array.isArray(sn.autoReview.codes) ? sn.autoReview.codes : [sn.autoReview.code || 'auto-review'],
      reason: sn.autoReview.reason || '',
      at: sn.autoReview.at ?? 0,
    } : null,
    decision: ['pass', 'reject', 'review', 'pending'].includes(sn.decision) ? sn.decision : 'pending',
    reason: sn.reason || '',
    decidedBy: sn.decidedBy || null,
    decidedAt: sn.decidedAt ?? null,
    confirmed: !!st.confirmed,
    confirmedAt: sn.confirmedAt ?? null,
    effectiveDecision: sn.autoReview ? 'review' : st.decision,
    activeCount: st.active.length,
    activeSigners: st.active.map((s) => s.by),
    counts: { pass: st.counts.pass, reject: st.counts.reject, review: st.counts.review },
    signatures,
  };
}

function freezeSessionEvidence(session, view) {
  const v = view?.session ? view.session : session;
  const policy = normalizeReviewPolicy(v.policy);
  const progress = view?.progress || sessionProgress(v);
  const openConflicts = (v.conflicts || []).filter((c) => !c.resolved)
    .map((c) => ({ id: c.id, code: c.code || 'conflict', nodeKey: c.nodeKey || null, text: c.text || '', at: c.at ?? 0 }));
  const nodes = v.nodes.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(freezeNodeEvidence);
  const branchHeads = {};
  for (const [bid, head] of Object.entries(v.baseline?.branchHeads || {})) {
    branchHeads[bid] = typeof head === 'string' ? head : null;
  }
  return {
    sessionId: v.id,
    sessionName: v.name,
    sessionRev: v.rev,
    status: v.status === 'completed' ? 'completed' : 'active',
    createdBy: v.createdBy || '未署名',
    createdAt: v.createdAt ?? 0,
    completedAt: v.completedAt ?? null,
    filter: normalizeFilter(v.filter),
    policy: { ...policy },
    baseline: {
      filterHash: v.baseline?.filterHash || reviewFilterHash(v.filter || {}),
      orderHash: v.baseline?.orderHash || reviewOrderHash(nodes.map((n) => n.key)),
      timelineHash: v.baseline?.timelineHash || '',
      total: v.baseline?.total ?? nodes.length,
      replayable: v.baseline?.replayable ?? nodes.filter((n) => n.replayable).length,
      bad: v.baseline?.bad ?? nodes.filter((n) => n.severity === 'bad').length,
      warn: v.baseline?.warn ?? nodes.filter((n) => n.severity === 'warn').length,
      branchHeads,
    },
    progress: {
      total: progress.total, confirmed: progress.confirmed, pass: progress.pass,
      reject: progress.reject, review: progress.review, pending: progress.pending,
      needsWork: progress.needsWork, percent: progress.percent, complete: !!progress.complete,
    },
    openConflicts,
    nodes,
  };
}

/** 收集快照节点引用到的实验（来源身份 + 完成变体指纹）。 */
function freezeExperimentEvidence(ev, ctx) {
  const expIds = new Set();
  for (const sn of ev.nodes) if (sn.experimentId) expIds.add(sn.experimentId);
  const experiments = [];
  for (const exp of ctx.experiments || []) {
    if (!exp || !expIds.has(exp.id)) continue;
    const variants = (exp.variants || []).map((v) => ({
      id: v.id, name: v.name || v.id, order: v.order ?? 0,
      status: ['queued', 'running', 'done', 'failed', 'cancelled'].includes(v.status) ? v.status : 'queued',
      hash: v.status === 'done' && v.result ? (v.result.hash || null) : null,
      corrupt: !!v.corrupt,
    })).sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1));
    experiments.push({
      id: exp.id, name: exp.name || exp.id,
      sourceEventId: exp.source?.eventId || null,
      sourceBranchId: exp.source?.branchId || null,
      configHash: exp.configHash || null,
      baseHash: typeof exp.baseHash === 'string' ? exp.baseHash : null,
      baseCorrupt: !!exp.baseCorrupt,
      runState: exp.runState || 'done',
      variants,
    });
  }
  experiments.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    experiments,
    hash: digest(experiments),
  };
}

function freezeBranchEvidence(ev, ctx) {
  const ids = new Set();
  for (const sn of ev.nodes) if (sn.branchId) ids.add(sn.branchId);
  for (const bid of Object.keys(ev.baseline.branchHeads || {})) ids.add(bid);
  const branches = [];
  for (const b of ctx.branches || []) {
    if (!b || !ids.has(b.id)) continue;
    branches.push({ id: b.id, name: b.name || b.id, headEventId: b.headEventId || null, rootEventId: b.rootEventId || null });
  }
  branches.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { branches, hash: digest(branches) };
}

/**
 * 通知处理摘要冻结：事件数 / 通知项按状态分布 / 待处理项明细 / FIFO 队列条目 /
 * 规则版本（规则修订后会物化新通知项，因此规则 rev 也参与摘要）。
 */
export function freezeNotifySummary(notify = {}) {
  const events = (notify.events || []).filter((e) => e && typeof e.id === 'string');
  const items = (notify.items || []).filter((n) => n && typeof n.id === 'string');
  const rules = (notify.rules || []).filter((r) => r && typeof r.id === 'string');
  const outbox = (notify.outbox || []).filter((o) => o && typeof o.notifyId === 'string');

  const byStatus = {};
  for (const it of items) byStatus[it.status] = (byStatus[it.status] || 0) + 1;
  const actionable = items.filter((it) => ACTIONABLE.has(it.status))
    .map((it) => ({ id: it.id, status: it.status, recipient: it.recipient, eventType: it.eventType || null, level: it.level ?? 0 }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const queued = outbox.slice()
    .sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0) || (a.seq ?? 0) - (b.seq ?? 0) || (a.id < b.id ? -1 : 1))
    .map((o) => ({ id: o.id, notifyId: o.notifyId, seq: o.seq ?? 0, enqueuedAt: o.enqueuedAt ?? 0, attempts: o.attempts ?? 0, status: o.status || 'queued' }));
  const ruleRevs = rules.slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((r) => ({ id: r.id, rev: r.rev ?? 1, deleted: !!r.deleted, deleteRev: r.deleteRev ?? null, enabled: r.enabled !== false }));
  const eventIds = events.map((e) => e.id).sort();
  const itemStates = items.map((n) => ({ id: n.id, status: n.status, ackedAt: n.ackedAt ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    eventCount: events.length,
    itemCount: items.length,
    byStatus,
    actionableCount: actionable.length,
    actionable,
    queued,
    rules: ruleRevs,
    stateHash: digest({ eventIds, itemStates, queued, ruleRevs }),
  };
}

/* ------------------------------- 创建候选 ------------------------------- */

/**
 * 从一个审阅会话创建发布候选：冻结证据快照，并在创建时刻运行一次门禁。
 * 会话不存在 / 快照没有节点时拒绝。门禁不过不阻止创建（结果连同原因一起展示）。
 */
export function createReleaseCandidate(session, view, ctx, {
  name = '', actor = '', now = Date.now(), notify = null, gatePolicy = {},
} = {}) {
  if (!session || typeof session.id !== 'string') throw new Error('审阅会话不存在，无法创建发布候选');
  const v = view?.session ? view : reconcileSession(session, ctx.workbench, { now });
  const sess = v.session;
  if (!Array.isArray(sess.nodes) || !sess.nodes.length) throw new Error('审阅会话没有快照节点，无法创建发布候选');
  const policy = normalizeGatePolicy(gatePolicy);
  const fSession = freezeSessionEvidence(sess, v);
  const fExperiments = freezeExperimentEvidence(fSession, ctx);
  const fBranches = freezeBranchEvidence(fSession, ctx);
  const fNotify = freezeNotifySummary(notify || defaultNotify(ctx));

  const evidence = {
    frozenAt: now,
    frozenBy: normalizeActor(actor),
    filter: fSession.filter,
    order: fSession.nodes.map((n) => n.key),
    session: fSession,
    sessionDigest: digest(fSession),
    experiments: fExperiments,
    branches: fBranches,
    notify: fNotify,
  };
  evidence.evidenceHash = digest({
    filter: evidence.filter,
    order: evidence.order,
    sessionDigest: evidence.sessionDigest,
    experiments: fExperiments.hash,
    branches: fBranches.hash,
    notify: fNotify.stateHash,
    frozenAt: now,
  });

  const gate = evaluateGate(sess, v, ctx, { notify: fNotify, policy, now });
  return {
    id: uid('rc'),
    formatVersion: RELEASE_FORMAT,
    name: String(name || '').trim().slice(0, 60) || `发布候选 ${new Date(now).toLocaleString()}`,
    sessionId: sess.id,
    sessionName: sess.name,
    candidateNo: 1,
    supersedesId: null,
    createdBy: normalizeActor(actor),
    createdAt: now,
    updatedAt: now,
    state: 'pending',
    evidence,
    gate,
    gatePolicy: policy,
    approvals: [],
    revocation: null,
    history: [{ at: now, by: normalizeActor(actor), action: 'created', detail: '证据快照冻结，门禁首次评估' }],
    rev: 1,
  };
}

/* ------------------------------- 门禁策略 ------------------------------- */

export function normalizeGatePolicy(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const requireSessionCompleted = r.requireSessionCompleted !== false; // 默认要求会话已标记完成
  return {
    mode: 'gate',
    requireSessionCompleted,
    requireNoReject: r.requireNoReject === true, // 可选：显式要求最终无驳回（默认沿用会话 policy）
  };
}

/* ------------------------------- 门禁评估 ------------------------------- */

function checkEntry(code, ok, detail, { blocking = true } = {}) {
  return {
    code, label: GATE_TEXT[code] || code, ok: !!ok, blocking: blocking !== false,
    detail: detail || (ok ? '通过' : '未通过'),
  };
}

function nodeDrift(evNode, liveNode) {
  if (!liveNode) return 'missing';
  const fp = evNode.fingerprint;
  if (fp) {
    const liveFp = nodeFingerprint(liveNode);
    if (liveFp && liveFp !== fp) return 'fingerprint';
  }
  if (evNode.replayable && !liveNode.replayable) return 'corrupt';
  if (Array.isArray(liveNode.badges) && liveNode.badges.some((b) => b.code === 'branch-advanced')) return 'branch-advanced';
  return null;
}

/**
 * 在给定上下文上（重新）评估门禁。ctx: { workbench:{nodes,byKey}, sessions, branches, experiments }
 * frozenNotify 用证据快照里的摘要（批准时必须同时仍未过期）。
 */
export function evaluateGate(session, view, ctx, { notify = null, policy = null, now = Date.now() } = {}) {
  const gatePolicy = normalizeGatePolicy(policy);
  const checks = [];
  const blockers = [];
  const add = (code, ok, detail, opts) => {
    const e = checkEntry(code, ok, detail, opts ?? (GATE_CHECKS.find((c) => c.code === code) || { blocking: true }));
    checks.push(e);
    if (!e.ok && e.blocking) blockers.push(code);
    return e;
  };

  if (!session) {
    for (const c of GATE_CHECKS) add(c.code, false, '原审阅会话不存在');
    return gateResult(checks, blockers, now);
  }
  const v = view?.session ? view : reconcileSession(session, ctx.workbench, { now });
  const sess = v.session;
  const policy0 = normalizeReviewPolicy(sess.policy);
  const byKey = v.byKey || (ctx.workbench?.byKey || new Map());
  const fNotify = notify || freezeNotifySummary(defaultNotify(ctx));

  // 1. 会话存在（能跑到这里即存在）
  add('session-exists', true, `会话「${sess.name}」 rev ${sess.rev}`);

  // 2/3. 每节点签署门槛 + 待复核（含 autoReview / 未确认）
  const unconfirmed = [];
  const reviewPending = [];
  const missing = [];
  const corrupt = [];
  const driftFp = [];
  const branchAdvanced = [];
  for (const sn0 of sess.nodes) {
    const live = byKey.get(sn0.key);
    const st = signatureState(sn0, policy0);
    const drift = nodeDrift(
      { fingerprint: sn0.fingerprint, replayable: sn0.replayable !== false },
      live,
    );
    if (!live) missing.push(sn0.key);
    if (drift === 'corrupt') corrupt.push(sn0.key);
    if (drift === 'fingerprint') driftFp.push(sn0.key);
    if (drift === 'branch-advanced') branchAdvanced.push(sn0.key);
    if (sn0.autoReview || st.decision === 'review') reviewPending.push(sn0.key);
    if (!st.confirmed || sn0.autoReview) unconfirmed.push(sn0.key);
  }
  add('nodes-all-confirmed', unconfirmed.length === 0,
    unconfirmed.length ? `${unconfirmed.length} 个节点未达到 ${policy0.required ?? 1} 个有效签名（含待复核）：${unconfirmed.slice(0, 3).map(shortKey).join('、')}${unconfirmed.length > 3 ? ' …' : ''}`
      : `${sess.nodes.length} 个节点全部达到签署门槛`);
  add('no-review-pending', reviewPending.length === 0,
    reviewPending.length ? `${reviewPending.length} 个节点处于待复核（含系统自动转待复核）` : '没有待复核项');
  add('no-missing-nodes', missing.length === 0,
    missing.length ? `${missing.length} 个节点已缺失：${missing.slice(0, 3).map(shortKey).join('、')}` : '没有缺失节点');
  add('no-corrupt-nodes', corrupt.length === 0,
    corrupt.length ? `${corrupt.length} 个节点已损坏（指纹校验失败 / 不可回放）` : '没有损坏节点');
  add('no-fingerprint-drift', driftFp.length === 0,
    driftFp.length ? `${driftFp.length} 个节点指纹已漂移` : '节点指纹与快照一致');
  add('no-branch-advanced', branchAdvanced.length === 0,
    branchAdvanced.length ? `${branchAdvanced.length} 个节点所在分支已推进（支线事件）` : '没有分支推进节点');

  // 4. 未决冲突记录
  const openConflicts = (sess.conflicts || []).filter((c) => !c.resolved);
  add('no-open-conflicts', openConflicts.length === 0,
    openConflicts.length ? `${openConflicts.length} 条未决冲突记录：${openConflicts.slice(0, 3).map((c) => c.code).join('、')}` : '没有未决冲突记录');

  // 5. 基线
  add('baseline-current', !v.baselineChanged,
    v.baselineChanged ? `筛选基线已变化（当前 timelineHash ${v.currentHash} ≠ 快照 ${sess.baseline?.timelineHash}）` : '筛选基线与当前时间线一致');

  // 6. 策略满足：会话完成状态 + 驳回规则
  const progress = v.progress || sessionProgress(sess);
  const noRejectRequired = gatePolicy.requireNoReject || policy0.completeRule === 'no-reject';
  const rejectCount = noRejectRequired ? progress.reject : 0;
  const sessionOk = !gatePolicy.requireSessionCompleted || sess.status === 'completed';
  const policyOk = sessionOk && !rejectCount;
  add('policy-satisfied', policyOk,
    !sessionOk ? `会话尚未标记完成（当前 ${sess.status}）`
      : rejectCount ? `完成条件要求无驳回，但仍有 ${rejectCount} 个驳回节点`
        : `会话已完成，签署策略满足（${policy0.mode === 'signoff' ? `${policy0.required} 签名/节点` : '单人审阅'}）`);

  // 7. 通知：队列 + 待处理项（未到期只提示）
  add('notify-outbox-empty', fNotify.queued.length === 0,
    fNotify.queued.length ? `发送队列有 ${fNotify.queued.length} 个未处理条目（FIFO）` : '通知发送队列为空');
  add('notify-no-actionable', fNotify.actionableCount === 0,
    fNotify.actionableCount ? `${fNotify.actionableCount} 个待处理通知项（${summarizeStatuses(fNotify.byStatus)}）` : '没有待处理通知项');
  const scheduled = fNotify.byStatus.scheduled || 0;
  add('notify-no-scheduled', scheduled === 0,
    scheduled ? `${scheduled} 个通知尚未到期（不阻止发布）` : '没有未到期通知', { blocking: false });

  // 8. 实验 / 分支完整性
  const expProblems = experimentProblems(session, v, ctx);
  add('experiments-intact', expProblems.length === 0,
    expProblems.length ? expProblems.slice(0, 3).join('；') : '引用的实验与变体结果完整、指纹一致');
  const brProblems = branchProblems(session, v, ctx);
  add('branches-intact', brProblems.length === 0,
    brProblems.length ? brProblems.slice(0, 3).join('；') : '引用的编辑分支均存在且 head 未推进');

  return gateResult(checks, blockers, now);
}

function gateResult(checks, blockers, now) {
  return {
    evaluatedAt: now,
    ok: blockers.length === 0,
    blockers,
    warnings: checks.filter((c) => !c.ok && !c.blocking).map((c) => c.code),
    checks,
  };
}

function summarizeStatuses(byStatus) {
  return Object.entries(byStatus).filter(([, n]) => n).map(([k, n]) => `${STATUS_LABEL[k] || k} ${n}`).join('、');
}
const STATUS_LABEL = {
  scheduled: '待到期', deferred: '静音延迟', pending: '待发送', sent: '已发送', delivered: '已送达未确认',
  acknowledged: '已确认', snoozed: '稍后提醒', transferred: '已转交', failed: '发送失败', cancelled: '已取消',
};

function shortKey(key) {
  const s = String(key || '');
  if (s.startsWith('event:')) return '事件 ' + s.slice(6, 10);
  if (s.startsWith('variant:')) return '变体 ' + s.slice(8, 18);
  return s.slice(0, 14);
}

function experimentProblems(session, view, ctx) {
  const v = view?.session ? view.session : session;
  const problems = [];
  const expIds = new Set();
  for (const sn of v.nodes) if (sn.experimentId) expIds.add(sn.experimentId);
  const liveById = new Map((ctx.experiments || []).map((x) => [x.id, x]));
  for (const id of expIds) {
    const live = liveById.get(id);
    if (!live) { problems.push(`实验 ${id.slice(0, 10)} 已缺失`); continue; }
    for (const sn of v.nodes.filter((n) => n.experimentId === id && n.variantId)) {
      const variant = (live.variants || []).find((x) => x.id === sn.variantId);
      if (!variant || variant.status !== 'done' || !variant.result) {
        problems.push(`变体结果 ${sn.title || sn.variantId} 已缺失 / 未完成`);
        continue;
      }
      if (sn.fingerprint && variant.result.hash && variant.result.hash !== sn.fingerprint) {
        problems.push(`变体「${sn.title || sn.variantId}」指纹已漂移`);
      }
    }
    const sourceId = live.source?.eventId;
    if (sourceId && !(ctx.eventsById || new Map()).has(sourceId) && !(ctx.workbench?.byKey || new Map()).has(`event:${sourceId}`)) {
      problems.push(`实验「${live.name || id}」来源事件已缺失`);
    }
  }
  return problems;
}

function branchProblems(session, view, ctx) {
  // 门禁只要求快照引用的编辑分支仍存在（head 推进的【新鲜度】由 reconcileRelease
  // 比较冻结 head 与当前 head 给出 release-branch-changed 过期原因；节点是否在当前
  // head 父链上已由 no-branch-advanced 检查覆盖）。
  const v = view?.session ? view.session : session;
  const problems = [];
  const ids = new Set();
  for (const sn of v.nodes) if (sn.branchId) ids.add(sn.branchId);
  for (const bid of Object.keys(v.baseline?.branchHeads || {})) ids.add(bid);
  const liveById = new Map((ctx.branches || []).map((b) => [b.id, b]));
  for (const bid of ids) {
    if (!liveById.has(bid)) problems.push(`编辑分支 ${bid.slice(0, 10)} 已缺失`);
  }
  return problems;
}

function defaultNotify(ctx) {
  return ctx.notify || { events: ctx.notifyEvents || [], items: ctx.notifications || [], outbox: ctx.notifyOutbox || [], rules: ctx.notifyRules || [] };
}

/* ------------------------------- 过期对账 ------------------------------- */

/**
 * 对一个候选做确定性对账：重新计算证据快照各部分在当前上下文下的哈希并比较，
 * 返回 { stale, staleCodes:[...], staleReasons:[...], gate, view, evidenceNow }。
 * 已批准 / 已撤销候选不再翻转过期状态（审计事实），但仍返回当时门禁结果。
 */
export function reconcileRelease(release, ctx, { now = Date.now(), notify = null } = {}) {
  const fNotify = freezeNotifySummary(notify || defaultNotify(ctx));
  const session = (ctx.sessions || []).find((s) => s.id === release.sessionId) || null;
  const staleCodes = [];

  if (!session) {
    const codes = ['release-session-changed'];
    const missingGate = {
      evaluatedAt: now,
      ok: false,
      blockers: ['session-exists'],
      warnings: [],
      checks: GATE_CHECKS.map((c) => checkEntry(c.code, false,
        c.code === 'session-exists' ? '原审阅会话已不存在' : '会话缺失，无法评估', { blocking: c.blocking })),
    };
    const sealed = release.state !== 'pending';
    return {
      release, session: null, view: null,
      stale: !sealed,
      staleCodes: sealed ? [] : codes,
      staleReasons: sealed ? [] : codes.map((c) => STALE_TEXT[c]),
      gate: sealed ? release.gate : missingGate,
      evidenceNow: null,
    };
  }

  const view = reconcileSession(session, ctx.workbench, { now });
  const sessionNow = freezeSessionEvidence(view.session, view);
  const expNow = freezeExperimentEvidence(sessionNow, ctx);
  const brNow = freezeBranchEvidence(sessionNow, ctx);

  if (digest(sessionNow) !== release.evidence.sessionDigest) staleCodes.push('release-session-changed');
  if (expNow.hash !== release.evidence.experiments.hash) staleCodes.push('release-experiment-changed');
  if (brNow.hash !== release.evidence.branches.hash) staleCodes.push('release-branch-changed');
  if (fNotify.stateHash !== release.evidence.notify.stateHash) staleCodes.push('release-notify-changed');

  // 节点漂移 / 基线变化给出更具体的原因（会话摘要变化时仍保留细分代码用于展示）
  const nodeDriftKeys = [];
  for (const evNode of release.evidence.session.nodes) {
    const live = view.byKey.get(evNode.key);
    if (nodeDrift(evNode, live)) nodeDriftKeys.push(evNode.key);
  }
  if (nodeDriftKeys.length) staleCodes.push('release-node-drift');
  if (view.baselineChanged) staleCodes.push('release-baseline-changed');

  const gate = evaluateGate(view.session, view, ctx, { notify: fNotify, policy: release.gatePolicy, now });
  const sealed = release.state === 'approved' || release.state === 'revoked' || release.state === 'superseded';
  const codes = sealed ? [] : [...new Set(staleCodes)];
  return {
    release, session: view.session, view, stale: !sealed && codes.length > 0, staleCodes: codes,
    staleReasons: codes.map((c) => STALE_TEXT[c]).filter(Boolean),
    gate,
    evidenceNow: { session: sessionNow, experiments: expNow, branches: brNow, notify: fNotify },
  };
}

/** store 视图便捷层：组装 ctx 并返回候选的当前门禁 / 过期视图。 */
export function releaseView(release, ctx, { now = Date.now() } = {}) {
  return reconcileRelease(release, ctx, { now, notify: ctx.notify || null });
}

/* ------------------------------- 批准 / 撤销 / 重新生成 ------------------------------- */

/**
 * 批准发布：候选必须 pending、未过期且门禁全过。
 * 审批意见（comment 可选；approver 必填）追加到 approvals[]，rev +1。
 * 重复批准（同批准人、同意见）幂等，不增加 rev。
 */
export function approveRelease(release, rec, { now = Date.now() } = {}) {
  if (!release) return { status: 404, reason: 'release-missing' };
  if (release.state === 'superseded') return { status: 409, reason: 'release-superseded' };
  if (release.state === 'revoked') return { status: 409, reason: 'release-revoked' };
  if (release.state === 'approved') {
    const by = normalizeActor(rec?.approver);
    const dup = release.approvals.some((a) => a.by === by && (a.comment || '') === clampReason(rec?.comment));
    if (dup) return { status: 200, idempotent: true, release };
    return { status: 409, reason: 'release-already-approved' };
  }
  if (rec?.staleCodes?.length || rec.stale) return { status: 409, reason: 'release-stale', staleCodes: rec.staleCodes };
  const gate = rec?.gate || release.gate;
  if (!gate?.ok) return { status: 409, reason: 'release-gate-blocked', blockers: gate?.blockers || [], gate };

  const by = normalizeActor(rec?.approver);
  const comment = clampReason(rec?.comment);
  const approval = {
    id: uid('ra'), at: now, by, comment,
    evidenceHash: release.evidence.evidenceHash,
    gateChecksum: gateChecksum(gate),
    candidateRev: release.rev,
  };
  const next = {
    ...release,
    state: 'approved',
    approvedAt: now,
    approvals: [...release.approvals, approval],
    gate,
    updatedAt: now,
    rev: release.rev + 1,
    history: [...release.history, { at: now, by, action: 'approved', detail: comment || '批准发布' }],
  };
  return { status: 200, release: next, approval };
}

export function gateChecksum(gate) {
  return digest({ ok: gate.ok, blockers: gate.blockers, checks: gate.checks.map((c) => ({ code: c.code, ok: c.ok })) });
}

/** 撤销已批准候选：必须填写撤销原因；撤销记录与完整审计链保留。 */
export function revokeRelease(release, reason, { actor = '', now = Date.now() } = {}) {
  if (!release) return { status: 404, reason: 'release-missing' };
  const r = clampReason(reason);
  if (!r) return { status: 400, reason: 'revocation-reason-required' };
  if (release.state !== 'approved') return { status: 409, reason: 'release-not-approved', state: release.state };
  const by = normalizeActor(actor);
  const revocation = {
    id: uid('rr'), at: now, by, reason: r,
    approvedAt: release.approvedAt ?? null,
    evidenceHash: release.evidence.evidenceHash,
    approvals: release.approvals.map((a) => ({ id: a.id, by: a.by, at: a.at })),
  };
  const next = {
    ...release,
    state: 'revoked',
    revocation,
    revokedAt: now,
    updatedAt: now,
    rev: release.rev + 1,
    history: [...release.history, { at: now, by, action: 'revoked', detail: r }],
  };
  return { status: 200, release: next, revocation };
}

/**
 * 重新生成证据快照：旧候选标记为 superseded（快照 / 门禁 / 审批意见原样保留），
 * 基于当前会话生成新的候选（candidateNo+1、supersedesId 指向旧候选）。
 */
export function regenerateRelease(oldRelease, session, view, ctx, opts = {}) {
  if (!oldRelease) return { status: 404, reason: 'release-missing' };
  if (oldRelease.state !== 'pending') return { status: 409, reason: 'release-not-pending', state: oldRelease.state };
  const now = opts.now || Date.now();
  const fresh = createReleaseCandidate(session, view, ctx, {
    name: opts.name || oldRelease.name,
    actor: opts.actor || oldRelease.createdBy,
    now,
    notify: opts.notify || null,
    gatePolicy: oldRelease.gatePolicy,
  });
  fresh.candidateNo = (oldRelease.candidateNo || 1) + 1;
  fresh.supersedesId = oldRelease.supersedesId || oldRelease.id;
  // 沿 supersede 链收敛：始终指向首个候选（同一发布的候选族）
  fresh.supersedesId = oldRelease.supersedesId || oldRelease.id;
  const superseded = {
    ...oldRelease,
    state: 'superseded',
    supersededAt: now,
    supersededById: fresh.id,
    updatedAt: now,
    rev: oldRelease.rev + 1,
    history: [...oldRelease.history, { at: now, by: normalizeActor(opts.actor), action: 'superseded', detail: `证据快照重新生成为候选 #${fresh.candidateNo}` }],
  };
  return { status: 200, release: fresh, previous: superseded };
}

/* ------------------------------- 加载清洗 ------------------------------- */

function sanitizeEvidence(raw0, now) {
  const session = raw0?.session;
  const nodes = Array.isArray(session?.nodes) ? session.nodes.map((n0, i) => ({
    key: String(n0.key || ''),
    order: Number.isFinite(n0.order) ? n0.order : i,
    kind: typeof n0.kind === 'string' ? n0.kind : null,
    title: String(n0.title || n0.key || ''),
    branchId: typeof n0.branchId === 'string' ? n0.branchId : null,
    experimentId: typeof n0.experimentId === 'string' ? n0.experimentId : null,
    variantId: typeof n0.variantId === 'string' ? n0.variantId : null,
    seqLabel: typeof n0.seqLabel === 'string' ? n0.seqLabel : null,
    fingerprint: typeof n0.fingerprint === 'string' ? n0.fingerprint : null,
    fingerprintBefore: typeof n0.fingerprintBefore === 'string' ? n0.fingerprintBefore : null,
    replayable: n0.replayable !== false,
    severity: ['ok', 'warn', 'bad'].includes(n0.severity) ? n0.severity : 'ok',
    absent: !!n0.absent,
    autoReview: n0.autoReview && typeof n0.autoReview === 'object' ? {
      code: String(n0.autoReview.code || 'auto-review'),
      codes: Array.isArray(n0.autoReview.codes) ? n0.autoReview.codes.map(String) : [String(n0.autoReview.code || 'auto-review')],
      reason: String(n0.autoReview.reason || ''),
      at: Number.isFinite(n0.autoReview.at) ? n0.autoReview.at : now,
    } : null,
    decision: ['pass', 'reject', 'review', 'pending'].includes(n0.decision) ? n0.decision : 'pending',
    reason: String(n0.reason || ''),
    decidedBy: typeof n0.decidedBy === 'string' ? n0.decidedBy : null,
    decidedAt: Number.isFinite(n0.decidedAt) ? n0.decidedAt : null,
    confirmed: !!n0.confirmed,
    confirmedAt: Number.isFinite(n0.confirmedAt) ? n0.confirmedAt : null,
    effectiveDecision: ['pass', 'reject', 'review', 'pending'].includes(n0.effectiveDecision) ? n0.effectiveDecision : 'pending',
    activeCount: Number.isFinite(n0.activeCount) ? n0.activeCount : 0,
    activeSigners: Array.isArray(n0.activeSigners) ? n0.activeSigners.map(String) : [],
    counts: n0.counts && typeof n0.counts === 'object'
      ? { pass: n0.counts.pass | 0, reject: n0.counts.reject | 0, review: n0.counts.review | 0 }
      : { pass: 0, reject: 0, review: 0 },
    signatures: Array.isArray(n0.signatures) ? n0.signatures.filter((s) => s && typeof s.id === 'string').map((s) => ({
      id: s.id, seq: Number.isFinite(s.seq) ? s.seq : 0, at: Number.isFinite(s.at) ? s.at : now,
      by: String(s.by || '未署名'), decision: ['pass', 'reject', 'review'].includes(s.decision) ? s.decision : 'review',
      reason: String(s.reason || ''),
      invalid: s.invalid && typeof s.invalid === 'object'
        ? { code: String(s.invalid.code || 'invalid'), codes: Array.isArray(s.invalid.codes) ? s.invalid.codes.map(String) : [String(s.invalid.code || 'invalid')] }
        : null,
    })) : [],
  })).filter((n) => n.key) : [];

  const policy = normalizeReviewPolicy(session?.policy);
  const baseline = session?.baseline && typeof session.baseline === 'object' ? {
    filterHash: String(session.baseline.filterHash || ''),
    orderHash: String(session.baseline.orderHash || ''),
    timelineHash: String(session.baseline.timelineHash || ''),
    total: Number.isFinite(session.baseline.total) ? session.baseline.total : nodes.length,
    replayable: session.baseline.replayable | 0,
    bad: session.baseline.bad | 0,
    warn: session.baseline.warn | 0,
    branchHeads: session.baseline.branchHeads && typeof session.baseline.branchHeads === 'object'
      ? Object.fromEntries(Object.entries(session.baseline.branchHeads).filter(([, v]) => typeof v === 'string')) : {},
  } : { filterHash: '', orderHash: '', timelineHash: '', total: nodes.length, replayable: 0, bad: 0, warn: 0, branchHeads: {} };

  const sessionEv = session && typeof session === 'object' ? {
    sessionId: String(session.sessionId || ''),
    sessionName: String(session.sessionName || ''),
    sessionRev: Number.isFinite(session.sessionRev) ? session.sessionRev : 1,
    status: session.status === 'completed' ? 'completed' : 'active',
    createdBy: String(session.createdBy || '未署名'),
    createdAt: Number.isFinite(session.createdAt) ? session.createdAt : now,
    completedAt: Number.isFinite(session.completedAt) ? session.completedAt : null,
    filter: normalizeFilter(session.filter),
    policy,
    baseline,
    progress: session.progress && typeof session.progress === 'object' ? {
      total: session.progress.total | 0, confirmed: session.progress.confirmed | 0,
      pass: session.progress.pass | 0, reject: session.progress.reject | 0,
      review: session.progress.review | 0, pending: session.progress.pending | 0,
      needsWork: session.progress.needsWork | 0, percent: session.progress.percent | 0,
      complete: !!session.progress.complete,
    } : { total: nodes.length, confirmed: 0, pass: 0, reject: 0, review: 0, pending: nodes.length, needsWork: nodes.length, percent: 0, complete: false },
    openConflicts: Array.isArray(session.openConflicts) ? session.openConflicts.map((c) => ({
      id: String(c.id || ''), code: String(c.code || 'conflict'),
      nodeKey: typeof c.nodeKey === 'string' ? c.nodeKey : null,
      text: String(c.text || ''), at: Number.isFinite(c.at) ? c.at : now,
    })).filter((c) => c.id) : [],
    nodes,
  } : null;

  const experiments = Array.isArray(raw0?.experiments?.experiments) ? raw0.experiments.experiments : [];
  const branches = Array.isArray(raw0?.branches?.branches) ? raw0.branches.branches : [];
  const notify = sanitizeNotifySummary(raw0?.notify);
  const evidence = {
    frozenAt: Number.isFinite(raw0?.frozenAt) ? raw0.frozenAt : now,
    frozenBy: normalizeActor(raw0?.frozenBy),
    filter: normalizeFilter(raw0?.filter || sessionEv?.filter),
    order: Array.isArray(raw0?.order) ? raw0.order.map(String) : nodes.map((n) => n.key),
    session: sessionEv,
    sessionDigest: typeof raw0?.sessionDigest === 'string' ? raw0.sessionDigest : digest(sessionEv),
    experiments: { experiments, hash: typeof raw0?.experiments?.hash === 'string' ? raw0.experiments.hash : digest(experiments) },
    branches: { branches, hash: typeof raw0?.branches?.hash === 'string' ? raw0.branches.hash : digest(branches) },
    notify,
    evidenceHash: typeof raw0?.evidenceHash === 'string' ? raw0.evidenceHash : '',
  };
  if (!evidence.evidenceHash) {
    evidence.evidenceHash = digest({
      filter: evidence.filter, order: evidence.order, sessionDigest: evidence.sessionDigest,
      experiments: evidence.experiments.hash, branches: evidence.branches.hash,
      notify: evidence.notify.stateHash, frozenAt: evidence.frozenAt,
    });
  }
  return evidence;
}

function sanitizeNotifySummary(raw0) {
  const fallback = freezeNotifySummary({});
  if (!raw0 || typeof raw0 !== 'object') return fallback;
  const byStatus = {};
  for (const [k, v] of Object.entries(raw0.byStatus || {})) byStatus[k] = Number(v) | 0;
  return {
    eventCount: Number.isFinite(raw0.eventCount) ? raw0.eventCount : 0,
    itemCount: Number.isFinite(raw0.itemCount) ? raw0.itemCount : 0,
    byStatus,
    actionableCount: Number.isFinite(raw0.actionableCount) ? raw0.actionableCount : (Array.isArray(raw0.actionable) ? raw0.actionable.length : 0),
    actionable: Array.isArray(raw0.actionable) ? raw0.actionable.filter((x) => x && typeof x.id === 'string').map((x) => ({
      id: String(x.id), status: String(x.status || ''), recipient: String(x.recipient || ''),
      eventType: typeof x.eventType === 'string' ? x.eventType : null, level: Number.isFinite(x.level) ? x.level : 0,
    })) : [],
    queued: Array.isArray(raw0.queued) ? raw0.queued.filter((x) => x && typeof x.notifyId === 'string').map((x) => ({
      id: String(x.id || ''), notifyId: String(x.notifyId), seq: x.seq | 0,
      enqueuedAt: Number.isFinite(x.enqueuedAt) ? x.enqueuedAt : 0,
      attempts: x.attempts | 0, status: String(x.status || 'queued'),
    })) : [],
    rules: Array.isArray(raw0.rules) ? raw0.rules.filter((x) => x && typeof x.id === 'string').map((x) => ({
      id: String(x.id), rev: Number.isFinite(x.rev) ? x.rev : 1,
      deleted: !!x.deleted, deleteRev: Number.isFinite(x.deleteRev) ? x.deleteRev : null,
      enabled: x.enabled !== false,
    })) : [],
    stateHash: typeof raw0.stateHash === 'string' ? raw0.stateHash : fallback.stateHash,
  };
}

function sanitizeGate(raw0, now) {
  const seen = new Map();
  for (const c of GATE_CHECKS) seen.set(c.code, c);
  const checks = [];
  if (raw0 && Array.isArray(raw0.checks)) {
    for (const c0 of raw0.checks) {
      if (!c0 || typeof c0.code !== 'string') continue;
      const def = seen.get(c0.code);
      checks.push({
        code: c0.code,
        label: typeof c0.label === 'string' ? c0.label : (GATE_TEXT[c0.code] || c0.code),
        ok: !!c0.ok,
        blocking: def ? def.blocking : c0.blocking !== false,
        detail: String(c0.detail || ''),
      });
    }
  }
  // 补齐缺失检查项（旧版候选加载时）：未知项按未通过处理，强制重新评估
  for (const def of GATE_CHECKS) {
    if (!checks.some((c) => c.code === def.code)) {
      checks.push({ code: def.code, label: GATE_TEXT[def.code], ok: false, blocking: def.blocking, detail: '加载时缺失该检查项，需重新评估门禁' });
    }
  }
  const blockers = checks.filter((c) => !c.ok && c.blocking).map((c) => c.code);
  const warnings = Array.isArray(raw0?.warnings)
    ? raw0.warnings.map(String)
    : checks.filter((c) => !c.ok && !c.blocking).map((c) => c.code);
  return {
    evaluatedAt: Number.isFinite(raw0?.evaluatedAt) ? raw0.evaluatedAt : now,
    ok: blockers.length === 0,
    blockers,
    warnings,
    checks,
  };
}

export function sanitizeReleases(raw, { now = Date.now() } = {}) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const r0 of raw) {
    if (!r0 || typeof r0 !== 'object' || typeof r0.id !== 'string' || !r0.evidence?.session?.sessionId) continue;
    if (seen.has(r0.id)) continue;
    seen.add(r0.id);
    const state = RELEASE_STATES.includes(r0.state) ? r0.state : 'pending';
    const approvals = Array.isArray(r0.approvals) ? r0.approvals.filter((a) => a && typeof a.id === 'string').map((a) => ({
      id: a.id, at: Number.isFinite(a.at) ? a.at : now, by: normalizeActor(a.by),
      comment: String(a.comment || ''),
      evidenceHash: typeof a.evidenceHash === 'string' ? a.evidenceHash : '',
      gateChecksum: typeof a.gateChecksum === 'string' ? a.gateChecksum : '',
      candidateRev: Number.isFinite(a.candidateRev) ? a.candidateRev : 1,
    })) : [];
    const revocation = r0.revocation && typeof r0.revocation === 'object' && typeof r0.revocation.id === 'string' ? {
      id: r0.revocation.id,
      at: Number.isFinite(r0.revocation.at) ? r0.revocation.at : now,
      by: normalizeActor(r0.revocation.by),
      reason: String(r0.revocation.reason || ''),
      approvedAt: Number.isFinite(r0.revocation.approvedAt) ? r0.revocation.approvedAt : null,
      evidenceHash: typeof r0.revocation.evidenceHash === 'string' ? r0.revocation.evidenceHash : '',
      approvals: Array.isArray(r0.revocation.approvals) ? r0.revocation.approvals.map((a) => ({
        id: String(a.id || ''), by: normalizeActor(a.by), at: Number.isFinite(a.at) ? a.at : null,
      })) : [],
    } : null;
    const history = Array.isArray(r0.history) ? r0.history.filter((h) => h && typeof h.action === 'string').map((h) => ({
      at: Number.isFinite(h.at) ? h.at : now,
      by: normalizeActor(h.by),
      action: String(h.action),
      detail: String(h.detail || ''),
    })) : [];
    out.push({
      id: r0.id,
      formatVersion: RELEASE_FORMAT,
      name: String(r0.name || '发布候选').slice(0, 60),
      sessionId: String(r0.sessionId || r0.evidence.session.sessionId),
      sessionName: String(r0.sessionName || r0.evidence.session.sessionName || ''),
      candidateNo: Number.isFinite(r0.candidateNo) && r0.candidateNo >= 1 ? Math.floor(r0.candidateNo) : 1,
      supersedesId: typeof r0.supersedesId === 'string' ? r0.supersedesId : null,
      createdBy: normalizeActor(r0.createdBy),
      createdAt: Number.isFinite(r0.createdAt) ? r0.createdAt : now,
      updatedAt: Number.isFinite(r0.updatedAt) ? r0.updatedAt : (Number.isFinite(r0.createdAt) ? r0.createdAt : now),
      state,
      evidence: sanitizeEvidence(r0.evidence, now),
      gate: sanitizeGate(r0.gate, now),
      gatePolicy: normalizeGatePolicy(r0.gatePolicy),
      approvals,
      approvedAt: state === 'approved' || state === 'revoked' ? (Number.isFinite(r0.approvedAt) ? r0.approvedAt : (approvals[0]?.at ?? null)) : null,
      revocation,
      revokedAt: state === 'revoked' && Number.isFinite(r0.revokedAt) ? r0.revokedAt : (revocation?.at ?? null),
      supersededAt: state === 'superseded' && Number.isFinite(r0.supersededAt) ? r0.supersededAt : null,
      supersededById: typeof r0.supersededById === 'string' ? r0.supersededById : null,
      history,
      rev: Number.isFinite(r0.rev) && r0.rev >= 1 ? Math.floor(r0.rev) : 1,
    });
  }
  out.sort((a, b) => (a.createdAt - b.createdAt) || (a.candidateNo - b.candidateNo) || (a.id < b.id ? -1 : 1));
  return out;
}

/* ------------------------------- 跨窗口合流 / 服务端检查 ------------------------------- */

/** 候选按 id 并集；同 id rev 更大者整体胜出，审批 / 历史记录按 id 并集（审计链不丢）。 */
export function mergeReleases(serverList, clientList) {
  const byId = new Map();
  const order = [];
  for (const r of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (!r || typeof r.id !== 'string') continue;
    const ex = byId.get(r.id);
    if (!ex) { byId.set(r.id, r); order.push(r.id); continue; }
    const winner = Number(r.rev || 0) > Number(ex.rev || 0) ? r : ex;
    const merged = { ...winner };
    // 审批意见 / 历史 / 撤销记录按稳定 id 并集（同 rev 竞态下两边的批准都保留可见）
    const appr = new Map((ex.approvals || []).map((a) => [a.id, a]));
    for (const a of r.approvals || []) if (a?.id) appr.set(a.id, { ...(appr.get(a.id) || {}), ...a });
    merged.approvals = [...appr.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
    const hist = new Map();
    for (const h of [...(ex.history || []), ...(r.history || [])]) {
      const k = `${h.at}|${h.action}|${h.by || ''}|${h.detail || ''}`;
      hist.set(k, h);
    }
    merged.history = [...hist.values()].sort((a, b) => (a.at - b.at) || (a.action < b.action ? -1 : 1));
    if (!merged.revocation && (ex.revocation || r.revocation)) merged.revocation = ex.revocation || r.revocation;
    byId.set(r.id, merged);
  }
  return order.map((id) => byId.get(id)).sort((a, b) => (a.createdAt - b.createdAt) || (a.candidateNo - b.candidateNo) || (a.id < b.id ? -1 : 1));
}

/**
 * 服务端同构的发布候选乐观并发检查（clientDoc 携带 baseReleaseRevs）。
 *  - 候选被另一窗口前进（批准 / 撤销 / 取代）→ release-advanced；
 *  - 审批的候选证据快照已过期（会话 / 实验 / 分支 / 通知变化）→ release-stale；
 *  - 审批时冻结门禁仍有阻断项 → release-gate-blocked；
 *  - 撤销缺少原因 → release-revocation-reason-required；
 *  - 候选引用的会话不存在 → release-session-missing。
 * 纯 JS 版供浏览器本地多页签与单测使用；server.py 内有同构 Python 实现。
 */
export function assessServerReleaseConflict(serverDoc, clientDoc, ctxBuilder = null) {
  const baseRevs = clientDoc?.baseReleaseRevs;
  if (!baseRevs || typeof baseRevs !== 'object') return null;
  const serverById = new Map((serverDoc?.releases || []).map((r) => [r.id, r]));
  const serverSessions = new Set((serverDoc?.reviewSessions || []).map((s) => s.id));
  // 有效会话 = 服务端已有会话 ∪ 本次提交自带的新会话（同一次保存里新建会话与候选原子出现）
  for (const s of clientDoc?.reviewSessions || []) if (s?.id) serverSessions.add(s.id);

  for (const r of clientDoc?.releases || []) {
    if (!r || typeof r.id !== 'string') continue;
    const base = baseRevs[r.id];
    if (!Number.isInteger(base)) continue;
    if (!(Number(r.rev) > base)) continue; // 未推进该候选：不拦截
    const srv = serverById.get(r.id);
    if (srv && Number(srv.rev) !== base) {
      return { reason: 'release-advanced', releaseId: r.id, serverRev: srv.rev, release: srv };
    }
    if (!serverSessions.has(r.sessionId)) {
      return { reason: 'release-session-missing', releaseId: r.id, sessionId: r.sessionId };
    }
    // 撤销必须携带原因
    if (r.state === 'revoked' && !String(r.revocation?.reason || '').trim()) {
      return { reason: 'release-revocation-reason-required', releaseId: r.id };
    }
    // 仅对“推进到 approved”的候选做门禁 / 过期复核（superseded / revoked 是确定性状态转移）
    if (r.state !== 'approved' || !r.approvals?.length) continue;
    const frozen = frozenGateBlocked(r);
    if (frozen.length) return { reason: 'release-gate-blocked', releaseId: r.id, blockers: frozen };
    if (ctxBuilder) {
      const stale = ctxBuilder(serverDoc, clientDoc, r);
      if (stale?.length) return { reason: 'release-stale', releaseId: r.id, staleCodes: stale };
    }
  }
  return null;
}

/** 不依赖工作体重建的冻结门禁检查：批准载荷的 gate 快照必须无阻断项。 */
export function frozenGateBlocked(release) {
  const blockers = release.gate?.blockers || [];
  if (Array.isArray(blockers) && blockers.length) return blockers.filter((c) => typeof c === 'string');
  return (release.gate?.checks || []).filter((c) => c && !c.ok && c.blocking !== false).map((c) => c.code);
}

/**
 * 服务端（无求解器上下文）可做的轻量过期复核：会话 rev / 节点指纹 / 通知状态哈希。
 * server.py 用同构的字段比较实现，这里给出 JS 版（本地多页签冲突检测复用）。
 */
export function assessReleaseStaleAgainstDoc(serverDoc, clientDoc, release) {
  const codes = [];
  const sess = (serverDoc.reviewSessions || []).find((s) => s.id === release.sessionId);
  if (!sess) return ['release-session-changed'];
  if (sess.rev !== release.evidence.session.sessionRev) codes.push('release-session-changed');
  const frozenByKey = new Map(release.evidence.session.nodes.map((n) => [n.key, n]));
  // 会话节点指纹 / 确认状态变化
  for (const n of sess.nodes || []) {
    const f = frozenByKey.get(n.key);
    if (!f) { codes.push('release-node-drift'); break; }
    if (f.fingerprint && n.fingerprint && f.fingerprint !== n.fingerprint) { codes.push('release-node-drift'); break; }
    const st = signatureState(n, sess.policy);
    if (f.confirmed !== !!st.confirmed) { codes.push('release-session-changed'); break; }
  }
  // 通知状态哈希：服务端无法重算 digest 时直接比较摘要（由 store 在保存前预算）
  const liveSummary = freezeNotifySummary({
    events: serverDoc.notifyEvents || [], items: serverDoc.notifications || [],
    outbox: serverDoc.notifyOutbox || [], rules: serverDoc.notifyRules || [],
  });
  if (liveSummary.stateHash !== release.evidence.notify.stateHash) codes.push('release-notify-changed');
  if (liveSummary.queued.length || liveSummary.actionableCount) codes.push('release-notify-changed');
  return [...new Set(codes)];
}

/* ------------------------------- 报告导出 ------------------------------- */

export function buildReleaseReport(release, view, { generatedAt = null } = {}) {
  const v = view?.gate ? view : null;
  const staleCodes = v?.staleCodes || [];
  const ev = release.evidence;
  return {
    format: 'rect-constraints/release-report',
    formatVersion: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    release: {
      id: release.id,
      name: release.name,
      state: release.state,
      candidateNo: release.candidateNo,
      supersedesId: release.supersedesId,
      sessionId: release.sessionId,
      sessionName: release.sessionName,
      createdBy: release.createdBy,
      createdAt: ev.frozenAt ? new Date(ev.frozenAt).toISOString() : null,
      createdAtMs: release.createdAt,
      approvedAt: release.approvedAt ?? null,
      revokedAt: release.revokedAt ?? null,
      rev: release.rev,
      evidenceHash: ev.evidenceHash,
      gatePolicy: release.gatePolicy,
    },
    evidence: {
      frozenAt: ev.frozenAt,
      frozenAtIso: ev.frozenAt ? new Date(ev.frozenAt).toISOString() : null,
      frozenBy: ev.frozenBy,
      filter: ev.filter,
      order: ev.order,
      session: ev.session,
      experiments: ev.experiments,
      branches: ev.branches,
      notify: ev.notify,
    },
    gate: {
      frozen: release.gate,
      current: v?.gate || null,
      stale: !!v?.stale,
      staleCodes,
      staleReasons: v?.staleReasons || [],
    },
    approvals: release.approvals,
    revocation: release.revocation,
    history: release.history,
    missing: ev.session.nodes.filter((n) => n.absent || (v?.view ? !v.view.byKey.has(n.key) : false)).map((n) => n.key),
    corrupt: ev.session.nodes.filter((n) => n.severity === 'bad' || n.autoReview?.codes?.includes('corrupt')).map((n) => n.key),
    reviewPending: ev.session.nodes.filter((n) => n.effectiveDecision === 'review').map((n) => n.key),
  };
}
