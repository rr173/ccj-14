/*
 * 可恢复的审阅会话：纯函数模块（无 DOM / 存储依赖）。
 *
 * 会话是创建时刻的只读快照；除单人审阅（legacy）外，还支持可配置的多人签署：
 * policy = { mode:'signoff', signers, required, completeRule }。审阅人先提交
 * pass/reject/review，再单独签名确认。同一签署人重复有效签名幂等；改判会保留
 * 旧签名并标记 superseded。节点达到 required 个有效签名后确认，会话完成还要
 * 满足 policy.completeRule。
 *
 * 乐观并发与损坏容忍规则与单人决定一致：会话 rev 前进、节点指纹变化、节点缺失、
 * 分支推进都会 409；对账时已有签名保留在 signatures[] 中，但立即带 invalid 原因
 * 失效，必须重新签署。
 */

import { uid } from './model.js';
import { hash32 } from './experiments.js';
import { filterNodes } from './auditbench.js';

export const REVIEW_FORMAT = 1;
export const REVIEW_DECISIONS = ['pass', 'reject', 'review'];
const DECISION_SET = new Set(REVIEW_DECISIONS);
const DECISION_RANK = { review: 3, reject: 2, pass: 1 };
const INVALID_REASONS = {
  'node-missing': '节点已缺失：审计事件 / 变体结果不在当前时间线中，签名已失效',
  corrupt: '节点已损坏：快照指纹校验失败，无法回放，签名已失效',
  'fingerprint-changed': '节点指纹已变化：记录指纹与当前快照不一致，签名已失效',
  'branch-advanced': '分支已推进：该事件属于支线事件，签名已失效',
  superseded: '同一签署人已重新签名，旧签名被新签名取代',
  'not-allowed': '签署人不在本节点允许名单中，签名已失效',
  'duplicate-signer': '同一签署人存在重复有效签名，仅保留最早一条',
};

export const DECISION_LABEL = {
  pass: '通过', reject: '驳回', review: '待复核', pending: '未处理',
};

export const DRIFT_TEXT = {
  'node-missing': '节点已缺失：审计事件 / 变体结果不在当前时间线中（原决定/签名保留，转待复核）',
  corrupt: '节点已损坏：快照指纹校验失败，无法回放（原决定/签名保留，转待复核）',
  'fingerprint-changed': '节点指纹已变化：记录指纹与当前快照不一致（原决定/签名保留，转待复核）',
  'branch-advanced': '分支已推进：该事件不在所属分支当前 head 父链上，属于支线事件（原决定/签名保留，转待复核）',
};

/* ---------------- 指纹 / 哈希 ---------------- */

export function nodeFingerprint(node) {
  if (!node) return null;
  return node.hashAfter || node.hashBefore || null;
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

export function reviewFilterHash(filter) {
  return hash32(canonical(normalizeFilter(filter)));
}

export function reviewOrderHash(keys) {
  return hash32(keys.join('|'));
}

export function reviewTimelineHash(nodes) {
  return hash32(nodes.map((n) =>
    `${n.key}:${nodeFingerprint(n) || ''}:${n.replayable ? 1 : 0}:${n.severity}`).join('|'));
}

export function normalizeFilter(f = {}) {
  return {
    branchId: typeof f.branchId === 'string' ? f.branchId : null,
    experimentId: typeof f.experimentId === 'string' ? f.experimentId : null,
    variantId: typeof f.variantId === 'string' ? f.variantId : null,
    severity: ['all', 'issues', 'bad', 'unreplayable'].includes(f.severity) ? f.severity : 'all',
    text: typeof f.text === 'string' ? f.text.slice(0, 80) : '',
  };
}

export function normalizeActor(actor = '') {
  return String(actor || '未署名').trim().slice(0, 40) || '未署名';
}

/* ---------------- 多人签署规则 ---------------- */

export function normalizeReviewPolicy(raw = null, { fallback = null } = {}) {
  const source = raw && typeof raw === 'object' ? raw : (fallback || {});
  if (raw && typeof raw === 'object' && raw.mode === 'signoff') {
    const seen = new Set();
    const signers = [];
    for (const value of Array.isArray(raw.signers) ? raw.signers : []) {
      const name = String(value || '').trim().slice(0, 40);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      signers.push(name);
    }
    let required = Number(raw.required);
    if (!Number.isInteger(required)) required = signers.length || 1;
    required = Math.max(1, Math.min(required, signers.length || 1));
    return {
      mode: 'signoff',
      signers,
      required,
      completeRule: raw.completeRule === 'no-reject' ? 'no-reject' : 'all-decided',
    };
  }
  return { mode: 'legacy', signers: [], required: 1, completeRule: 'all-decided' };
}

export function validateReviewPolicy(policy) {
  const p = normalizeReviewPolicy(policy);
  if (p.mode !== 'signoff') return { ok: true, policy: p };
  if (!p.signers.length) return { ok: false, error: '多人签署必须至少设置一名允许的审阅人' };
  if (!Number.isInteger(p.required) || p.required < 1 || p.required > p.signers.length) {
    return { ok: false, error: '签署人数必须在 1 到允许审阅人数之间' };
  }
  if (!['all-decided', 'no-reject'].includes(p.completeRule)) return { ok: false, error: '完成条件无效' };
  return { ok: true, policy: p };
}

export function activeSignatures(node) {
  return (node?.signatures || []).filter((s) => s && !s.invalid);
}

export function isAllowedSigner(policy, actor) {
  const p = normalizeReviewPolicy(policy);
  const by = normalizeActor(actor);
  return p.mode !== 'signoff' || p.signers.includes(by);
}

export function signatureState(node, policy) {
  const sn = node || {};
  const p = normalizeReviewPolicy(policy);
  const active = activeSignatures(sn).slice().sort(compareSignatures);
  const counts = { pass: 0, reject: 0, review: 0 };
  for (const s of active) counts[s.decision] += 1;
  if (p.mode !== 'signoff') {
    return {
      mode: 'legacy', active, counts,
      confirmed: !sn.autoReview && sn.decision !== 'pending',
      decision: sn.autoReview ? 'review' : sn.decision,
      reason: sn.reason || '',
      decidedBy: sn.decidedBy || null,
      decidedAt: sn.decidedAt ?? null,
      confirmedAt: sn.confirmedAt ?? null,
    };
  }
  // 平票确定性地偏向更谨慎的结论：待复核 > 驳回 > 通过。
  let decision = 'pending';
  if (counts.pass || counts.reject || counts.review) {
    const max = Math.max(counts.pass, counts.reject, counts.review);
    const tied = REVIEW_DECISIONS.filter((d) => counts[d] === max);
    if (tied.includes('review')) decision = 'review';
    else if (tied.includes('reject') && tied.includes('pass')) decision = 'review';
    else decision = tied.includes('reject') ? 'reject' : 'pass';
  }
  const decisionSigs = active.filter((s) => s.decision === decision).sort(compareSignatures);
  const latest = decisionSigs[decisionSigs.length - 1] || null;
  const confirmed = !sn.autoReview && active.length >= p.required;
  return {
    mode: 'signoff', active, counts, required: p.required,
    confirmed,
    decision: sn.autoReview ? 'review' : (confirmed ? decision : 'pending'),
    reason: latest?.reason || '',
    decidedBy: active.length ? active.map((s) => s.by).join('、') : null,
    decidedAt: active.length ? Math.max(...active.map((s) => s.at)) : null,
    confirmedAt: sn.confirmedAt ?? null,
    activeSigners: active.map((s) => s.by),
    unsignedSigners: p.signers.filter((name) => !active.some((s) => s.by === name)),
  };
}

function compareSignatures(a, b) {
  return (a.seq ?? 0) - (b.seq ?? 0) || (a.at || 0) - (b.at || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function refreshNodeSignatures(sn, policy, { now = Date.now() } = {}) {
  const p = normalizeReviewPolicy(policy);
  const signatures = (sn.signatures || []).map((s, i) => ({ ...s, seq: Number.isInteger(s.seq) ? s.seq : i }))
    .sort(compareSignatures);
  if (p.mode !== 'signoff') return { ...sn, signatures };
  const st = signatureState({ ...sn, signatures }, p);
  const out = {
    ...sn,
    signatures,
    signedBy: st.active.map((s) => s.by),
    decision: st.confirmed ? st.decision : 'pending',
    reason: st.confirmed ? st.reason : '',
    decidedBy: st.active.length ? st.decidedBy : null,
    decidedAt: st.active.length ? st.decidedAt : null,
    confirmedAt: st.confirmed ? (sn.confirmedAt || now) : null,
  };
  if (!st.confirmed) out.confirmedAt = null;
  return out;
}

/* ---------------- 创建会话快照 ---------------- */

export function createReviewSession({
  name = '', actor = '', filter = {}, nodes = [], branches = [], now = Date.now(), policy = null,
} = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('当前筛选结果为空，无法创建审阅会话');
  const policyCheck = validateReviewPolicy(policy);
  if (!policyCheck.ok) throw new Error(policyCheck.error);
  const f = normalizeFilter(filter);
  const p = policyCheck.policy;
  const snodes = nodes.map((n, i) => ({
    key: n.key,
    order: i,
    kind: n.kind,
    title: n.title,
    branchId: n.branch?.id || null,
    experimentId: n.experiment?.id || null,
    variantId: n.variant?.id || null,
    seqLabel: n.seqLabel || null,
    t: Number.isFinite(n.t) ? n.t : 0,
    actor: n.actor || '',
    fingerprint: nodeFingerprint(n),
    fingerprintBefore: n.hashBefore || null,
    replayable: !!n.replayable,
    severity: n.severity,
    decision: 'pending',
    reason: '',
    decidedBy: null,
    decidedAt: null,
    confirmedAt: null,
    signedBy: [],
    signatures: [],
    autoReview: null,
    absent: false,
    history: [],
  }));
  const branchHeads = {};
  for (const b of branches || []) if (b && typeof b.id === 'string') branchHeads[b.id] = b.headEventId;
  const trimmed = String(name || '').trim().slice(0, 60);
  return {
    id: uid('rv'),
    formatVersion: REVIEW_FORMAT,
    name: trimmed || `审阅会话 ${new Date(now).toLocaleString()}`,
    createdBy: normalizeActor(actor),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    status: 'active',
    filter: f,
    policy: p,
    baseline: {
      filterHash: reviewFilterHash(f),
      orderHash: reviewOrderHash(snodes.map((n) => n.key)),
      timelineHash: reviewTimelineHash(nodes),
      total: nodes.length,
      replayable: nodes.filter((n) => n.replayable).length,
      bad: nodes.filter((n) => n.severity === 'bad').length,
      warn: nodes.filter((n) => n.severity === 'warn').length,
      branchHeads,
    },
    nodes: snodes,
    conflicts: [],
    rev: 1,
  };
}

/* ---------------- 对账（损坏 / 缺失 / 分支推进 / 基线漂移） ---------------- */

function derivedConflictId(sessionId, key, code) {
  return `dc_${hash32(`${sessionId}|${key || ''}|${code}`)}`;
}

function driftCodesOf(sn, live) {
  const codes = [];
  if (!live) {
    codes.push('node-missing');
  } else {
    const fp = nodeFingerprint(live);
    if (sn.fingerprint && fp && fp !== sn.fingerprint) codes.push('fingerprint-changed');
    if (sn.replayable && !live.replayable) codes.push('corrupt');
    if (Array.isArray(live.badges) && live.badges.some((b) => b.code === 'branch-advanced')) codes.push('branch-advanced');
  }
  return codes;
}

function invalidationFor(codes, live, previous = null, at = Date.now()) {
  const text = codes.map((c) => INVALID_REASONS[c] || c).join('；');
  return {
    code: codes[0],
    codes,
    reason: text,
    at: previous?.at || at,
    fingerprintBefore: previous?.fingerprintBefore || null,
    fingerprintAfter: live ? nodeFingerprint(live) : null,
  };
}

function invalidateSignatures(signatures, codes, live, at) {
  let changed = false;
  const out = signatures.map((s) => {
    if (s.invalid) {
      // 已经失效的记录永久保留；若当前漂移原因变化，更新展示原因但保留首次失效时间。
      const prevCodes = Array.isArray(s.invalid.codes) ? s.invalid.codes : [s.invalid.code || 'invalidated'];
      const same = prevCodes.length === codes.length && prevCodes.every((c, i) => c === codes[i]);
      if (same) return s;
      changed = true;
      return { ...s, invalid: invalidationFor(codes, live, s.invalid, at) };
    }
    changed = true;
    return { ...s, invalid: invalidationFor(codes, live, null, at) };
  });
  return { out, changed };
}

export function reconcileSession(session, wb, { now = Date.now() } = {}) {
  const filteredNow = filterNodes(wb.nodes || [], session.filter || {});
  const byKey = wb.byKey || new Map();
  const conflicts = [...(session.conflicts || [])];
  const openById = new Map(conflicts.map((c) => [c.id, c]));

  const ensureDerived = (key, code) => {
    const id = derivedConflictId(session.id, key, code);
    if (!openById.has(id)) {
      const entry = { id, derived: true, code, nodeKey: key, text: DRIFT_TEXT[code] || code, at: now, resolved: false, resolvedAt: null, resolution: null };
      conflicts.push(entry);
      openById.set(id, entry);
    }
    return id;
  };
  const resolveDerived = (key, resolution, at) => {
    for (const c of conflicts) {
      if (c.derived && c.nodeKey === key && !c.resolved) {
        c.resolved = true; c.resolvedAt = at; c.resolution = resolution;
      }
    }
  };

  const driftByKey = new Map();
  const nodes = session.nodes.map((sn0) => {
    const live = byKey.get(sn0.key);
    const codes = driftCodesOf(sn0, live);
    let sn = { ...sn0, signatures: Array.isArray(sn0.signatures) ? sn0.signatures : [] };
    if (codes.length) {
      driftByKey.set(sn.key, codes);
      const { out } = invalidateSignatures(sn.signatures, codes, live, now);
      sn.signatures = out;
      const auto = {
        code: codes[0],
        codes,
        reason: codes.map((c) => DRIFT_TEXT[c]).join('；'),
        at: sn.autoReview?.at || now,
        fingerprintBefore: sn.autoReview?.fingerprintBefore || sn.fingerprint,
        fingerprintAfter: live ? nodeFingerprint(live) : null,
      };
      for (const code of codes) ensureDerived(sn.key, code);
      sn = { ...sn, absent: !live, autoReview: auto };
    } else {
      if (sn.autoReview) resolveDerived(sn.key, 'recovered', now);
      sn = { ...sn, autoReview: null, absent: false };
    }
    return refreshNodeSignatures(sn, session.policy, { now });
  });

  const currentHash = reviewTimelineHash(filteredNow);
  const baselineChanged = currentHash !== session.baseline?.timelineHash;
  const baseId = derivedConflictId(session.id, null, 'baseline-changed');
  if (baselineChanged) ensureDerived(null, 'baseline-changed');
  else if (openById.has(baseId) && !openById.get(baseId).resolved) {
    const c = openById.get(baseId);
    c.resolved = true; c.resolvedAt = now; c.resolution = 'rebase';
  }

  const known = new Set(session.nodes.map((n) => n.key));
  const newNodes = filteredNow.filter((n) => !known.has(n.key));

  return {
    session: { ...session, nodes, conflicts },
    filteredNow, newNodes, baselineChanged, currentHash, driftByKey, byKey,
  };
}

export function effectiveDecision(sn, policy = null) {
  const st = signatureState(sn, sn.policy || policy);
  return sn.autoReview ? 'review' : st.decision;
}

export function nodeConfirmed(sn, policy) {
  return signatureState(sn, policy).confirmed;
}

export function sessionProgress(viewOrSession, policy = null) {
  const nodes = viewOrSession?.nodes || [];
  const c = { total: nodes.length, pass: 0, reject: 0, review: 0, pending: 0, decided: 0, needsWork: 0, confirmed: 0 };
  for (const sn of nodes) {
    const st = signatureState(sn, sn.policy || policy || (viewOrSession?.policy));
    const eff = sn.autoReview ? 'review' : st.decision;
    if (eff === 'pending') c.pending += 1;
    else c[eff] += 1;
    if (sn.autoReview || activeSignatures(sn).length || sn.decision !== 'pending') c.decided += 1;
    if (st.confirmed) c.confirmed += 1;
    if (!st.confirmed || sn.autoReview) c.needsWork += 1;
  }
  c.done = c.confirmed;
  c.percent = c.total ? Math.round((c.confirmed / c.total) * 100) : 0;
  c.complete = c.total > 0 && c.needsWork === 0;
  return c;
}

export function finalReviewVerdict(session, viewOrProgress = null) {
  const progress = viewOrProgress?.total !== undefined ? viewOrProgress : sessionProgress(viewOrProgress?.session || session);
  if (!progress.complete) return 'incomplete';
  const p = normalizeReviewPolicy(session.policy);
  if (progress.reject > 0) return p.completeRule === 'no-reject' ? 'rejected' : 'decided-with-reject';
  if (progress.review > 0) return 'approved-with-review';
  return 'approved';
}

/* ---------------- 决定 / 签名记录 ---------------- */

function reasonRequired(decision) { return decision === 'reject' || decision === 'review'; }

function validateDecisionInput(decision, reason) {
  if (!DECISION_SET.has(decision)) return { status: 400, reason: '非法决定' };
  const r = String(reason || '').trim().slice(0, 2000);
  if (reasonRequired(decision) && !r) return { status: 400, reason: '驳回 / 待复核必须填写理由' };
  return { reason: r };
}

export function recordDecision(session, view, key, decision, reason, { actor = '', now = Date.now() } = {}) {
  const v = validateDecisionInput(decision, reason);
  if (v.status) return v;
  if (normalizeReviewPolicy(session.policy).mode === 'signoff') return { status: 400, reason: 'multi-signoff-required' };
  const sn = session.nodes.find((x) => x.key === key);
  if (!sn) return { status: 409, reason: 'node-missing' };
  const codes = view.driftByKey?.get(key);
  if (codes?.length) return { status: 409, reason: codes[0], codes };
  if (view.baselineChanged) return { status: 409, reason: 'baseline-changed' };

  const by = normalizeActor(actor);
  const nodes = session.nodes.map((x) => {
    if (x.key !== key) return x;
    const history = [...x.history];
    if (x.decision !== 'pending' && (x.decision !== decision || x.reason !== v.reason)) {
      history.push({ at: now, by, from: x.decision, to: decision, reason: v.reason });
    }
    return {
      ...x, decision, reason: v.reason, decidedBy: by, decidedAt: now,
      confirmedAt: now, autoReview: null, history,
    };
  });
  return { status: 200, session: { ...session, nodes, updatedAt: now, rev: session.rev + 1 } };
}

export function makeSignatureProposal(nodeKey, decision, reason, { actor = '', now = Date.now() } = {}) {
  const by = normalizeActor(actor);
  const r = String(reason || '').trim().slice(0, 2000);
  return {
    type: 'signature',
    nodeKey,
    decision,
    reason: r,
    by,
    at: now,
    rejected: true,
    sig: { id: uid('sg'), seq: Number.MAX_SAFE_INTEGER, at: now, by, decision, reason: r, invalid: null },
  };
}

/**
 * 多人节点签名。重复（同签署人、同决定、同理由）签名幂等，不增加 rev；
 * 同签署人改判会把旧签名保留为 invalid(superseded)。
 */
export function signReviewNode(session, view, key, decision, reason, { actor = '', now = Date.now() } = {}) {
  const p = normalizeReviewPolicy(session.policy);
  if (p.mode !== 'signoff') return { status: 400, reason: 'legacy-decision-required' };
  const checked = validateDecisionInput(decision, reason);
  if (checked.status) return checked;
  const by = normalizeActor(actor);
  if (!p.signers.includes(by)) return { status: 403, reason: 'signer-not-allowed', signer: by, allowed: p.signers };
  const sn = session.nodes.find((x) => x.key === key);
  if (!sn) return { status: 409, reason: 'node-missing' };
  if (session.status === 'completed') return { status: 409, reason: 'session-completed' };
  const codes = view.driftByKey?.get(key);
  if (codes?.length) return { status: 409, reason: codes[0], codes };
  if (view.baselineChanged) return { status: 409, reason: 'baseline-changed' };

  const active = activeSignatures(sn);
  const mine = active.find((s) => s.by === by);
  if (mine && mine.decision === decision && (mine.reason || '') === checked.reason) {
    return { status: 200, idempotent: true, signature: mine, session };
  }

  const nextSeq = sn.signatures.reduce((m, s) => Math.max(m, Number.isInteger(s.seq) ? s.seq : -1), -1) + 1;
  const signature = {
    id: uid('sg'), seq: nextSeq, at: now, by, decision, reason: checked.reason, invalid: null,
  };
  const before = signatureState(sn, p);
  const signatures = sn.signatures.map((s) => {
    if (s.invalid || s.by !== by) return s;
    return { ...s, invalid: invalidationFor(['superseded'], null, null, now) };
  });
  signatures.push(signature);
  const nodes = session.nodes.map((x) => {
    if (x.key !== key) return x;
    const replaced = { ...x, signatures, autoReview: null };
    const refreshed = refreshNodeSignatures(replaced, p, { now });
    const after = signatureState(refreshed, p);
    const history = [...x.history];
    if (before.decision !== 'pending' && before.decision !== after.decision) {
      history.push({ at: now, by, from: before.decision, to: after.decision, reason: checked.reason, signatureId: signature.id });
    }
    return { ...refreshed, history };
  });
  return {
    status: 200,
    signature,
    session: { ...session, nodes, updatedAt: now, rev: session.rev + 1 },
  };
}

/**
 * 409 后基于最新快照逐项合入本地保留的签名。普通 review-advanced 下等价于重放
 * 签名；节点仍漂移时仍然 409，避免把针对旧快照的签名直接当作当前有效签名。
 */
export function mergeReviewSignature(session, view, key, decision, reason, { actor = '', now = Date.now() } = {}) {
  const p = normalizeReviewPolicy(session.policy);
  if (p.mode !== 'signoff') return { status: 400, reason: 'legacy-decision-required' };
  if (view.driftByKey?.get(key)?.length) return { status: 409, reason: view.driftByKey.get(key)[0] };
  if (view.baselineChanged) {
    // 并发的是同一会话快照而非筛选基线变化；若该节点本身未漂移，允许显式合并。
  }
  const res = signReviewNode({ ...session, status: 'active' }, view, key, decision, reason, { actor, now });
  if (res.status !== 200) return res;
  if (res.idempotent) return { ...res, merged: true };
  const conflicts = res.session.conflicts.map((c) => {
    if (c.nodeKey === key && !c.resolved) return { ...c, resolved: true, resolvedAt: now, resolution: 'merged-local-signature' };
    return c;
  });
  return { ...res, merged: true, session: { ...res.session, conflicts } };
}

export function mergeReviewItem(session, key, decision, reason, { actor = '', now = Date.now(), resolution = 'merged-local' } = {}) {
  if (normalizeReviewPolicy(session.policy).mode === 'signoff') {
    return { status: 400, reason: 'multi-signoff-required' };
  }
  const checked = validateDecisionInput(decision, reason);
  if (checked.status) return checked;
  const sn = session.nodes.find((x) => x.key === key);
  if (!sn) return { status: 409, reason: 'node-missing' };
  const by = normalizeActor(actor);
  const nodes = session.nodes.map((x) => {
    if (x.key !== key) return x;
    const history = [...x.history, { at: now, by, from: effectiveDecision(x, session.policy), to: decision, reason: checked.reason, merged: true }];
    return {
      ...x, decision, reason: checked.reason, decidedBy: by, decidedAt: now,
      confirmedAt: now, autoReview: null, history,
    };
  });
  const conflicts = session.conflicts.map((c) => {
    if (c.nodeKey === key && !c.resolved) return { ...c, resolved: true, resolvedAt: now, resolution };
    return c;
  });
  return { status: 200, session: { ...session, nodes, conflicts, updatedAt: now, rev: session.rev + 1 } };
}

/* ---------------- 刷新基线 / 完成 / 重开 ---------------- */

function makeRebasedNode(sn, live, now) {
  return {
    key: live.key,
    order: 0,
    kind: live.kind,
    title: live.title,
    branchId: live.branch?.id || null,
    experimentId: live.experiment?.id || null,
    variantId: live.variant?.id || null,
    seqLabel: live.seqLabel || null,
    t: Number.isFinite(live.t) ? live.t : 0,
    actor: live.actor || '',
    fingerprint: nodeFingerprint(live),
    fingerprintBefore: live.hashBefore || null,
    replayable: !!live.replayable,
    severity: live.severity,
    decision: 'pending',
    reason: '',
    decidedBy: null,
    decidedAt: null,
    confirmedAt: null,
    signedBy: [],
    signatures: [],
    autoReview: null,
    absent: false,
    history: [],
    addedAtRebase: now,
  };
}

export function rebaseSession(session, view, { actor = '', now = Date.now() } = {}) {
  const byKey = new Map(session.nodes.map((n) => [n.key, n]));
  const ordered = [];
  for (const live of view.filteredNow) {
    const sn = byKey.get(live.key);
    ordered.push(sn || makeRebasedNode(null, live, now));
  }
  const absent = session.nodes.filter((sn) => !view.filteredNow.some((n) => n.key === sn.key))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const merged = [...ordered, ...absent];

  const nodes = merged.map((sn0, i) => {
    const live = view.byKey.get(sn0.key);
    let sn = { ...sn0, order: i, absent: !live };
    if (!live && sn.signatures?.length) {
      const { out } = invalidateSignatures(sn.signatures, ['node-missing'], live, now);
      sn = { ...sn, signatures: out };
    }
    return refreshNodeSignatures(sn, session.policy, { now });
  });
  const conflicts = session.conflicts.map((c) => {
    if (!c.derived || c.resolved) return c;
    if (c.code === 'baseline-changed' || c.code === 'fingerprint-changed') {
      return { ...c, resolved: true, resolvedAt: now, resolution: 'rebase' };
    }
    return c;
  });
  return {
    ...session,
    nodes,
    conflicts,
    baseline: {
      ...session.baseline,
      filterHash: reviewFilterHash(session.filter),
      orderHash: reviewOrderHash(view.filteredNow.map((n) => n.key)),
      timelineHash: view.currentHash,
      total: view.filteredNow.length,
      replayable: view.filteredNow.filter((n) => n.replayable).length,
      bad: view.filteredNow.filter((n) => n.severity === 'bad').length,
      warn: view.filteredNow.filter((n) => n.severity === 'warn').length,
    },
    updatedAt: now,
    rev: session.rev + 1,
    rebasedAt: now,
    rebasedBy: normalizeActor(actor),
  };
}

export function completeReview(session, view, { now = Date.now() } = {}) {
  const v = view?.session ? view.session : session;
  const p = sessionProgress(v);
  if (p.needsWork > 0) return { status: 409, reason: 'has-pending', pending: p.needsWork };
  const policy = normalizeReviewPolicy(session.policy);
  if (policy.completeRule === 'no-reject' && p.reject > 0) {
    return { status: 409, reason: 'has-reject', pending: p.reject };
  }
  return {
    status: 200,
    verdict: finalReviewVerdict(session, p),
    session: { ...session, status: 'completed', completedAt: now, updatedAt: now, rev: session.rev + 1 },
  };
}

export function reopenReview(session, { now = Date.now() } = {}) {
  if (session.status === 'active') return { status: 200, session };
  return { status: 200, session: { ...session, status: 'active', completedAt: null, updatedAt: now, rev: session.rev + 1 } };
}

/* ---------------- 加载清洗 ---------------- */

function sanitizeSignature(s0, i, policy, now) {
  if (!s0 || typeof s0 !== 'object' || typeof s0.id !== 'string') return null;
  if (!DECISION_SET.has(s0.decision)) return null;
  const by = normalizeActor(s0.by);
  let invalid = null;
  if (s0.invalid && typeof s0.invalid === 'object') {
    const code = typeof s0.invalid.code === 'string' ? s0.invalid.code : 'invalidated';
    const codes = Array.isArray(s0.invalid.codes) ? s0.invalid.codes.filter((x) => typeof x === 'string') : [code];
    invalid = {
      code: codes[0] || code,
      codes: codes.length ? codes : [code],
      reason: typeof s0.invalid.reason === 'string' ? s0.invalid.reason : (INVALID_REASONS[code] || code),
      at: Number.isFinite(s0.invalid.at) ? s0.invalid.at : now,
      fingerprintBefore: typeof s0.invalid.fingerprintBefore === 'string' ? s0.invalid.fingerprintBefore : null,
      fingerprintAfter: typeof s0.invalid.fingerprintAfter === 'string' ? s0.invalid.fingerprintAfter : null,
    };
  }
  if (policy.mode === 'signoff' && !invalid && !policy.signers.includes(by)) {
    invalid = invalidationFor(['not-allowed'], null, null, now);
  }
  return {
    id: s0.id,
    seq: Number.isInteger(s0.seq) ? s0.seq : i,
    at: Number.isFinite(s0.at) ? s0.at : now,
    by,
    decision: s0.decision,
    reason: typeof s0.reason === 'string' ? s0.reason.slice(0, 2000) : '',
    invalid,
  };
}

function sanitizeNode(n0, i, policy, now) {
  if (!n0 || typeof n0 !== 'object' || typeof n0.key !== 'string') return null;
  const decision = DECISION_SET.has(n0.decision) ? n0.decision : 'pending';
  const history = Array.isArray(n0.history) ? n0.history.filter((h) =>
    h && typeof h === 'object' && DECISION_SET.has(h.to)).map((h) => ({
      at: Number.isFinite(h.at) ? h.at : 0,
      by: normalizeActor(h.by),
      from: DECISION_SET.has(h.from) ? h.from : 'pending',
      to: h.to,
      reason: typeof h.reason === 'string' ? h.reason.slice(0, 2000) : '',
      ...(h.merged ? { merged: true } : {}),
      ...(typeof h.signatureId === 'string' ? { signatureId: h.signatureId } : {}),
    })) : [];

  let node = {
    key: n0.key,
    order: Number.isFinite(n0.order) ? n0.order : i,
    kind: typeof n0.kind === 'string' ? n0.kind : null,
    title: typeof n0.title === 'string' ? n0.title : n0.key,
    branchId: typeof n0.branchId === 'string' ? n0.branchId : null,
    experimentId: typeof n0.experimentId === 'string' ? n0.experimentId : null,
    variantId: typeof n0.variantId === 'string' ? n0.variantId : null,
    seqLabel: typeof n0.seqLabel === 'string' ? n0.seqLabel : null,
    t: Number.isFinite(n0.t) ? n0.t : 0,
    actor: typeof n0.actor === 'string' ? n0.actor : '',
    fingerprint: typeof n0.fingerprint === 'string' ? n0.fingerprint : null,
    fingerprintBefore: typeof n0.fingerprintBefore === 'string' ? n0.fingerprintBefore : null,
    replayable: n0.replayable !== false,
    severity: ['ok', 'warn', 'bad'].includes(n0.severity) ? n0.severity : 'ok',
    decision,
    reason: n0.reason !== null && n0.reason !== undefined ? String(n0.reason).slice(0, 2000) : '',
    decidedBy: typeof n0.decidedBy === 'string' ? n0.decidedBy : null,
    decidedAt: Number.isFinite(n0.decidedAt) ? n0.decidedAt : null,
    confirmedAt: Number.isFinite(n0.confirmedAt) ? n0.confirmedAt : null,
    signedBy: Array.isArray(n0.signedBy) ? n0.signedBy.filter((x) => typeof x === 'string') : [],
    signatures: [],
    autoReview: null,
    absent: false,
    history,
  };

  if (policy.mode === 'signoff') {
    const seenSig = new Set();
    const seenActiveSigner = new Set();
    const sigs = [];
    (Array.isArray(n0.signatures) ? n0.signatures : []).forEach((raw, si) => {
      const s = sanitizeSignature(raw, si, policy, now);
      if (!s || seenSig.has(s.id)) return;
      seenSig.add(s.id);
      if (!s.invalid) {
        if (seenActiveSigner.has(s.by)) s.invalid = invalidationFor(['duplicate-signer'], null, null, now);
        else seenActiveSigner.add(s.by);
      }
      sigs.push(s);
    });
    node.signatures = sigs.sort(compareSignatures);
    node = refreshNodeSignatures(node, policy, { now });
  }
  return node;
}

export function sanitizeReviewSessions(raw, wb, { now = Date.now() } = {}) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const s0 of raw) {
    if (!s0 || typeof s0 !== 'object' || typeof s0.id !== 'string') continue;
    if (seen.has(s0.id)) continue;
    seen.add(s0.id);
    const policy = normalizeReviewPolicy(s0.policy);
    const rawNodes = Array.isArray(s0.nodes) ? s0.nodes : [];
    const nodes = [];
    const seenKeys = new Set();
    rawNodes.forEach((n0, i) => {
      const n = sanitizeNode(n0, i, policy, now);
      if (!n || seenKeys.has(n.key)) return;
      seenKeys.add(n.key);
      nodes.push(n);
    });
    if (!nodes.length) continue;
    const seenC = new Set();
    const conflicts = (Array.isArray(s0.conflicts) ? s0.conflicts : []).filter((c) =>
      c && typeof c === 'object' && typeof c.id === 'string' && typeof c.code === 'string'
      && !seenC.has(c.id) && (seenC.add(c.id), true)).map((c) => ({
      id: c.id,
      derived: c.derived !== false,
      code: c.code,
      nodeKey: typeof c.nodeKey === 'string' ? c.nodeKey : null,
      text: typeof c.text === 'string' ? c.text : c.code,
      at: Number.isFinite(c.at) ? c.at : now,
      resolved: !!c.resolved,
      resolvedAt: Number.isFinite(c.resolvedAt) ? c.resolvedAt : null,
      resolution: typeof c.resolution === 'string' ? c.resolution : null,
    }));
    const session = {
      id: s0.id,
      formatVersion: REVIEW_FORMAT,
      name: String(s0.name || '审阅会话').slice(0, 60),
      createdBy: normalizeActor(s0.createdBy),
      createdAt: Number.isFinite(s0.createdAt) ? s0.createdAt : now,
      updatedAt: Number.isFinite(s0.updatedAt) ? s0.updatedAt : now,
      completedAt: Number.isFinite(s0.completedAt) ? s0.completedAt : null,
      status: s0.status === 'completed' ? 'completed' : 'active',
      filter: normalizeFilter(s0.filter),
      policy,
      baseline: s0.baseline && typeof s0.baseline === 'object' ? {
        filterHash: typeof s0.baseline.filterHash === 'string' ? s0.baseline.filterHash : '',
        orderHash: typeof s0.baseline.orderHash === 'string' ? s0.baseline.orderHash : '',
        timelineHash: typeof s0.baseline.timelineHash === 'string' ? s0.baseline.timelineHash : '',
        total: Number.isFinite(s0.baseline.total) ? s0.baseline.total : nodes.length,
        replayable: s0.baseline.replayable || 0,
        bad: s0.baseline.bad || 0,
        warn: s0.baseline.warn || 0,
        branchHeads: s0.baseline.branchHeads && typeof s0.baseline.branchHeads === 'object' ? s0.baseline.branchHeads : {},
      } : { filterHash: '', orderHash: reviewOrderHash(nodes.map((n) => n.key)), timelineHash: '', total: nodes.length, replayable: 0, bad: 0, warn: 0, branchHeads: {} },
      nodes,
      conflicts,
      rev: Number.isFinite(s0.rev) && s0.rev >= 1 ? Math.floor(s0.rev) : 1,
    };
    const reconciled = wb ? reconcileSession(session, wb, { now }).session : session;
    out.push(reconciled);
  }
  out.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
  return out;
}

/* ---------------- 跨窗口合流 / 服务端检查 ---------------- */

export function mergeReviewSessions(serverList, clientList) {
  const byId = new Map();
  const order = [];
  for (const s of Array.isArray(serverList) ? serverList : []) {
    if (!s || typeof s.id !== 'string') continue;
    byId.set(s.id, s);
    order.push(s.id);
  }
  for (const c of Array.isArray(clientList) ? clientList : []) {
    if (!c || typeof c.id !== 'string') continue;
    if (!byId.has(c.id)) {
      byId.set(c.id, c);
      order.push(c.id);
      continue;
    }
    const s = byId.get(c.id);
    const clientNewer = Number(c.rev || 0) > Number(s.rev || 0);
    const winner = clientNewer ? c : s;
    const cById = new Map((winner.conflicts || []).map((x) => [x.id, x]));
    for (const x of [...(s.conflicts || []), ...(c.conflicts || [])]) {
      if (!x || !x.id) continue;
      const ex = cById.get(x.id);
      if (!ex) cById.set(x.id, x);
      else if (!ex.resolved && x.resolved) cById.set(x.id, x);
    }
    byId.set(s.id, { ...winner, conflicts: [...cById.values()] });
  }
  return order.map((id) => byId.get(id));
}

export function assessServerReviewConflict(serverDoc, clientDoc) {
  const baseRevs = clientDoc?.baseReviewRevs;
  if (!baseRevs || typeof baseRevs !== 'object') return null;
  const curSessions = new Map((serverDoc?.reviewSessions || []).map((s) => [s.id, s]));
  const eff = effectiveDoc(serverDoc, clientDoc);

  for (const s of clientDoc?.reviewSessions || []) {
    if (!s || typeof s.id !== 'string') continue;
    const base = baseRevs[s.id];
    if (!Number.isInteger(base) || !Number.isInteger(s.rev) || s.rev <= base) continue;
    const srv = curSessions.get(s.id);
    if (srv && srv.rev !== base) {
      return { reason: 'review-advanced', sessionId: s.id, serverRev: srv.rev || 1 };
    }
    const badSig = checkSessionSignatures(s, srv, base);
    if (badSig) return { ...badSig, sessionId: s.id, serverRev: srv?.rev || base };
    for (const n of s.nodes || []) {
      const bad = checkReviewNodeAgainstServer(n, eff.byId, eff.branches, eff.experiments);
      if (bad) return { reason: bad, sessionId: s.id, nodeKey: n.key, serverRev: srv?.rev || base };
    }
  }
  return null;
}

function checkSessionSignatures(clientSession, serverSession) {
  const policy = normalizeReviewPolicy(clientSession?.policy);
  if (policy.mode !== 'signoff') return null;
  if (!policy.signers.length || policy.required < 1 || policy.required > policy.signers.length) {
    return { reason: 'review-policy-invalid' };
  }
  const serverById = new Map((serverSession?.nodes || []).map((n) => [n.key, n]));
  for (const n of clientSession?.nodes || []) {
    const old = serverById.get(n.key);
    const oldSigs = new Map((old?.signatures || []).map((s) => [s.id, s]));
    const seen = new Set((old?.signatures || []).filter((s) => s && !s.invalid).map((s) => s.by));
    for (const sg of n.signatures || []) {
      const oldSig = oldSigs.get(sg.id);
      if (oldSig) {
        // 已存在的有效签名是不可变审计记录；只允许在漂移对账时被标记 invalid。
        const invalidChanged = !!oldSig.invalid !== !!sg.invalid;
        const fieldsChanged = !oldSig.invalid && !sg.invalid
          && (oldSig.by !== sg.by || oldSig.decision !== sg.decision || (oldSig.reason || '') !== (sg.reason || ''));
        if (invalidChanged || fieldsChanged) {
          return { reason: 'review-signature-history-changed', nodeKey: n.key };
        }
        continue;
      }
      if (!sg || sg.invalid) continue;
      if (!policy.signers.includes(sg.by)) return { reason: 'review-signer-not-allowed', nodeKey: n.key };
      if (seen.has(sg.by)) return { reason: 'review-duplicate-signer', nodeKey: n.key };
      seen.add(sg.by);
    }
  }
  if (clientSession.status === 'completed') {
    for (const n of clientSession.nodes || []) {
      const active = activeSignatures(n);
      if (active.length < policy.required) return { reason: 'review-signature-shortfall', nodeKey: n.key };
      if (policy.completeRule === 'no-reject' && active.some((s) => s.decision === 'reject')) {
        return { reason: 'review-completion-has-reject', nodeKey: n.key };
      }
    }
  }
  return null;
}

function effectiveDoc(serverDoc, clientDoc) {
  const byId = new Map((serverDoc?.events || []).map((e) => [e.id, e]));
  for (const e of clientDoc?.events || []) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e);
  const branches = new Map((serverDoc?.branches || []).map((b) => [b.id, b]));
  for (const b of clientDoc?.branches || []) {
    if (!b?.id) continue;
    const cur = clientDoc.currentBranchId;
    branches.set(b.id, b.id === cur ? b : (branches.get(b.id) || b));
  }
  const byExpId = new Map((serverDoc?.experiments || []).map((x) => [x.id, x]));
  for (const x of clientDoc?.experiments || []) if (x?.id && !byExpId.has(x.id)) byExpId.set(x.id, x);
  return { byId, branches, experiments: [...byExpId.values()] };
}

export function findReviewNodeDrift(n, serverDoc) {
  const byId = new Map((serverDoc?.events || []).map((e) => [e.id, e]));
  const branches = new Map((serverDoc?.branches || []).map((b) => [b.id, b]));
  return checkReviewNodeAgainstServer(n, byId, branches, serverDoc.experiments || []);
}

function checkReviewNodeAgainstServer(n, byId, branches, experiments) {
  const key = String(n.key || '');
  if (key.startsWith('event:')) {
    const eid = key.slice(6);
    const ev = byId.get(eid);
    if (!ev) return 'review-node-missing';
    if (n.fingerprint && typeof ev.hash === 'string' && ev.hash !== n.fingerprint) return 'review-fingerprint-changed';
    if (!ev.parentId) return null;
    const bid = n.branchId || ev.branch;
    const b = branches.get(bid);
    if (b) {
      let cur = byId.get(b.headEventId), guard = 0;
      let onChain = false;
      while (cur && guard++ < 100000) {
        if (cur.id === eid) { onChain = true; break; }
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      if (!onChain) return 'review-branch-advanced';
    }
    return null;
  }
  if (key.startsWith('variant:')) {
    const rest = key.slice(8);
    const sep = rest.indexOf(':');
    const expId = rest.slice(0, sep);
    const vid = rest.slice(sep + 1);
    const exp = (experiments || []).find((x) => x.id === expId);
    const v = exp?.variants?.find((x) => x.id === vid);
    if (!exp || !v || v.status !== 'done' || !v.result) return 'review-node-missing';
    if (n.fingerprint && typeof v.result.hash === 'string' && v.result.hash !== n.fingerprint) return 'review-fingerprint-changed';
    return null;
  }
  return null;
}

/* ---------------- 导出审阅报告 ---------------- */

function nodeSigningReport(sn, policy, view) {
  const p = normalizeReviewPolicy(policy);
  const state = signatureState(sn, p);
  const activeIds = new Set(state.active.map((s) => s.id));
  const live = view?.byKey?.get(sn.key);
  const signatures = (sn.signatures || []).slice().sort(compareSignatures).map((s) => ({
    id: s.id,
    seq: s.seq,
    at: s.at,
    by: s.by,
    decision: s.decision,
    reason: s.reason || '',
    valid: !s.invalid,
    invalid: s.invalid || null,
  }));
  const activeNames = state.active.map((s) => s.by);;
  const unsigned = p.mode === 'signoff' ? p.signers.filter((name) => !activeNames.includes(name)) : [];
  return {
    mode: p.mode,
    allowedSigners: p.mode === 'signoff' ? p.signers : [],
    required: p.required,
    confirmed: state.confirmed,
    confirmedAt: state.confirmedAt,
    activeCount: state.active.length,
    activeSigners: activeNames,
    unsignedSigners: unsigned,
    counts: state.counts,
    currentFingerprint: live ? nodeFingerprint(live) : null,
    signatures,
  };
}

export function buildReviewReport(session, view, { generatedAt = null } = {}) {
  const v = view?.session ? view.session : session;
  const progress = sessionProgress(v);
  const changeLog = [];
  const nodes = v.nodes.map((sn) => {
    const policy = sn.policy || v.policy;
    if (policy?.mode !== 'signoff' && sn.decision !== 'pending' && sn.decidedAt != null) {
      const hasInitial = sn.history.some((h) => h.from === 'pending');
      if (!hasInitial) {
        changeLog.push({
          nodeKey: sn.key, title: sn.title, at: sn.decidedAt, by: sn.decidedBy,
          from: 'pending', to: sn.decision, reason: sn.reason, initial: true,
        });
      }
    }
    for (const h of sn.history) changeLog.push({ nodeKey: sn.key, title: sn.title, ...h });
    const st = signatureState(sn, policy);
    return {
      order: sn.order,
      key: sn.key,
      kind: sn.kind,
      title: sn.title,
      branchId: sn.branchId,
      experimentId: sn.experimentId,
      variantId: sn.variantId,
      seqLabel: sn.seqLabel,
      time: sn.t ? new Date(sn.t).toISOString() : null,
      actor: sn.actor,
      fingerprint: sn.fingerprint,
      fingerprintBefore: sn.fingerprintBefore,
      currentFingerprint: view?.byKey?.get(sn.key) ? nodeFingerprint(view.byKey.get(sn.key)) : null,
      replayable: sn.replayable,
      severity: sn.severity,
      absent: !!sn.absent,
      decision: sn.decision,
      effectiveDecision: sn.autoReview ? 'review' : st.decision,
      confirmed: st.confirmed,
      signing: nodeSigningReport(sn, policy, view),
      reason: st.reason || sn.reason || '',
      decidedBy: st.decidedBy || sn.decidedBy,
      decidedAt: st.decidedAt || sn.decidedAt,
      autoReview: sn.autoReview,
      history: sn.history,
    };
  });
  changeLog.sort((a, b) => (a.at - b.at) || (a.nodeKey < b.nodeKey ? -1 : 1));
  const openConflicts = (v.conflicts || []).filter((c) => !c.resolved);
  const policy = normalizeReviewPolicy(v.policy);
  return {
    format: 'rect-constraints/review-report',
    formatVersion: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    session: {
      id: v.id, name: v.name, createdBy: v.createdBy,
      createdAt: v.createdAt, updatedAt: v.updatedAt,
      status: v.status, completedAt: v.completedAt, rev: v.rev,
      policy,
      finalVerdict: finalReviewVerdict(v, progress),
    },
    filter: v.filter,
    policy,
    baseline: v.baseline,
    baselineChanged: !!view?.baselineChanged,
    newNodeKeys: (view?.newNodes || []).map((n) => n.key),
    progress,
    nodes,
    changeLog,
    conflicts: v.conflicts || [],
    openConflicts,
  };
}
