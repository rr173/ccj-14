/*
 * 布局审计与分支：纯函数模块（无 DOM / 存储依赖）。
 *
 * 审计事件 event（append-only，创建后不可修改）：
 *   {
 *     id, branch, parentId, kind: 'root' | 'edit' | 'fork-root',
 *     seq,            // 分支内序号（root/fork-root = 1）
 *     t, actor, label,
 *     model, report, hash,          // 提交后的完整布局快照（回放直接取它）
 *     hashBefore,                   // 提交前指纹（root 为 null）
 *     changes,                      // compareVersions 式结构化变更（root 为 null）
 *     conflicts,                    // 提交后的冲突结果快照（含冲突链）
 *     provenance?: { branchId, eventId, seq } // fork-root 才有：来源关系
 *   }
 *
 * 分支 branch：
 *   { id, name, createdAt, rootEventId, headEventId, redoTipId,
 *     source: { branchId, eventId } | null }
 *   - 主分支 id 固定为 'main'，root 为 kind='root' 的事件；
 *   - fork 出来的分支 root 为 kind='fork-root' 的事件（内容是来源事件的只读克隆，
 *     带 provenance），原分支事件绝不被复制/改写。
 *
 * 回放 = 直接读取事件保存的 model/report 快照；加载时用求解器重算指纹校验，
 * 校验失败的事件标记 corrupt 并保留在审计流里（当前布局仍可打开）。
 */

import { solve } from './solver.js';
import { validate, normalize, seedModel, uid } from './model.js';
import { compareVersions } from './versions.js';

export const MAIN_BRANCH = 'main';

const like = (ev) => ({ model: ev.model, report: ev.report, hash: ev.hash });

/** 构造根事件（新文档 / 种子）。 */
export function makeRootEvent(branch, { model = null, actor = '系统', t = Date.now(), label = '初始布局' } = {}) {
  const m = normalize(model || seedModel());
  const report = solve(m, null);
  return freeze({
    id: uid('e'), branch, parentId: null, kind: 'root', seq: 1, t,
    actor: String(actor || '系统'), label,
    model: m, report, hash: report.hash,
    hashBefore: null, changes: null, conflicts: structuredClone(report.conflicts),
  });
}

/**
 * 由一次已接受的提交构造审计事件（调用方须先完成 validate + findCycle + solve）。
 * @param parent 父事件（分支当前 head）
 * @param branch 分支 id
 * @param model 提交后（已固化不动点位置、已规范化）的模型
 * @param report 提交后的求解报告
 * @param meta {actor,label,t}
 */
export function makeEvent(parent, branch, model, report, { actor, label, t = Date.now() }) {
  const changes = parent ? compareVersions(like(parent), { model, report, hash: report.hash }) : null;
  const ev = {
    id: uid('e'), branch, parentId: parent ? parent.id : null,
    kind: 'edit', seq: (parent?.branch === branch ? parent.seq + 1 : 1),
    t, actor: String(actor || '未署名'), label: String(label || '编辑'),
    model: structuredClone(model), report: structuredClone(report), hash: report.hash,
    hashBefore: parent ? parent.hash : null,
    changes, conflicts: structuredClone(report.conflicts),
  };
  return freeze(ev);
}

/**
 * 从来源事件构造 fork-root 事件：内容与来源逐字节相同（同指纹），
 * 但 id/branch 是新分支的，并保留 provenance 来源关系。原事件不被改写。
 */
export function makeForkRootEvent(newBranchId, source, sourceBranch, { actor, t = Date.now() }) {
  const localSeq = source.branch === sourceBranch.id
    ? source.seq
    : localSeqOf(source, /* 来源自己的索引由调用方场景保证 */ new Map());
  return freeze({
    id: uid('e'), branch: newBranchId, parentId: null, kind: 'fork-root', seq: 1, t,
    actor: String(actor || '未署名'),
    label: `从「${sourceBranch.name}」#${source.seq} 另存为分支`,
    model: structuredClone(source.model),
    report: structuredClone(source.report),
    hash: source.hash,
    hashBefore: source.hash,
    changes: null,
    conflicts: structuredClone(source.conflicts || source.report?.conflicts || []),
    provenance: { branchId: sourceBranch.id, eventId: source.id, seq: source.seq },
  });
}

/* ---------------- 时间线浏览 ---------------- */

/** 事件在其所属分支链上的本地序号（从根 1 起）。 */
export function localSeqOf(ev, byId) {
  if (Number.isFinite(ev?.seq) && ev.seq > 0) return ev.seq;
  let n = 1, cur = ev, guard = 0;
  while (cur && cur.parentId && guard++ < 100000) { n++; cur = byId.get(cur.parentId); }
  return n;
}

/**
 * 构造某分支的浏览时间线（按序号正序）：
 *  { sourcePrefix:[fork 来源链行（跨分支，只读）], sourceBroken,
 *    chain:[root..head 行], detached:[被新提交取代的支线事件] }
 * 行 = { ev, localSeq, foreign, corrupt, replayable }
 */
export function timelineFor(branch, eventsById, branchesById) {
  const head = eventsById.get(branch.headEventId);
  const chainIds = [];
  let cur = head, guard = 0;
  while (cur && guard++ < 100000) {
    chainIds.push(cur.id);
    if (!cur.parentId) break;
    cur = eventsById.get(cur.parentId);
  }
  chainIds.reverse();

  // fork 分支：把来源分支到来源事件为止的链作为只读前缀拼上
  const sourcePrefix = [];
  let sourceBroken = false;
  const root = eventsById.get(chainIds[0]);
  if (root?.kind === 'fork-root' && root.provenance) {
    const prov = root.provenance;
    const srcBranch = branchesById.get(prov.branchId);
    if (!srcBranch) sourceBroken = true;
    let s = eventsById.get(prov.eventId);
    if (!s) {
      sourceBroken = true;
    } else {
      const ids = [];
      let sg = 0;
      while (s && sg++ < 100000) {
        ids.push(s.id);
        if (!s.parentId) break;
        const p = eventsById.get(s.parentId);
        if (!p) { sourceBroken = true; break; }
        s = p;
      }
      ids.reverse();
      for (const id of ids) {
        const ev = eventsById.get(id);
        if (!ev) { sourceBroken = true; continue; }
        sourcePrefix.push({
          ev, localSeq: localSeqOf(ev, eventsById), foreign: true,
          corrupt: !!ev.corrupt, replayable: !ev.corrupt && !!ev.model && !!ev.report,
        });
      }
    }
  }

  const chain = chainIds.map((id) => {
    const ev = eventsById.get(id);
    return {
      ev, localSeq: localSeqOf(ev, eventsById), foreign: false,
      corrupt: !!ev?.corrupt, replayable: ev && !ev.corrupt && !!ev.model && !!ev.report,
    };
  });

  const onChain = new Set(chainIds);
  const detached = [];
  for (const ev of eventsById.values()) {
    if (ev.branch !== branch.id || onChain.has(ev.id)) continue;
    detached.push({
      ev, localSeq: localSeqOf(ev, eventsById), foreign: false,
      corrupt: !!ev.corrupt, replayable: !ev.corrupt && !!ev.model && !!ev.report,
    });
  }
  detached.sort((a, b) => (a.ev.t - b.ev.t) || (a.ev.seq - b.ev.seq) || (a.ev.id < b.ev.id ? -1 : 1));

  return { sourcePrefix, sourceBroken, chain, detached };
}

/* ---------------- 加载清洗 / 损坏检测 ---------------- */

/**
 * 清洗持久化文档：逐条审计事件做结构校验 + 指纹重算。
 * - 坏事件保留（标 corrupt + corruptReason），绝不静默删除；
 * - 分支 head/root 落到坏事件或断链上时，沿父链回退到最近的可回放事件；
 * - 无法修复的分支被移除；主分支无法修复时 needSeed=true（当前布局仍可打开）。
 */
export function sanitizeAudit(doc) {
  const warnings = [];
  const rawEvents = Array.isArray(doc.events) ? doc.events : [];
  const byId = new Map();

  const seen = new Set();
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
      warnings.push({ level: 'error', text: '一条审计记录缺少 id，已跳过（无法定位）' });
      continue;
    }
    if (seen.has(raw.id)) {
      warnings.push({ level: 'error', text: `审计事件 ${raw.id} 重复，仅保留第一条` });
      continue;
    }
    seen.add(raw.id);
    byId.set(raw.id, sanitizeEvent(raw, warnings));
  }

  // 父链完整性：父事件缺失 → 该事件不可回放
  for (const ev of byId.values()) {
    if (ev.corrupt || !ev.parentId) continue;
    if (!byId.has(ev.parentId)) {
      markCorrupt(ev, '父事件丢失，审计链断裂');
      warnings.push({ level: 'error', text: `审计事件「${ev.label}」的父事件丢失，无法回放` });
    }
  }

  const branches = [];
  for (const b0 of Array.isArray(doc.branches) ? doc.branches : []) {
    if (!b0 || typeof b0 !== 'object' || typeof b0.id !== 'string' || typeof b0.name !== 'string') continue;
    const root = byId.get(b0.rootEventId);
    if (!root || root.corrupt || root.parentId) {
      warnings.push({ level: 'error', text: `分支「${b0.name}」的根事件不可回放，该分支未加载` });
      continue;
    }

    // head 修复：沿父链回退到最近可回放事件
    let headId = typeof b0.headEventId === 'string' ? b0.headEventId : root.id;
    let skipped = 0;
    let cur = byId.get(headId);
    const walkOk = (ev) => {
      const seen2 = new Set();
      let g = 0;
      while (ev && g++ < 100000) {
        if (seen2.has(ev.id) || ev.corrupt) return false;
        seen2.add(ev.id);
        if (ev.id === root.id) return true;
        ev = ev.parentId ? byId.get(ev.parentId) : null;
      }
      return false;
    };
    if (cur && !walkOk(cur)) {
      while (cur && !walkOk(cur)) { skipped++; cur = cur.parentId ? byId.get(cur.parentId) : null; }
    } else if (!cur) {
      skipped = 1;
    }
    if (!cur) { headId = root.id; }
    else headId = cur.id;
    if (skipped) {
      warnings.push({
        level: 'error',
        text: `分支「${b0.name}」head 附近有 ${skipped} 条不可回放事件，已回退到 #${localSeqOf(byId.get(headId), byId)}`,
      });
    }

    let redoTipId = typeof b0.redoTipId === 'string' && byId.has(b0.redoTipId) ? b0.redoTipId : null;
    if (redoTipId) {
      const tip = byId.get(redoTipId);
      if (tip.corrupt || !isAncestor(headId, redoTipId, byId)) redoTipId = null;
    }

    branches.push(freeze({
      id: b0.id,
      name: b0.name,
      createdAt: Number.isFinite(b0.createdAt) ? b0.createdAt : (byId.get(headId)?.t || 0),
      rootEventId: root.id,
      headEventId: headId,
      redoTipId,
      source: root.provenance ? { branchId: root.provenance.branchId, eventId: root.provenance.eventId } : null,
    }));
  }

  const branchesById = new Map(branches.map((b) => [b.id, b]));

  let needSeed = false;
  if (!branchesById.has(MAIN_BRANCH)) {
    warnings.push({ level: 'error', text: '主分支审计记录不可用，将以初始布局重新打开（历史审计仍保留可见，但无法回放）' });
    needSeed = true;
  }

  let currentBranchId = doc.currentBranchId;
  if (!branchesById.has(currentBranchId)) currentBranchId = MAIN_BRANCH;

  return {
    events: [...byId.values()],
    eventsById: byId,
    branches,
    branchesById,
    currentBranchId,
    actor: typeof doc.actor === 'string' ? doc.actor.slice(0, 40) : '',
    warnings,
    needSeed: needSeed || branches.length === 0,
  };
}

function sanitizeEvent(raw, warnings) {
  const scalar = {
    id: raw.id,
    branch: typeof raw.branch === 'string' ? raw.branch : MAIN_BRANCH,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    kind: ['root', 'edit', 'fork-root'].includes(raw.kind) ? raw.kind : 'edit',
    seq: Number.isFinite(raw.seq) && raw.seq > 0 ? Math.floor(raw.seq) : 0,
    t: Number.isFinite(raw.t) ? raw.t : 0,
    actor: typeof raw.actor === 'string' ? raw.actor : '未知操作者',
    label: typeof raw.label === 'string' ? raw.label : '编辑',
  };
  const tag = () => `#${scalar.seq || '?'}（${scalar.label}）`;
  const placeholder = {
    ...scalar,
    model: null, report: null,
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    hashBefore: typeof raw.hashBefore === 'string' ? raw.hashBefore : null,
    changes: raw.changes && typeof raw.changes === 'object' ? raw.changes : null,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    ...(raw.provenance && typeof raw.provenance === 'object' ? { provenance: raw.provenance } : {}),
  };

  const m0 = raw.model;
  if (!m0 || typeof m0 !== 'object' || !Array.isArray(m0.rects) || !Array.isArray(m0.constraints)) {
    markCorrupt(placeholder, '快照数据缺失或结构损坏');
    warnings.push({ level: 'error', text: `审计事件 ${tag()} 快照损坏，无法回放` });
    return placeholder;
  }
  const { errors } = validate(m0);
  if (errors.length) {
    markCorrupt(placeholder, `快照校验失败：${errors[0]}`);
    warnings.push({ level: 'error', text: `审计事件 ${tag()} 校验失败：${errors[0]}` });
    return placeholder;
  }
  let m, rep;
  try {
    m = normalize(m0);
    rep = solve(m, null);
  } catch (e) {
    markCorrupt(placeholder, `重算失败：${e.message}`);
    warnings.push({ level: 'error', text: `审计事件 ${tag()} 重算失败，无法回放` });
    return placeholder;
  }
  const storedHash = typeof raw.hash === 'string' && raw.hash ? raw.hash : (raw.report?.hash || '');
  if (!storedHash || rep.hash !== storedHash) {
    markCorrupt(placeholder, `指纹不一致：记录 ${storedHash || '缺失'}，重算 ${rep.hash}`);
    warnings.push({
      level: 'error',
      text: `审计事件 ${tag()} 指纹校验失败（记录 ${(storedHash || '缺失').slice(0, 8)} / 重算 ${rep.hash.slice(0, 8)}），无法回放`,
    });
    return placeholder;
  }
  // 指纹一致：求解器是确定性纯函数，规范化模型重算的 report 与记录语义等价；
  // 统一以重算结果回放，保证跨版本/重启逐字节一致。
  return freeze({
    ...scalar,
    seq: scalar.seq || 1,
    model: m, report: rep, hash: rep.hash,
    hashBefore: placeholder.hashBefore,
    changes: placeholder.changes,
    conflicts: Array.isArray(raw.conflicts) && raw.conflicts.length
      ? raw.conflicts
      : structuredClone(rep.conflicts),
    ...(raw.provenance && typeof raw.provenance === 'object' ? { provenance: raw.provenance } : {}),
  });
}

/** ancestor 是否是 descendant 的祖先（沿 parentId）。 */
export function isAncestor(ancestorId, descendantId, byId) {
  let cur = byId.get(descendantId);
  let guard = 0;
  while (cur && guard++ < 100000) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return false;
}

/* ---------------- 旧文档迁移 ---------------- */

/**
 * 旧版 entries/idx 文档迁移成事件流：主分支上按历史顺序串成审计链；
 * idx 之后的 redo 栈保留为可重放的支线事件（redoTip 指向最后一条）。
 */
export function migrateLegacy(doc) {
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const idx = Number.isInteger(doc.idx) ? Math.min(doc.idx, entries.length - 1) : entries.length - 1;
  const events = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // 统一以“规范化模型 + 求解不动点”为权威快照：先重算并把位置回写模型，
    // 再求解一次确认 idempotent fixpoint（与 Store.commit 的固化方式一致），
    // 保证迁移事件与后续事件回放结果逐字节一致。
    const m0 = normalize(e.model);
    const rep0 = solve(m0, null);
    for (const r of m0.rects) {
      const p = rep0.rects[r.id];
      if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
    }
    const m = normalize(m0);
    const report = solve(m, null);
    events.push(freeze({
      id: `e_legacy_${i}`,
      branch: MAIN_BRANCH,
      parentId: i === 0 ? null : `e_legacy_${i - 1}`,
      kind: i === 0 ? 'root' : 'edit',
      seq: i + 1,
      t: Number.isFinite(e.t) ? e.t : 0,
      actor: '历史迁移',
      label: i === 0 ? '初始布局' : (e.label || '历史编辑'),
      model: m,
      report,
      hash: report.hash,
      hashBefore: i === 0 ? null : events[i - 1].hash,
      changes: null,
      conflicts: structuredClone(report.conflicts || []),
    }));
  }
  const headEventId = idx >= 0 ? `e_legacy_${idx}` : null;
  const redoTipId = idx >= 0 && idx + 1 < entries.length ? `e_legacy_${entries.length - 1}` : null;
  const branches = entries.length ? [freeze({
    id: MAIN_BRANCH, name: '主分支', createdAt: entries[0]?.t || 0,
    rootEventId: 'e_legacy_0', headEventId, redoTipId, source: null,
  })] : [];
  return {
    events,
    branches,
    currentBranchId: MAIN_BRANCH,
    actor: typeof doc.actor === 'string' ? doc.actor : '',
  };
}

/* ---------------- 跨分支并发合流 ---------------- */

/**
 * 两个页面编辑不同分支时的合流规则（服务端 server.py 与此同构）：
 * - 事件不可变：按 id 并集，id 冲突以服务端为准；
 * - 客户端当前分支：快进到客户端的 head（提交前已验证 baseHeads 与服务端一致）；
 *   其余分支一律保留服务端 head；
 * - 客户端新建的分支（fork）整条加入；
 * - 版本（只读快照）按 id 并集；比较选择等元数据以服务端为准。
 */
export function mergeDocs(serverDoc, clientDoc) {
  const evs = new Map((serverDoc.events || []).map((e) => [e.id, e]));
  for (const e of clientDoc.events || []) if (!evs.has(e.id)) evs.set(e.id, e);

  const sb = new Map((serverDoc.branches || []).map((b) => [b.id, b]));
  const cb = new Map((clientDoc.branches || []).map((b) => [b.id, b]));
  const cur = clientDoc.currentBranchId;
  const outBranches = [];
  for (const [bid, b] of sb) outBranches.push(bid === cur && cb.has(bid) ? cb.get(bid) : b);
  for (const [bid, b] of cb) if (!sb.has(bid)) outBranches.push(b);

  const vs = new Map((serverDoc.versions || []).map((v) => [v.id, v]));
  for (const v of clientDoc.versions || []) if (!vs.has(v.id)) vs.set(v.id, v);

  return {
    ...serverDoc,
    events: [...evs.values()],
    branches: outBranches,
    versions: [...vs.values()],
    currentVersionId: serverDoc.currentVersionId ?? null,
    compare: serverDoc.compare || { a: null, b: null },
    branchCompare: serverDoc.branchCompare || { a: null, b: null },
    currentBranchId: cur && (sb.has(cur) || cb.has(cur)) ? cur : (serverDoc.currentBranchId || MAIN_BRANCH),
    actor: clientDoc.actor || serverDoc.actor || '',
  };
}

/**
 * 判断过期提交能否合流：客户端当前分支的 head 在服务端未前进（或分支是
 * 本次新建的 fork）时允许；同分支 head 已前进 → {mergeable:false,reason:'branch-advanced'}。
 */
export function assessConflict(serverDoc, clientDoc) {
  const byId = new Map((serverDoc.events || []).map((e) => [e.id, e]));
  const sb = new Map((serverDoc.branches || []).map((b) => [b.id, b]));
  const cur = clientDoc.currentBranchId;
  const baseHeads = clientDoc.baseHeads || {};
  const serverBranch = sb.get(cur);
  if (!serverBranch) {
    // 客户端新建的分支：fork-root 在客户端事件里；其 provenance 来源事件须已在服务端
    const nb = (clientDoc.branches || []).find((b) => b.id === cur);
    const root = (clientDoc.events || []).find((e) => e.id === nb?.rootEventId);
    const srcId = root?.provenance?.eventId;
    if (nb && srcId && byId.has(srcId)) return { mergeable: true };
    return { mergeable: false, reason: 'branch-missing' };
  }
  const base = baseHeads[cur];
  if (base !== serverBranch.headEventId) {
    const head = byId.get(serverBranch.headEventId);
    return {
      mergeable: false, reason: 'branch-advanced',
      branchId: cur, branchName: serverBranch.name,
      headEventId: serverBranch.headEventId,
      headSeq: head ? localSeqOf(head, byId) : null,
    };
  }
  return { mergeable: true };
}

/* ---------------- 冻结（不可修改） ---------------- */

export function freeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) freeze(v);
    }
  }
  return obj;
}

function markCorrupt(ev, reason) {
  Object.defineProperty(ev, 'corrupt', { value: true, configurable: true, enumerable: true, writable: true });
  Object.defineProperty(ev, 'corruptReason', { value: reason, configurable: true, enumerable: true, writable: true });
  return freeze(ev);
}
