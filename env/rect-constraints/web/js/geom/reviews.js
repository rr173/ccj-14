/*
 * 可恢复的审阅会话：纯函数模块（无 DOM / 存储依赖）。
 *
 * 用户在实验审计工作台从【当前筛选结果】创建审阅会话，按时间线顺序逐个节点
 * 记录 通过(pass) / 驳回(reject) / 待复核(review) 决定与理由。会话本身是一份
 * 创建时刻的**只读快照**：
 *   - 创建时的筛选条件；
 *   - 节点顺序（orderHash）与整条筛选基线（timelineHash：key+指纹+可回放性+健康级别）；
 *   - 每个节点的指纹（求解后，缺失时取求解前）、身份（分支/实验/变体/序号）；
 *   - 每个节点的决定、理由、决定人/时间与**决定变更记录**（history）。
 *
 * 乐观并发：会话带单调递增 rev。多个窗口同时审阅时，提交携带 baseReviewRevs；
 * 服务端发现会话 rev 已前进、节点指纹变化、节点缺失或事件所在分支已推进，
 * 一律 409 拒绝——本地决定保留在调用方（Store 的 reviewProposals），
 * 用户基于最新快照逐项合并（mergeReviewItem：采用本地 / 采用远端 / 改待复核）。
 *
 * 损坏容忍（reconcileSession，确定性、幂等、不增加 rev，可在任意时刻重算）：
 *   节点损坏 / 缺失 / 被分支推进 / 指纹变化后，原决定原样保留，节点有效状态
 *   自动转为「待复核」并附原因（autoReview），同时生成确定性 id 的冲突记录；
 *   刷新、重启、合流后这些标注逐字节一致地重新导出。
 *
 * 刷新基线（rebaseSession）：以当前筛选结果重建基线与顺序，已记录的决定 / 变更
 * 历史全部保留，新出现的节点成为未处理项，基线级冲突记录关闭。
 */

import { uid } from './model.js';
import { hash32 } from './experiments.js';
import { filterNodes } from './auditbench.js';

export const REVIEW_FORMAT = 1;
export const REVIEW_DECISIONS = ['pass', 'reject', 'review'];
const DECISION_SET = new Set(REVIEW_DECISIONS);

export const DECISION_LABEL = {
  pass: '通过', reject: '驳回', review: '待复核', pending: '未处理',
};

export const DRIFT_TEXT = {
  'node-missing': '节点已缺失：审计事件 / 变体结果不在当前时间线中（原决定保留，转待复核）',
  corrupt: '节点已损坏：快照指纹校验失败，无法回放（原决定保留，转待复核）',
  'fingerprint-changed': '节点指纹已变化：记录指纹与当前快照不一致（原决定保留，转待复核）',
  'branch-advanced': '分支已推进：该事件不在所属分支当前 head 父链上，属于支线事件（原决定保留，转待复核）',
};

/* ---------------- 指纹 / 哈希 ---------------- */

/** 节点指纹：优先求解后指纹；无结果快照（失败/排队变体）时取求解前。 */
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

/** 筛选基线指纹：顺序 + 每节点（key、指纹、可回放性、健康级别），任一变化即基线漂移。 */
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

/* ---------------- 创建会话快照 ---------------- */

export function createReviewSession({ name = '', actor = '', filter = {}, nodes = [], branches = [], now = Date.now() } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('当前筛选结果为空，无法创建审阅会话');
  const f = normalizeFilter(filter);
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
    autoReview: null,   // {code,codes,reason,at,fingerprintBefore,fingerprintAfter}
    absent: false,      // 已从当前时间线缺失（决定保留）
    history: [],        // {at,by,from,to,reason}
  }));
  const branchHeads = {};
  for (const b of branches || []) if (b && typeof b.id === 'string') branchHeads[b.id] = b.headEventId;
  const trimmed = String(name || '').trim().slice(0, 60);
  return {
    id: uid('rv'),
    formatVersion: REVIEW_FORMAT,
    name: trimmed || `审阅会话 ${new Date(now).toLocaleString()}`,
    createdBy: String(actor || '未署名').slice(0, 40),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    status: 'active', // active | completed
    filter: f,
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
    conflicts: [], // {id, derived, code, nodeKey, text, at, resolved, resolvedAt, resolution}
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

/**
 * 用当前统一时间线对账会话：纯函数、幂等、不改 rev。
 * @returns {{session, filteredNow, newNodes, baselineChanged, currentHash, driftByKey:Map}}
 */
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
  const nodes = session.nodes.map((sn) => {
    const live = byKey.get(sn.key);
    const codes = driftCodesOf(sn, live);
    if (codes.length) {
      driftByKey.set(sn.key, codes);
      const auto = {
        code: codes[0],
        codes,
        reason: codes.map((c) => DRIFT_TEXT[c]).join('；'),
        at: sn.autoReview?.at || now,
        fingerprintBefore: sn.autoReview?.fingerprintBefore || sn.fingerprint,
        fingerprintAfter: live ? nodeFingerprint(live) : null,
      };
      for (const code of codes) ensureDerived(sn.key, code);
      return { ...sn, absent: !live, autoReview: auto };
    }
    if (sn.autoReview) {
      // 恢复（例如刷新基线后支线状态被新基线接纳）：清除标注，关闭该节点派生冲突
      resolveDerived(sn.key, 'recovered', now);
      return { ...sn, autoReview: null, absent: false };
    }
    return { ...sn, absent: false };
  });

  // 基线级漂移：当前筛选结果与创建/上次刷新时的快照基线不一致
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

/** 节点的有效决定：被对账标记者一律展示为待复核（原决定仍保留在 decision 字段）。 */
export function effectiveDecision(sn) {
  return sn.autoReview ? 'review' : sn.decision;
}

export function sessionProgress(viewOrSession) {
  const nodes = viewOrSession?.nodes || [];
  const c = { total: nodes.length, pass: 0, reject: 0, review: 0, pending: 0, decided: 0, needsWork: 0 };
  for (const sn of nodes) {
    const eff = effectiveDecision(sn);
    if (eff === 'pending') c.pending += 1;
    else c[eff] += 1;
    if (sn.decision !== 'pending') c.decided += 1;
    if (eff === 'pending' || sn.autoReview) c.needsWork += 1;
  }
  c.done = c.total - c.needsWork;
  c.percent = c.total ? Math.round((c.decided / c.total) * 100) : 0;
  c.complete = c.total > 0 && c.needsWork === 0;
  return c;
}

/* ---------------- 决定记录（含提交时 409 判定） ---------------- */

function reasonRequired(decision) { return decision === 'reject' || decision === 'review'; }

/**
 * 记录一个节点的决定。
 * @returns {{status:200|409, reason?:string, session?:object}}
 *   节点损坏/缺失/指纹变化/分支推进、或筛选基线已漂移 → 409（调用方保留本地决定）。
 */
export function recordDecision(session, view, key, decision, reason, { actor = '', now = Date.now() } = {}) {
  if (!DECISION_SET.has(decision)) return { status: 400, reason: '非法决定' };
  const r = String(reason || '').trim().slice(0, 2000);
  if (reasonRequired(decision) && !r) return { status: 400, reason: '驳回 / 待复核必须填写理由' };
  const sn = session.nodes.find((x) => x.key === key);
  if (!sn) return { status: 409, reason: 'node-missing' };
  const codes = view.driftByKey?.get(key);
  if (codes?.length) return { status: 409, reason: codes[0], codes };
  if (view.baselineChanged) return { status: 409, reason: 'baseline-changed' };

  const by = String(actor || '未署名').slice(0, 40);
  const nodes = session.nodes.map((x) => {
    if (x.key !== key) return x;
    const history = [...x.history];
    // 首次决定（pending → 决定）只记录决定本身，不进入变更记录；此后的修改才追加
    if (x.decision !== 'pending' && (x.decision !== decision || x.reason !== r)) {
      history.push({ at: now, by, from: x.decision, to: decision, reason: r });
    }
    return { ...x, decision, reason: r, decidedBy: by, decidedAt: now, autoReview: null, history };
  });
  return {
    status: 200,
    session: { ...session, nodes, updatedAt: now, rev: session.rev + 1 },
  };
}

/**
 * 基于【最新快照】逐项合并：强制接受该节点的决定（用户在 409 后显式选择），
 * 关闭该节点的全部未决派生冲突；缺失节点保留 absent 标记。会话 rev +1。
 */
export function mergeReviewItem(session, key, decision, reason, { actor = '', now = Date.now(), resolution = 'merged-local' } = {}) {
  if (!DECISION_SET.has(decision)) return { status: 400, reason: '非法决定' };
  const r = String(reason || '').trim().slice(0, 2000);
  if (reasonRequired(decision) && !r) return { status: 400, reason: '驳回 / 待复核必须填写理由' };
  const sn = session.nodes.find((x) => x.key === key);
  if (!sn) return { status: 409, reason: 'node-missing' };
  const by = String(actor || '未署名').slice(0, 40);
  const nodes = session.nodes.map((x) => {
    if (x.key !== key) return x;
    // 逐项合并是显式的冲突解决动作：无论节点之前是否 pending 都追加一条带 merged 标记的记录
    const history = [...x.history, { at: now, by, from: effectiveDecision(x), to: decision, reason: r, merged: true }];
    return { ...x, decision, reason: r, decidedBy: by, decidedAt: now, autoReview: null, history };
  });
  const conflicts = session.conflicts.map((c) => {
    if (c.nodeKey === key && !c.resolved) {
      return { ...c, resolved: true, resolvedAt: now, resolution };
    }
    return c;
  });
  return {
    status: 200,
    session: { ...session, nodes, conflicts, updatedAt: now, rev: session.rev + 1 },
  };
}

/* ---------------- 刷新基线 / 完成 / 重开 ---------------- */

/**
 * 以当前筛选结果重建基线：当前节点按最新时间线排序，决定与变更历史全部保留；
 * 新出现节点成为未处理项；已缺失节点附在末尾并保留 absent 标记；
 * 基线级冲突关闭，节点级标注（仍损坏/缺失/支线）继续保留。rev +1。
 */
export function rebaseSession(session, view, { actor = '', now = Date.now() } = {}) {
  const byKey = new Map(session.nodes.map((n) => [n.key, n]));
  const ordered = [];
  for (const live of view.filteredNow) {
    const sn = byKey.get(live.key);
    if (sn) {
      ordered.push(sn);
    } else {
      // 基线刷新后新进入筛选结果的节点：纳入为未处理项，记录创建时快照指纹
      ordered.push({
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
        autoReview: null,
        absent: false,
        history: [],
        addedAtRebase: now,
      });
    }
  }
  const absent = session.nodes.filter((sn) => !view.filteredNow.some((n) => n.key === sn.key))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const merged = [...ordered, ...absent];

  const nodes = merged.map((sn, i) => ({ ...sn, order: i, absent: !view.byKey.has(sn.key) }));
  const conflicts = session.conflicts.map((c) => {
    if (!c.derived || c.resolved) return c;
    if (c.code === 'baseline-changed' || c.code === 'fingerprint-changed') {
      return { ...c, resolved: true, resolvedAt: now, resolution: 'rebase' };
    }
    return c; // corrupt / node-missing / branch-advanced：仍存在，保持未决
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
    rebasedBy: String(actor || '未署名').slice(0, 40),
  };
}

export function completeReview(session, view, { now = Date.now() } = {}) {
  const p = sessionProgress(view.session || session);
  if (p.needsWork > 0) return { status: 409, reason: 'has-pending', pending: p.needsWork };
  return {
    status: 200,
    session: { ...session, status: 'completed', completedAt: now, updatedAt: now, rev: session.rev + 1 },
  };
}

export function reopenReview(session, { now = Date.now() } = {}) {
  if (session.status === 'active') return { status: 200, session };
  return {
    status: 200,
    session: { ...session, status: 'active', completedAt: null, updatedAt: now, rev: session.rev + 1 },
  };
}

/* ---------------- 加载清洗 ---------------- */

/**
 * 清洗持久化的会话列表：结构容错、去重、字段归一；随后逐个对账，
 * 损坏/缺失/支线/基线漂移标注与冲突记录确定性地重建（不增加 rev）。
 */
export function sanitizeReviewSessions(raw, wb, { now = Date.now() } = {}) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const s0 of raw) {
    if (!s0 || typeof s0 !== 'object' || typeof s0.id !== 'string') continue;
    if (seen.has(s0.id)) continue;
    seen.add(s0.id);
    const rawNodes = Array.isArray(s0.nodes) ? s0.nodes : [];
    const nodes = [];
    const seenKeys = new Set();
    rawNodes.forEach((n0, i) => {
      if (!n0 || typeof n0 !== 'object' || typeof n0.key !== 'string' || seenKeys.has(n0.key)) return;
      seenKeys.add(n0.key);
      const decision = DECISION_SET.has(n0.decision) ? n0.decision : 'pending';
      const history = Array.isArray(n0.history) ? n0.history.filter((h) =>
        h && typeof h === 'object' && DECISION_SET.has(h.to)).map((h) => ({
        at: Number.isFinite(h.at) ? h.at : 0,
        by: String(h.by || '未署名').slice(0, 40),
        from: DECISION_SET.has(h.from) ? h.from : 'pending',
        to: h.to,
        reason: typeof h.reason === 'string' ? h.reason.slice(0, 2000) : '',
        ...(h.merged ? { merged: true } : {}),
      })) : [];
      nodes.push({
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
        autoReview: null,
        absent: false,
        history,
      });
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
      createdBy: String(s0.createdBy || '未署名').slice(0, 40),
      createdAt: Number.isFinite(s0.createdAt) ? s0.createdAt : now,
      updatedAt: Number.isFinite(s0.updatedAt) ? s0.updatedAt : now,
      completedAt: Number.isFinite(s0.completedAt) ? s0.completedAt : null,
      status: s0.status === 'completed' ? 'completed' : 'active',
      filter: normalizeFilter(s0.filter),
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
    // 对账：重建确定性标注（损坏/缺失/支线/基线漂移），幂等且不增加 rev
    const reconciled = wb ? reconcileSession(session, wb, { now }).session : session;
    out.push(reconciled);
  }
  out.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
  return out;
}

/* ---------------- 跨窗口合流 ---------------- */

/**
 * 会话按 id 并集；同 id 以 rev 更大者整体胜出（409 流程保证合流时严格大于），
 * 冲突记录按 id 并集（确定性派生记录在两侧同 id）。rev 相同以服务端为准。
 */
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

/**
 * 服务端视角的审阅冲突判定（与 server.py _assess_review_conflict 同构，
 * 也用于 localStorage 多页签检测与单元测试）。
 *
 * 只对本次【推进了 rev】的会话核验——与审阅无关的保存（矩形/约束提交、另一分支编辑）
 * 不因此被 409，它们在合流时按 rev 最大值保留会话：
 *   - 所依据的 baseRev 与服务端会话 rev 不一致（另一窗口已提交决定）→ review-advanced；
 *   - 节点指纹变化 / 节点缺失 / 事件已不在分支当前链上 → 对应 review-node-*。
 *
 * @returns null 或 {reason:'review-advanced'|'review-node-missing'|'review-fingerprint-changed'|'review-branch-advanced', sessionId, nodeKey?, serverRev}
 */
export function assessServerReviewConflict(serverDoc, clientDoc) {
  const baseRevs = clientDoc?.baseReviewRevs;
  if (!baseRevs || typeof baseRevs !== 'object') return null;
  const curSessions = new Map((serverDoc?.reviewSessions || []).map((s) => [s.id, s]));

  // 审计事件不可变：同包提交的新事件（几何编辑 + 审阅决定一起发出）是合法引用来源，
  // 按 id 并集构造“即将生效”的权威视图；当前分支取客户端 head（baseHeads 已做几何乐观锁）。
  const eff = effectiveDoc(serverDoc, clientDoc);

  for (const s of clientDoc?.reviewSessions || []) {
    if (!s || typeof s.id !== 'string') continue;
    const base = baseRevs[s.id];
    if (!Number.isInteger(base) || !Number.isInteger(s.rev) || s.rev <= base) continue;
    const srv = curSessions.get(s.id);
    if (srv && srv.rev !== base) {
      return { reason: 'review-advanced', sessionId: s.id, serverRev: srv.rev || 1 };
    }
    for (const n of s.nodes || []) {
      const bad = checkReviewNodeAgainstServer(n, eff.byId, eff.branches, eff.experiments);
      if (bad) return { reason: bad, sessionId: s.id, nodeKey: n.key, serverRev: srv?.rev || base };
    }
  }
  return null;
}

/** 服务端状态并上本次提交的不可变事件 / 新分支 / 实验，得到即将生效的权威视图。 */
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

/** 单节点相对权威文档的漂移（'review-node-missing' | 'review-fingerprint-changed' | 'review-branch-advanced' | null）。 */
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
    if (n.fingerprint && typeof ev.hash === 'string' && ev.hash !== n.fingerprint) {
      return 'review-fingerprint-changed';
    }
    // 分支已推进：事件不在其所属分支当前 head 父链上（root / fork-root 是各分支链顶，恒在链上）
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
    if (n.fingerprint && typeof v.result.hash === 'string' && v.result.hash !== n.fingerprint) {
      return 'review-fingerprint-changed';
    }
    return null;
  }
  return null;
}

/* ---------------- 导出审阅报告 ---------------- */

/**
 * 构造完整审阅报告：会话快照（筛选/基线/节点指纹/身份）、当前进度、
 * 每节点决定与理由、决定变更记录、系统转待复核标注、全部冲突记录与当前漂移。
 */
export function buildReviewReport(session, view, { generatedAt = null } = {}) {
  const v = view?.session ? view.session : session;
  const progress = sessionProgress(v);
  const changeLog = [];
  const nodes = v.nodes.map((sn) => {
    // 报告的决定日志是完整审计轨迹：首次决定（pending → 决定）也收录并标 initial，
    // 之后的修改取自 history（变更记录）
    if (sn.decision !== 'pending' && sn.decidedAt != null) {
      const hasInitial = sn.history.some((h) => h.from === 'pending');
      if (!hasInitial) {
        changeLog.push({
          nodeKey: sn.key, title: sn.title, at: sn.decidedAt, by: sn.decidedBy,
          from: 'pending', to: sn.decision, reason: sn.reason, initial: true,
        });
      }
    }
    for (const h of sn.history) changeLog.push({ nodeKey: sn.key, title: sn.title, ...h });
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
      effectiveDecision: effectiveDecision(sn),
      reason: sn.reason,
      decidedBy: sn.decidedBy,
      decidedAt: sn.decidedAt,
      autoReview: sn.autoReview,
      history: sn.history,
    };
  });
  changeLog.sort((a, b) => (a.at - b.at) || (a.nodeKey < b.nodeKey ? -1 : 1));
  const openConflicts = (v.conflicts || []).filter((c) => !c.resolved);
  return {
    format: 'rect-constraints/review-report',
    formatVersion: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    session: {
      id: v.id, name: v.name, createdBy: v.createdBy,
      createdAt: v.createdAt, updatedAt: v.updatedAt,
      status: v.status, completedAt: v.completedAt, rev: v.rev,
    },
    filter: v.filter,
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
