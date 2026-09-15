/*
 * 编辑分支三方合并（纯函数，无 DOM / 存储依赖）。
 *
 * 合并基于【共同祖先】（merge base）：
 *   base   —— 来源分支与目标分支的最近共同事件（沿 parentId 链，含 fork-root 的 provenance 跨分支回溯）
 *   target —— 目标分支当前 head（合并结果提交到这里）
 *   source —— 来源分支当前 head
 *
 * 对象级三方合并规则：
 *   - 只在一边改动（增/删/改）-> 自动合并（auto 项）；
 *   - 两边都改同一对象、或一边删除一边修改 -> 冲突项，必须逐项选择
 *     保留目标(target) / 采用来源(source) / 手动填写结果(manual)，未解决不能完成；
 *   - 两边新增出同 id 对象 -> add-add 冲突。
 *
 * 合并结果在完成前要通过结构校验（validate）+ 环检测（findCycle）+ 越界检查，
 * 并且求解（solve）后不得出现新的悬空引用；任何一项不通过都明确阻止完成。
 *
 * 合并草案（merge draft）是可反复打开的持久化对象，记录：
 * 共同祖先身份、来源/目标分支与各自 head、逐项冲突选择、来源关系、合并报告；
 * 重复提交同一份（同 draft id / 同结果指纹）草案幂等，绝不产生重复事件。
 */

import { solve, findCycle } from './solver.js';
import { validate, normalize } from './model.js';
import { compareVersions } from './versions.js';

export const MERGE_KIND = 'merge';

/** 深冻结（与 audit.freeze 同语义；本地定义以避免与 audit.js 循环导入）。 */
function freeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) freeze(v);
    }
  }
  return obj;
}

/* ---------------- 共同祖先 ---------------- */

/** 事件沿 parentId 的祖先 id 集合（含自身）。 */
export function ancestorIds(ev, byId, { includeProvenance = true } = {}) {
  const out = new Set();
  let cur = ev, guard = 0;
  while (cur && guard++ < 1000000) {
    if (out.has(cur.id)) break;
    out.add(cur.id);
    if (cur.parentId) {
      cur = byId.get(cur.parentId);
      continue;
    }
    // 链顶：若是 fork-root，跨分支跳到 provenance 来源事件继续上溯
    if (includeProvenance && cur.kind === 'fork-root' && cur.provenance?.eventId && cur.provenance?.kind !== 'migration') {
      const src = byId.get(cur.provenance.eventId);
      if (src) { cur = src; continue; }
    }
    break;
  }
  return out;
}

/** 目标 head 沿 parentId（含 fork provenance 跨分支）的事件序列，head 在前。 */
function targetChain(head, byId) {
  const chain = [];
  let cur = head, guard = 0;
  while (cur && guard++ < 1000000) {
    chain.push(cur);
    if (cur.parentId) { cur = byId.get(cur.parentId); continue; }
    if (cur.kind === 'fork-root' && cur.provenance?.eventId && cur.provenance?.kind !== 'migration') {
      const src = byId.get(cur.provenance.eventId);
      if (src) { cur = src; continue; }
    }
    break;
  }
  return chain;
}

/**
 * 最近共同祖先（merge base）事件。
 * 取 source 祖先集合与 target 链（含跨分支来源）的第一个交集；无共同祖先返回 null。
 */
export function findMergeBase(targetHead, sourceHead, byId) {
  if (!targetHead || !sourceHead) return null;
  if (targetHead.id === sourceHead.id) return targetHead;
  const sourceAncestors = ancestorIds(sourceHead, byId);
  for (const ev of targetChain(targetHead, byId)) {
    if (sourceAncestors.has(ev.id)) return ev;
  }
  return null;
}

/* ---------------- 对象快照与差异 ---------------- */

const RECT_FIELDS = ['name', 'x', 'y', 'w', 'h'];

const rectKey = (r) => JSON.stringify(RECT_FIELDS.map((f) => r[f]));
// 键必须含 id（同 id 在 tri 里配对，但不同 id 的约束不能被判为“相同”），
// 再含全部类型相关字段：两个不同约束 / 同约束不同参数都要得到不同键。
const consKey = (c) => JSON.stringify({ id: c.id, ...mergeFieldsOf(c) });

/** 约束参与合并比较的字段（规范化后，全部可能字段）。 */
function mergeFieldsOf(c) {
  const base = {
    kind: c.kind, rect: c.rect, priority: c.priority, enabled: c.enabled !== false,
  };
  if (c.kind === 'snap') return { ...base, other: c.other, axis: c.axis, edge: c.edge, otherEdge: c.otherEdge, gap: c.gap };
  if (c.kind === 'minGap') return { ...base, other: c.other, side: c.side, gap: c.gap };
  if (c.kind === 'contain') return { ...base, margin: c.margin };
  return { ...base, w: c.w, h: c.h }; // lock
}

function tri(base, target, source, keyOf) {
  const mapB = new Map((base || []).map((x) => [x.id, x]));
  const mapT = new Map((target || []).map((x) => [x.id, x]));
  const mapS = new Map((source || []).map((x) => [x.id, x]));
  const ids = [...new Set([...mapB.keys(), ...mapT.keys(), ...mapS.keys()])].sort();
  const auto = [], conflicts = [];
  for (const id of ids) {
    const b = mapB.get(id), t = mapT.get(id), s = mapS.get(id);
    const kb = b ? keyOf(b) : null, kt = t ? keyOf(t) : null, ks = s ? keyOf(s) : null;
    const tChanged = kt !== kb, sChanged = ks !== kb;
    const item = { id, base: b || null, target: t || null, source: s || null,
      targetChanged: tChanged, sourceChanged: sChanged, sameResult: kt === ks };
    if (!tChanged && !sChanged) {
      // 两边都没动：保持目标值（来自 base），不算自动项也不算冲突
      continue;
    }
    if (tChanged && !sChanged) auto.push({ ...item, resolution: 'target' });
    else if (sChanged && !tChanged) auto.push({ ...item, resolution: 'source' });
    else conflicts.push({ ...item }); // 两边都动（含删除/新增相撞）
  }
  return { auto, conflicts };
}

/* ---------------- 草案 ---------------- */

/**
 * 计算合并草案（不落盘、不追加事件）。返回：
 * {
 *   ok, baseEventId, baseLabel,
 *   targetBranchId/sourceBranchId, targetHeadId/sourceHeadId, baseHeadSnapshot,
 *   rects:    { auto:[{id,name,resolution,targetChanged,sourceChanged,target,source,base}],
 *               conflicts:[同结构 + kind:'rect'] },
 *   constraints: { auto, conflicts },
 *   autoSummary / conflictSummary / counts,
 * }
 * 入参 heads 是事件（取其规范化 model）；无共同祖先时 ok:false, reason:'no-common-ancestor'。
 */
export function buildMergePlan({ targetEvent, sourceEvent, targetBranch, sourceBranch, byId }) {
  const base = findMergeBase(targetEvent, sourceEvent, byId);
  if (!base) {
    return { ok: false, reason: 'no-common-ancestor',
      message: '两个分支没有共同祖先（可能来自互不相关的迁移导入），无法进行三方合并' };
  }
  const mB = base.model, mT = targetEvent.model, mS = sourceEvent.model;
  const rects = tri(mB.rects, mT.rects, mS.rects, rectKey);
  const cons = tri(mB.constraints, mT.constraints, mS.constraints, consKey);

  const nameOf = (id) =>
    mT.rects.find((r) => r.id === id)?.name || mS.rects.find((r) => r.id === id)?.name
    || mB.rects.find((r) => r.id === id)?.name || id;

  const decorateRect = (x) => ({
    ...x,
    kind: 'rect',
    name: (x.target || x.source || x.base)?.name || nameOf(x.id),
  });
  const rectName = new Map([...mB.rects, ...mT.rects, ...mS.rects].map((r) => [r.id, r]));
  const decorateCons = (x) => ({
    ...x,
    kind: 'constraint',
    name: (x.target || x.source || x.base)?.id || x.id,
    label: consLabel(x.target || x.source || x.base, rectName),
  });

  const rectAuto = rects.auto.map(decorateRect).sort(byIdCmp);
  const rectConflicts = rects.conflicts.map(decorateRect).sort(byIdCmp);
  const consAuto = cons.auto.map(decorateCons).sort(byIdCmp);
  const consConflicts = cons.conflicts.map(decorateCons).sort(byIdCmp);

  return freeze({
    ok: true,
    baseEventId: base.id,
    baseBranchId: base.branch,
    baseSeq: base.seq,
    baseLabel: base.label,
    baseHash: base.hash,
    targetBranchId: targetBranch.id,
    targetBranchName: targetBranch.name,
    sourceBranchId: sourceBranch.id,
    sourceBranchName: sourceBranch.name,
    targetHeadId: targetEvent.id,
    sourceHeadId: sourceEvent.id,
    targetHeadSeq: targetEvent.seq,
    sourceHeadSeq: sourceEvent.seq,
    targetHeadHash: targetEvent.hash,
    sourceHeadHash: sourceEvent.hash,
    rects: { auto: rectAuto, conflicts: rectConflicts },
    constraints: { auto: consAuto, conflicts: consConflicts },
    counts: {
      auto: rectAuto.length + consAuto.length,
      conflicts: rectConflicts.length + consConflicts.length,
      rectAuto: rectAuto.length, rectConflicts: rectConflicts.length,
      constraintAuto: consAuto.length, constraintConflicts: consConflicts.length,
    },
  });
}

const byIdCmp = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function consLabel(c, rectName) {
  if (!c) return '?';
  const nm = (id) => rectName.get(id)?.name || id;
  if (c.kind === 'snap') return `贴齐 ${nm(c.rect)} → ${nm(c.other)}（${c.axis}/${c.edge}-${c.otherEdge}，偏移 ${c.gap}，优先级 ${c.priority}）`;
  if (c.kind === 'minGap') return `最小间距 ${nm(c.rect)} ${c.side} ${nm(c.other)} ≥ ${c.gap}（优先级 ${c.priority}）`;
  if (c.kind === 'contain') return `画布包含 ${nm(c.rect)}（边距 ${c.margin}，优先级 ${c.priority}）`;
  return `锁定尺寸 ${nm(c.rect)} (${c.w}×${c.h}，优先级 ${c.priority})`;
}

/* ---------------- 应用选择，构造合并模型 ---------------- */

export const itemKey = (item) => `${item.kind}:${item.id}`;

/**
 * 完整组装合并后的模型（纯函数）。
 * @param models {base,target,source} 三方规范化模型（由 Store 从对应事件注入）。
 */
export function assembleMergeModel(plan, choices, models) {
  const { base: mB, target: mT, source: mS } = models;
  const unresolved = [];
  const chosen = new Map();
  for (const item of [...plan.rects.conflicts, ...plan.constraints.conflicts]) {
    const key = itemKey(item);
    const ch = choices.get(key);
    if (!ch || !['target', 'source', 'manual'].includes(ch.resolution)) { unresolved.push(key); continue; }
    chosen.set(key, ch);
  }
  if (unresolved.length) return { ok: false, unresolved, model: null, report: null };

  const autoOrConflict = new Map();
  for (const it of [...plan.rects.auto, ...plan.rects.conflicts]) autoOrConflict.set(`rect:${it.id}`, it);
  for (const it of [...plan.constraints.auto, ...plan.constraints.conflicts]) autoOrConflict.set(`constraint:${it.id}`, it);

  // 矩形：id -> 存活对象或 null（删除）
  const rectOut = new Map();
  const allRectIds = new Set([...mT.rects.map((r) => r.id), ...mS.rects.map((r) => r.id), ...mB.rects.map((r) => r.id)]);
  for (const id of [...allRectIds].sort()) {
    const it = autoOrConflict.get(`rect:${id}`);
    let r;
    if (!it) r = mT.rects.find((x) => x.id === id); // 两边都没改：取目标（== base）
    else r = resolveItem(it, chosen, 'rect');
    if (r) rectOut.set(id, structuredClone(r));
  }

  // 约束同理
  const consOut = new Map();
  const allConsIds = new Set([...mT.constraints.map((c) => c.id), ...mS.constraints.map((c) => c.id), ...mB.constraints.map((c) => c.id)]);
  for (const id of [...allConsIds].sort()) {
    const it = autoOrConflict.get(`constraint:${id}`);
    let c;
    if (!it) c = mT.constraints.find((x) => x.id === id);
    else c = resolveItem(it, chosen, 'constraint');
    if (c) consOut.set(id, structuredClone(c));
  }

  const canvas = mT.canvas; // 画布不参与三方（编辑器没有画布尺寸编辑），取目标
  const draft = {
    canvas: structuredClone(canvas),
    rects: [...rectOut.values()],
    constraints: [...consOut.values()],
  };
  return { ok: true, unresolved: [], model: draft, report: null, chosen };
}

function resolveItem(it, chosen, kind) {
  if (it.targetChanged && !it.sourceChanged) return it.target;
  if (it.sourceChanged && !it.targetChanged) return it.source;
  const ch = chosen.get(`${kind}:${it.id}`);
  if (ch.resolution === 'target') return it.target; // null = 删除
  if (ch.resolution === 'source') return it.source; // null = 删除
  return ch.manual; // null = 手动选择删除
}

/* ---------------- 校验合并结果（阻止完成的条件） ---------------- */

/**
 * 校验合并模型：结构 + 悬空引用 + 环 + 越界；通过后规范化 + 求解 + 固化不动点。
 * 返回 { ok, errors:[{code,message,detail}], model, report }。
 */
export function finalizeMergeModel(rawModel) {
  const errors = [];

  // 1) 结构校验（重复 id、非法几何、未知约束类型等）
  const { errors: structural } = validate(rawModel);
  for (const message of structural) errors.push({ code: 'invalid-model', message });

  // validate 已覆盖“引用不存在矩形”的悬空；手动结果可能绕过对象三方，再显式复查一次
  const rectIds = new Set((rawModel.rects || []).map((r) => r.id));
  for (const c of rawModel.constraints || []) {
    if (!rectIds.has(c.rect)) {
      errors.push({ code: 'dangling-ref', message: `约束「${c.id}」的跟随矩形 ${c.rect} 在合并结果中不存在（悬空引用）` });
    }
    if ((c.kind === 'snap' || c.kind === 'minGap') && !rectIds.has(c.other)) {
      errors.push({ code: 'dangling-ref', message: `约束「${c.id}」引用的锚点矩形 ${c.other} 在合并结果中不存在（悬空引用）` });
    }
  }
  // 矩形 id 重复（手动结果可能制造）
  const seenR = new Set();
  for (const r of rawModel.rects || []) {
    if (seenR.has(r.id)) errors.push({ code: 'duplicate-id', message: `合并结果中矩形 id 重复：${r.id}` });
    seenR.add(r.id);
  }
  const seenC = new Set();
  for (const c of rawModel.constraints || []) {
    if (seenC.has(c.id)) errors.push({ code: 'duplicate-id', message: `合并结果中约束 id 重复：${c.id}` });
    seenC.add(c.id);
  }

  // 2) 环检测
  let cycle = null;
  try { cycle = findCycle(rawModel.constraints || []); } catch (e) { errors.push({ code: 'cycle-error', message: `环检测失败：${e.message}` }); }
  if (cycle) {
    errors.push({
      code: 'cycle',
      message: `合并结果存在循环依赖：${cycle.nodeIds.join(' → ')}（闭环约束 ${cycle.cids.join('、')}），请调整冲突选择后重试`,
      detail: { nodeIds: cycle.nodeIds, cids: cycle.cids },
    });
  }

  // 3) 越界检查（严格：矩形必须完全落在画布内；求解器只做求解不夹取，越界必须明确阻止）
  const cw = rawModel.canvas?.w, chh = rawModel.canvas?.h;
  if (Number.isFinite(cw) && Number.isFinite(chh)) {
    for (const r of rawModel.rects || []) {
      if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) || !(r.w > 0) || !(r.h > 0)) continue; // validate 已报
      if (r.x < 0 || r.y < 0 || r.x + r.w > cw + 1e-6 || r.y + r.h > chh + 1e-6) {
        errors.push({
          code: 'out-of-bounds',
          message: `矩形「${r.name || r.id}」合并后超出画布（${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}，画布 ${cw}×${chh}），请调整冲突选择或手动修正位置`,
          detail: { id: r.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } },
        });
      }
    }
  }

  if (errors.length) return { ok: false, errors, model: null, report: null, cycle };

  // 4) 规范化 + 确定性求解 + 固化不动点（与正常提交同一管线）
  const model = normalize(rawModel);
  const report = solve(model, null);
  for (const r of model.rects) {
    const p = report.rects[r.id];
    if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
  }
  // 固化后再验一次越界（求解器移动可能改变边界状态）
  const afterBounds = [];
  for (const r of model.rects) {
    if (r.x < -1e-6 || r.y < -1e-6 || r.x + r.w > cw + 1e-6 || r.y + r.h > chh + 1e-6) {
      afterBounds.push({ code: 'out-of-bounds', message: `矩形「${r.name || r.id}」求解后仍超出画布，请调整冲突选择`, detail: { id: r.id } });
    }
  }
  if (afterBounds.length) return { ok: false, errors: afterBounds, model: null, report: null, cycle: null };

  return { ok: true, errors: [], model, report, cycle: null };
}

/* ---------------- 合并报告 ---------------- */

/**
 * 生成合并报告（完成后可查看合并前后差异 + 逐项裁决）。
 * targetEvent: 目标分支原 head；outcome: {model, report}；plan + choices。
 */
export function buildMergeReport({ plan, choices, targetEvent, outcome, mergeEventId = null, completedAt = Date.now() }) {
  const before = { model: targetEvent.model, report: targetEvent.report, hash: targetEvent.hash };
  const after = { model: outcome.model, report: outcome.report, hash: outcome.report.hash };
  const diffTarget = compareVersions(before, after);
  void plan;

  const itemRows = [];
  const pushRow = (item, resolution, via) => itemRows.push({
    kind: item.kind, id: item.id,
    name: item.kind === 'rect' ? item.name : item.label,
    targetChanged: item.targetChanged, sourceChanged: item.sourceChanged,
    resolution, via,
  });
  for (const it of plan.rects.auto) pushRow(it, it.resolution, 'auto');
  for (const it of plan.constraints.auto) pushRow(it, it.resolution, 'auto');
  for (const it of [...plan.rects.conflicts, ...plan.constraints.conflicts]) {
    const ch = choices.get(itemKey(it));
    pushRow(it, ch?.resolution || 'unresolved', 'conflict');
  }
  itemRows.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));

  return freeze({
    mergeEventId,
    completedAt,
    base: { eventId: plan.baseEventId, branchId: plan.baseBranchId, seq: plan.baseSeq, label: plan.baseLabel, hash: plan.baseHash },
    target: { branchId: plan.targetBranchId, branchName: plan.targetBranchName, headId: plan.targetHeadId, headSeq: plan.targetHeadSeq, hash: plan.targetHeadHash },
    source: { branchId: plan.sourceBranchId, branchName: plan.sourceBranchName, headId: plan.sourceHeadId, headSeq: plan.sourceHeadSeq, hash: plan.sourceHeadHash },
    diff: diffTarget,
    hashBefore: targetEvent.hash,
    hashAfter: outcome.report.hash,
    items: itemRows,
    autoCount: plan.counts.auto,
    conflictCount: plan.counts.conflicts,
  });
}

/* ---------------- 草案持久化形态 ---------------- */

/**
 * 构造（或重建）一个可持久化、可反复打开的合并草案对象。
 * 同 (targetBranchId, sourceBranchId, targetHeadId, sourceHeadId) 派生确定性 id：
 * 重复打开同一对 head 复用同一草案（不产生重复草案 / 重复事件）。
 */
export function makeMergeDraft(plan, { id = null, createdAt = Date.now(), actor = '' } = {}) {
  const did = id || mergeDraftId(plan);
  return freeze({
    id: did,
    createdAt,
    updatedAt: createdAt,
    actor: String(actor || ''),
    status: 'open', // open | completed | abandoned
    targetBranchId: plan.targetBranchId,
    sourceBranchId: plan.sourceBranchId,
    targetHeadId: plan.targetHeadId,
    sourceHeadId: plan.sourceHeadId,
    baseEventId: plan.baseEventId,
    baseHash: plan.baseHash,
    targetHeadHash: plan.targetHeadHash,
    sourceHeadHash: plan.sourceHeadHash,
    // 逐项冲突选择（仅保存用户【已确认】的选择）：{key, resolution, manual?}；自动项不存（由 plan 确定性推出）
    choices: [],
    // “更新到最新分支头”后，旧草案里对【仍存在的冲突】的旧选择仅作参考保留：
    // 它们不再生效（不参与组装 / 提交），用户必须逐项再次确认；确认后从这里移入 choices。
    priorChoices: [],
    // 完成后回填
    completedAt: null,
    mergeEventId: null,
    resultHash: null,
    report: null,
    conflictStale: null, // 目标分支在合并期间前进时记录 {fromHeadId,toHeadId,at}
    refreshedAt: null,   // 最近一次更新到最新分支头的时间（旧选择重置为参考的时间点）
  });
}

/**
 * 更新到最新分支头时重映射旧冲突选择。
 * 旧选择绝不能在新计划上直接生效（旧冲突裁决可能已过时）：
 *   - 旧草案 choices 中、键仍属于新计划冲突项的 -> 全部移入 priorChoices，仅供页面参考；
 *   - 键已不再是冲突（变自动项 / 对象消失 / 趋同）-> 直接丢弃；
 *   - 新草案的已确认 choices 一律为空，所有仍存在的冲突必须逐项再次选择。
 * 返回 { choices: [], priorChoices }。
 */
export function rebaseConflictChoices(oldChoices, newConflictKeys, at = Date.now()) {
  const keys = new Set(newConflictKeys || []);
  const prior = (oldChoices || [])
    .filter((c) => c && ['target', 'source', 'manual'].includes(c.resolution) && keys.has(c.key))
    .map((c) => ({
      key: c.key,
      resolution: c.resolution,
      ...(c.resolution === 'manual' && c.manual ? { manual: structuredClone(c.manual) } : {}),
      at, // 同时作为该键已确认选择的墓碑时间戳（跨页签合流时阻止旧选择复活）
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  return { choices: [], priorChoices: prior };
}

/** 草案确定性 id：同一对分支 head 的草案永远是同一个（幂等的关键）。 */
export function mergeDraftId(plan) {
  return `md_${hashStr(
    `${plan.targetBranchId}|${plan.sourceBranchId}|${plan.targetHeadId}|${plan.sourceHeadId}|${plan.baseEventId}`,
  )}`;
}

/** 草案当前结果指纹：相同选择 + 相同三方事件 -> 相同指纹（重复提交不产生重复事件）。 */
export function mergeResultFingerprint(plan, choicesMap) {  const { ok, model } = assembleMergeModel(plan, choicesMap, plan._models);
  if (!ok) return null;
  const fin = finalizeMergeModel(model);
  if (!fin.ok) return null;
  return fin.report.hash;
}

export function choicesToMap(choices) {
  const m = new Map();
  for (const c of choices || []) m.set(c.key, { resolution: c.resolution, manual: c.manual || null });
  return m;
}

/** 单个选择的时间戳（用于跨页签合流时判断同键新旧；旧数据无时间戳按 0 处理）。 */
const choiceAt = (c, fallback = 0) => (Number.isFinite(c?.at) ? c.at : fallback);
export function mapToChoices(map) {
  return [...map.entries()]
    .filter(([, v]) => v && ['target', 'source', 'manual'].includes(v.resolution))
    .map(([key, v]) => ({ key, resolution: v.resolution, ...(v.manual ? { manual: structuredClone(v.manual) } : {}) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** 简易确定性 32 位 FNV-1a（与项目其他报告一致的非加密指纹）。 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* ---------------- 草案跨页面合流 ---------------- */

const MERGE_DRAFT_RANK = { open: 0, abandoned: 1, superseded: 2, completed: 3 };

/**
 * 合并草案跨分支合流（与服务端 _merge_merge_drafts 同构）：
 * - 按 id 并集；同 id 走得更远的状态胜出（completed > superseded > abandoned > open）；
 * - open 草案 choices 按键并集（updatedAt 更新一方的同键选择优先）；
 * - priorChoices（更新 head 后仅供参考的旧选择）同样按键并集，
 *   但任何已在 choices 里被用户重新确认的键都要从参考列表剔除——参考选择绝不能覆盖已确认选择；
 * - completed 结果（mergeEventId / resultHash / report）不被 open 旧副本降级。
 */
export function mergeMergeDrafts(serverList, clientList) {
  const byId = new Map();
  const order = [];
  for (const d of [...(serverList || []), ...(clientList || [])]) {
    if (!d || typeof d.id !== 'string') continue;
    const ex = byId.get(d.id);
    if (!ex) { byId.set(d.id, d); order.push(d.id); continue; }
    const rs = MERGE_DRAFT_RANK[d.status] ?? 0, re = MERGE_DRAFT_RANK[ex.status] ?? 0;
    let win;
    if (rs !== re) win = rs > re ? d : ex;
    else win = (d.updatedAt || 0) >= (ex.updatedAt || 0) ? d : ex;
    const merged = { ...ex, ...win };
    if (ex.status === 'open' && d.status === 'open') {
      const newer = (d.updatedAt || 0) >= (ex.updatedAt || 0);
      const first = newer ? ex : d, second = newer ? d : ex;
      const fallbackAt = (dr) => dr.updatedAt || 0;
      // 同键选择按条目自身时间戳（缺省回退所属草案 updatedAt）取新。
      // 一页“更新 head”后，旧已确认选择移入 priorChoices（参考）并带 at：
      // 它同时充当该键已确认选择的【墓碑】——另一页迟到保存的旧 choices 不会把它复活。
      const resetAt = new Map(); // key -> 更新 head 重置为参考的时间戳
      const noteReset = (dr) => {
        for (const c of dr.priorChoices || []) {
          if (!c || typeof c.key !== 'string') continue;
          const at = choiceAt(c, fallbackAt(dr));
          if (at >= (resetAt.get(c.key) ?? Number.NEGATIVE_INFINITY)) resetAt.set(c.key, at);
        }
      };
      noteReset(first); noteReset(second);
      const chMap = new Map();
      const putChoice = (c, dr) => {
        if (!c || typeof c.key !== 'string') return;
        const at = choiceAt(c, fallbackAt(dr));
        if (at < (resetAt.get(c.key) ?? Number.NEGATIVE_INFINITY)) return; // 已被更新 head 重置
        const prev = chMap.get(c.key);
        if (!prev || at >= prev.at) chMap.set(c.key, { win: c, dr, at });
      };
      for (const c of first.choices || []) putChoice(c, first);
      for (const c of second.choices || []) putChoice(c, second);
      merged.choices = [...chMap.values()].map((x) => x.win).sort((a, b) => (a.key < b.key ? -1 : 1));
      // 仅供参考的旧选择同样按键取新并集，再剔除已被重新确认的键（参考绝不覆盖已确认选择）
      const prMap = new Map();
      const putPrior = (c, dr) => {
        if (!c || typeof c.key !== 'string') return;
        const at = choiceAt(c, fallbackAt(dr));
        const prev = prMap.get(c.key);
        if (!prev || at >= prev.at) prMap.set(c.key, { win: c, dr, at });
      };
      for (const c of first.priorChoices || []) putPrior(c, first);
      for (const c of second.priorChoices || []) putPrior(c, second);
      merged.priorChoices = [...prMap.values()].map((x) => x.win)
        .filter((c) => !chMap.has(c.key))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
      merged.refreshedAt = Math.max(first.refreshedAt || 0, second.refreshedAt || 0) || null;
      merged.status = 'open';
    }
    const done = ex.status === 'completed' ? ex : (d.status === 'completed' ? d : null);
    if (done) {
      merged.status = 'completed';
      merged.mergeEventId = done.mergeEventId;
      merged.resultHash = done.resultHash;
      merged.report = done.report || merged.report;
      merged.completedAt = done.completedAt;
      merged.targetHeadId = done.targetHeadId;
    }
    byId.set(d.id, merged);
  }
  return order.map((id) => byId.get(id));
}
