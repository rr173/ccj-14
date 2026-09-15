/*
 * 影响分析与安全变更（纯函数，无 DOM / 存储依赖）。
 *
 * 工作台的一次分析（impact snapshot）做两件事：
 *   1. 影响分析：用户选中一个矩形或约束后，沿约束依赖关系（有向边 follower→anchor，
 *      同时沿正向“跟随者”与反向“锚点被谁跟随”展开）找出直接 / 间接受影响的矩形、
 *      约束，以及每条传播分支的末端结果。
 *   2. 安全变更模拟：把一组候选变更（删除矩形 / 移动或改尺寸矩形 / 删除约束 / 修改约束参数）
 *      先作用于分析时基线模型的克隆，走与正常提交完全相同的管线（结构校验 → 环检测 →
 *      确定性求解 → 固化不动点），明确给出位置变化、冲突链、循环依赖与越界风险。
 *
 * 快照（impactSnapshots[]）随文档持久化：
 *   - 绑定分析时的文档版本（docRev）与分支 head（branchId / headEventId / baseHash）；
 *   - 正式应用前若分支 head 已前进 → 返回版本冲突（impact-branch-advanced），候选原样保留；
 *   - 确认应用在该分支一次性写入一条 kind='impact' 的审计事件；
 *   - 同一组候选重复提交：确定性候选 id + 结果指纹命中既有事件即幂等返回，绝不产生重复事件；
 *   - 应用失败（结构 / 悬空 / 环 / 越界阻断 / 版本冲突）不会留下任何部分修改。
 */

import { solve, findCycle } from './solver.js';
import { validate, normalize } from './model.js';
import { compareVersions } from './versions.js';
import { constraintLabel } from './solver.js';

/* ---------------- 确定性小工具 ---------------- */

/** 确定性 32 位 FNV-1a（与项目其他报告 / 指纹同一非加密算法，base36 输出）。 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

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

const byIdCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const num = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

/* ---------------- 依赖图 ---------------- */

/**
 * 构造约束依赖图（仅统计启用中的 snap / minGap 矩形间有向边）。
 * edges[]：{ from: followerId, to: anchorId, cid, axis }（同 follower/anchor 多条约束保留为多边）。
 * 出邻接 out：follower → anchors（“我跟随谁”）；入邻接 inc：anchor → followers（“谁跟随我”）。
 * 节点集合 = 模型中的全部矩形（即使没有任何约束边，选中它时它仍是自身影响面）。
 */
export function buildImpactGraph(model) {
  const rectIds = (model.rects || []).map((r) => r.id).sort(byIdCmp);
  const out = new Map(rectIds.map((id) => [id, []]));
  const inc = new Map(rectIds.map((id) => [id, []]));
  const edges = [];
  for (const c of (model.constraints || []).slice().sort((a, b) => byIdCmp(a.id, b.id))) {
    if (c.enabled === false) continue;
    if (c.kind !== 'snap' && c.kind !== 'minGap') continue;
    if (!out.has(c.rect) || !out.has(c.other)) continue;
    const axis = c.kind === 'snap' ? c.axis : (c.side === 'left' || c.side === 'right' ? 'x' : 'y');
    const edge = { from: c.rect, to: c.other, cid: c.id, axis };
    edges.push(edge);
    out.get(c.rect).push(edge);
    inc.get(c.other).push(edge);
  }
  for (const list of out.values()) list.sort((a, b) => byIdCmp(a.cid, b.cid));
  for (const list of inc.values()) list.sort((a, b) => byIdCmp(a.cid, b.cid));
  return { rectIds, edges, out, inc };
}

/* ---------------- 影响面展开 ---------------- */

/**
 * 沿约束关系展开受影响面。
 * @param model 规范化模型
 * @param seed { kind:'rect'|'constraint', id }
 * @returns 直接 / 间接受影响矩形、约束 + 每条传播分支（到求解后末端结果）。
 *
 * 直接矩形：
 *   - seed 是矩形：它自身（distance 0）+ 与它有任一启用约束相连的矩形（distance 1）；
 *   - seed 是约束：它的跟随矩形与锚点矩形（contain/lock 只有跟随矩形）。
 * 间接矩形：从直接矩形出发，再沿任一方向（跟随 / 被跟随）可到达的矩形（distance ≥ 2）。
 * 受影响约束：任一端点在受影响矩形集合中的启用 snap/minGap，以及作用于受影响矩形的
 *   contain / lock（含被停用的约束——它们可能在候选变更中被重新启用 / 修改参数）。
 */
export function analyzeImpact(model, seed, { simulation = null, baseReport = null } = {}) {
  const graph = buildImpactGraph(model);
  const rectName = new Map((model.rects || []).map((r) => [r.id, r.name || r.id]));

  const directRectIds = new Set();
  const indirectRectIds = new Set();
  let seedValid = false;

  if (seed?.kind === 'rect' && graph.out.has(seed.id)) {
    seedValid = true;
    directRectIds.add(seed.id); // 选中矩形本身（distance 0）
    for (const e of graph.out.get(seed.id)) directRectIds.add(e.to);
    for (const e of graph.inc.get(seed.id)) directRectIds.add(e.from);
  } else if (seed?.kind === 'constraint') {
    const c = (model.constraints || []).find((x) => x.id === seed.id);
    if (c) {
      seedValid = true;
      if (graph.out.has(c.rect)) directRectIds.add(c.rect);
      if ((c.kind === 'snap' || c.kind === 'minGap') && graph.out.has(c.other)) directRectIds.add(c.other);
    }
  }

  // 间接矩形：从直接矩形（不含 seed 自身那一层）双向 BFS，记录最短距离
  const distance = new Map();
  for (const id of directRectIds) distance.set(id, 1);
  if (seed?.kind === 'rect') distance.set(seed.id, 0);
  const queue = [...distance.entries()].sort((a, b) => (a[1] - b[1]) || byIdCmp(a[0], b[0])).map(([id]) => id);
  while (queue.length) {
    const id = queue.shift();
    const d = distance.get(id);
    const step = (other) => {
      if (!distance.has(other)) {
        distance.set(other, d + 1);
        queue.push(other);
      }
    };
    for (const e of graph.out.get(id) || []) step(e.to);
    for (const e of graph.inc.get(id) || []) step(e.from);
  }
  for (const [id, d] of distance) {
    if (directRectIds.has(id)) continue;
    if (d >= 2) indirectRectIds.add(id);
  }
  const affectedRectIds = new Set([...directRectIds, ...indirectRectIds]);

  // 受影响约束：端点落在受影响矩形集合中的 snap/minGap；rect 落在集合中的 contain/lock
  const directCids = new Set();
  const affectedCids = new Set();
  if (seed?.kind === 'constraint' && seed.id) directCids.add(seed.id);
  for (const c of model.constraints || []) {
    let touch = false;
    if (c.kind === 'snap' || c.kind === 'minGap') {
      touch = affectedRectIds.has(c.rect) || affectedRectIds.has(c.other);
      // 与种子矩形直接相连的约束也算“直接受影响约束”
      if (seed?.kind === 'rect' && (c.rect === seed.id || c.other === seed.id)) directCids.add(c.id);
    } else {
      touch = affectedRectIds.has(c.rect);
      if (seed?.kind === 'rect' && c.rect === seed.id) directCids.add(c.id);
    }
    if (touch) affectedCids.add(c.id);
  }

  const decorateRect = (id, relation) => {
    const basePos = model.rects.find((r) => r.id === id) || null;
    const simRect = simulation?.model?.rects?.find((r) => r.id === id) || null;
    const simPos = simulation?.report?.rects?.[id] || simRect || null;
    const deleted = simulation && !simRect;
    const moved = !deleted && !!simPos && !!basePos && (
      round3(simPos.x) !== round3(basePos.x) || round3(simPos.y) !== round3(basePos.y)
      || round3(simPos.w) !== round3(basePos.w) || round3(simPos.h) !== round3(basePos.h)
    );
    return {
      id,
      name: rectName.get(id) || id,
      distance: distance.get(id) ?? null,
      relation, // 'seed' | 'direct' | 'indirect'
      from: basePos ? { x: round3(basePos.x), y: round3(basePos.y), w: round3(basePos.w), h: round3(basePos.h) } : null,
      to: simPos ? { x: round3(simPos.x), y: round3(simPos.y), w: round3(simPos.w), h: round3(simPos.h) } : null,
      deleted,
      moved: !!moved,
      outOfBounds: !deleted ? !!(simulation?.boundsAfter || []).find((b) => b.id === id) : false,
    };
  };

  const seedRects = seed?.kind === 'rect' ? [seed.id].filter((id) => graph.out.has(id)) : [];
  const rects = [
    ...seedRects.map((id) => decorateRect(id, 'seed')),
    ...[...directRectIds].filter((id) => !seedRects.includes(id)).sort(byIdCmp).map((id) => decorateRect(id, 'direct')),
    ...[...indirectRectIds].sort(byIdCmp).map((id) => decorateRect(id, 'indirect')),
  ];

  const decorateConstraint = (cid) => {
    const c = (model.constraints || []).find((x) => x.id === cid);
    if (!c) return null;
    const before0 = baseReport?.constraints?.[cid] || simulation?.baselineStatus?.[cid] || null;
    const before = before0
      ? { satisfied: !!before0.satisfied, disabled: before0.disabled === true, measure: round3(before0.measure || 0) }
      : null;
    const after0 = simulation?.report?.constraints?.[cid] || null;
    const simC = simulation?.model?.constraints?.find((x) => x.id === cid) || null;
    const removed = !!simulation && !simC;
    const simConflict = (simulation?.report?.conflicts || []).find((x) => x.cid === cid) || null;
    return {
      id: cid,
      kind: c.kind,
      label: constraintLabel(c, rectName),
      relation: directCids.has(cid) ? 'direct' : 'indirect',
      enabled: c.enabled !== false,
      removed,
      before: before ? { satisfied: !!before.satisfied, disabled: !!before.disabled, measure: round3(before.measure || 0) } : null,
      after: after0 ? { satisfied: !!after0.satisfied, disabled: !!after0.disabled, measure: round3(after0.measure || 0) }
        : (removed ? null : { satisfied: false, disabled: false, measure: 0 }),
      conflict: simConflict ? {
        cid, measure: round3(simConflict.measure || 0), reason: simConflict.reason || '',
        chain: simConflict.chain || [], blockerIds: simConflict.blockerIds || [],
      } : null,
    };
  };
  const constraints = [...affectedCids].sort(byIdCmp).map(decorateConstraint).filter(Boolean);

  // 传播分支：从种子（选中矩形；约束种子取其跟随/锚点矩形）出发，沿约束图双向展开的
  // 最短路径树，每条根→叶路径即一条“分支结果”；求解后（若有模拟）记录节点的移动 / 冲突 / 越界。
  const branchRoots = seed?.kind === 'rect'
    ? new Set([seed.id].filter((id) => graph.out.has(id)))
    : new Set(directRectIds);
  const branches = buildPropagationBranches(graph, branchRoots, model, simulation);

  return freeze({
    seed: { kind: seed?.kind || null, id: seed?.id || null, valid: seedValid },
    rects,
    constraints,
    branches,
    counts: {
      rects: rects.length,
      rectsDirect: rects.filter((r) => r.relation !== 'indirect').length,
      rectsIndirect: indirectRectIds.size,
      rectsMoved: rects.filter((r) => r.moved).length,
      rectsDeleted: rects.filter((r) => r.deleted).length,
      constraints: constraints.length,
      constraintsDirect: directCids.size,
      branches: branches.length,
    },
  });
}

/**
 * 构造传播分支：以种子矩形为根，沿约束图【双向】（follower→anchor 与 anchor→follower）
 * 做确定性 BFS 最短路径树，再从每个叶节点回溯成路径。边带方向（forward=沿跟随方向 /
 * reverse=锚点被跟随），每个节点带求解后的位移 / 冲突 / 越界结果（分支结果）。
 */
function buildPropagationBranches(graph, roots, model, simulation) {
  const rectName = new Map((model.rects || []).map((r) => [r.id, r.name || r.id]));
  const rootSet = new Set(roots);
  // parent：最短路径树上每个节点的 {from, cid, axis, dir}（根为 null）。
  // 同距离确定性选边：先按对端 id、再按 cid。
  const parent = new Map();
  const dist = new Map();
  const ready = [];
  for (const id of [...rootSet].sort(byIdCmp)) { parent.set(id, null); dist.set(id, 0); ready.push(id); }
  while (ready.length) {
    ready.sort(byIdCmp);
    const id = ready.shift();
    const steps = [];
    for (const e of graph.out.get(id) || []) steps.push({ to: e.to, cid: e.cid, axis: e.axis, dir: 'forward' });
    for (const e of graph.inc.get(id) || []) steps.push({ to: e.from, cid: e.cid, axis: e.axis, dir: 'reverse' });
    steps.sort((a, b) => byIdCmp(a.to, b.to) || byIdCmp(a.cid, b.cid));
    for (const st of steps) {
      if (!dist.has(st.to)) {
        dist.set(st.to, dist.get(id) + 1);
        parent.set(st.to, { from: id, cid: st.cid, axis: st.axis, dir: st.dir });
        ready.push(st.to);
      }
    }
  }
  // 叶 = 树上没有子节点的节点
  const hasChild = new Set();
  for (const [, p] of parent) { if (p) hasChild.add(p.from); }
  const leaves = [...parent.keys()].filter((id) => !hasChild.has(id)).sort(byIdCmp);

  const nodeResult = (id) => {
    const base = model.rects.find((r) => r.id === id);
    const simRect = simulation?.model?.rects?.find((r) => r.id === id) || null;
    const pos = simulation?.report?.rects?.[id] || simRect || null;
    const deleted = !!simulation && !simRect;
    const cids = new Set();
    for (const e of graph.out.get(id) || []) cids.add(e.cid);
    for (const e of graph.inc.get(id) || []) cids.add(e.cid);
    const conf = (simulation?.report?.conflicts || []).filter((c) => cids.has(c.cid));
    const oob = (simulation?.boundsAfter || []).find((b) => b.id === id);
    return {
      id,
      name: rectName.get(id) || id,
      from: base ? { x: round3(base.x), y: round3(base.y) } : null,
      to: pos ? { x: round3(pos.x), y: round3(pos.y) } : null,
      moved: !deleted && !!pos && !!base && (round3(pos.x) !== round3(base.x) || round3(pos.y) !== round3(base.y)),
      deleted,
      conflictCids: conf.map((c) => c.cid).sort(byIdCmp),
      outOfBounds: !!oob,
    };
  };

  const branches = [];
  for (const leaf of leaves) {
    const path = [];
    let cur = leaf, guard = 0;
    while (cur && guard++ < 100000) {
      const p = parent.get(cur);
      path.push({ rectId: cur, via: p ? { cid: p.cid, axis: p.axis, dir: p.dir } : null });
      if (!p) break;
      cur = p.from;
    }
    path.reverse();
    if (path.length < 2 && rootSet.size > 1) continue; // 多根时跳过没有传播边的平凡分支
    const nodes = path.map((step, i) => ({ ...nodeResult(step.rectId), root: i === 0, leaf: i === path.length - 1, via: step.via }));
    const terminal = nodes[nodes.length - 1];
    branches.push({
      nodes,
      length: nodes.length,
      terminal: {
        rectId: terminal.id, name: terminal.name,
        moved: terminal.moved, deleted: terminal.deleted,
        conflictCids: terminal.conflictCids, outOfBounds: terminal.outOfBounds,
      },
      anyMoved: nodes.some((n) => n.moved),
      anyConflict: nodes.some((n) => n.conflictCids.length),
      anyOutOfBounds: nodes.some((n) => n.outOfBounds),
    });
  }
  // 确定性排序：首节点 id → 长度 → 末端 id
  branches.sort((a, b) => byIdCmp(a.nodes[0].rectId, b.nodes[0].rectId)
    || (a.length - b.length) || byIdCmp(a.terminal.rectId, b.terminal.rectId));
  return branches;
}

/* ---------------- 候选变更 ---------------- */

/** 规范化一个候选变更（非法返回 {error}）。id 缺省时由内容确定性派生（与传入顺序 / idx 无关）。 */
export function normalizeChange(raw, { idx = 0 } = {}) {
  void idx;
  if (!raw || typeof raw !== 'object') return { error: '候选变更不是对象' };
  const kind = raw.kind;
  const withId = (value) => ({
    value: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : `chg_${hashStr(canonicalChange(value))}`,
      ...value,
    },
  });
  if (kind === 'delete-rect') {
    if (typeof raw.rectId !== 'string') return { error: '删除矩形缺少 rectId' };
    return withId({ kind, rectId: raw.rectId });
  }
  if (kind === 'move-rect') {
    if (typeof raw.rectId !== 'string') return { error: '移动矩形缺少 rectId' };
    const value = { kind, rectId: raw.rectId };
    for (const f of ['x', 'y', 'w', 'h']) {
      if (raw[f] !== undefined && raw[f] !== null && raw[f] !== '') value[f] = round3(num(raw[f], NaN));
    }
    if (['w', 'h'].some((f) => f in value && !(value[f] > 0))) return { error: '宽高必须为正数' };
    return withId(value);
  }
  if (kind === 'delete-constraint') {
    if (typeof raw.constraintId !== 'string') return { error: '删除约束缺少 constraintId' };
    return withId({ kind, constraintId: raw.constraintId });
  }
  if (kind === 'modify-constraint') {
    if (typeof raw.constraintId !== 'string') return { error: '修改约束缺少 constraintId' };
    if (!raw.params || typeof raw.params !== 'object') return { error: '修改约束缺少 params' };
    const params = {};
    for (const [k, v] of Object.entries(raw.params)) {
      if (v === undefined || v === null || v === '') continue;
      params[k] = v;
    }
    const enabledSet = raw.enabled === true || raw.enabled === false;
    if (!Object.keys(params).length && !enabledSet) return { error: '修改约束没有任何新参数' };
    const value = { kind, constraintId: raw.constraintId, params };
    if (enabledSet) value.enabled = raw.enabled;
    return withId(value);
  }
  return { error: `未知候选变更类型：${kind}` };
}

function canonicalChange(c) {
  // 去掉客户端 id 后的规范化内容（用于确定性派生候选 id）
  const clean = { kind: c.kind };
  for (const k of ['rectId', 'constraintId', 'x', 'y', 'w', 'h']) {
    if (c[k] !== undefined) clean[k] = typeof c[k] === 'number' ? round3(c[k]) : c[k];
  }
  if (c.params && typeof c.params === 'object') {
    const params = {};
    for (const [k, v] of Object.entries(c.params).sort((a, b) => byIdCmp(a[0], b[0]))) {
      params[k] = typeof v === 'number' ? round3(v) : v;
    }
    clean.params = params;
  }
  if (c.enabled === true || c.enabled === false) clean.enabled = c.enabled;
  return JSON.stringify(clean);
}

/* ---------------- 模拟 ---------------- */

/**
 * 把候选变更作用于模型克隆。删除矩形时级联删除端点引用它的约束（与编辑器“删除所选”同语义），
 * 返回 { model, removedConstraintIds, errors }。移动 / 修改 / 删除的目标不存在时给出错误
 * （调用方据此阻断模拟，绝不静默丢弃候选）。
 */
export function applyChanges(baseModel, changes) {
  const model = structuredClone(baseModel);
  const removedConstraintIds = [];
  const deletedRects = new Set();
  const errors = [];

  for (const ch of changes) {
    if (ch.kind === 'delete-rect') {
      if (!model.rects.some((r) => r.id === ch.rectId)) {
        errors.push({ code: 'missing-target', message: `候选要删除的矩形 ${ch.rectId} 不存在（可能已被其他变更删除）` });
        continue;
      }
      model.rects = model.rects.filter((r) => r.id !== ch.rectId);
      deletedRects.add(ch.rectId);
      const doomed = model.constraints.filter((c) => c.rect === ch.rectId || c.other === ch.rectId);
      for (const c of doomed) { removedConstraintIds.push(c.id); }
      model.constraints = model.constraints.filter((c) => c.rect !== ch.rectId && c.other !== ch.rectId);
    } else if (ch.kind === 'move-rect') {
      const r = model.rects.find((x) => x.id === ch.rectId);
      if (!r) { errors.push({ code: 'missing-target', message: `候选要移动的矩形 ${ch.rectId} 不存在` }); continue; }
      for (const f of ['x', 'y', 'w', 'h']) if (f in ch) r[f] = ch[f];
    } else if (ch.kind === 'delete-constraint') {
      const i = model.constraints.findIndex((x) => x.id === ch.constraintId);
      if (i < 0) { errors.push({ code: 'missing-target', message: `候选要删除的约束 ${ch.constraintId} 不存在` }); continue; }
      model.constraints.splice(i, 1); removedConstraintIds.push(ch.constraintId);
    } else if (ch.kind === 'modify-constraint') {
      const c = model.constraints.find((x) => x.id === ch.constraintId);
      if (!c) { errors.push({ code: 'missing-target', message: `候选要修改的约束 ${ch.constraintId} 不存在` }); continue; }
      Object.assign(c, structuredClone(ch.params || {}));
      if (ch.enabled === true || ch.enabled === false) c.enabled = ch.enabled;
    }
  }
  return { model, removedConstraintIds: [...new Set(removedConstraintIds)].sort(byIdCmp), deletedRects: [...deletedRects].sort(byIdCmp), errors };
}

function rawBoundsErrors(model) {
  const errors = [];
  const cw = model.canvas?.w, chh = model.canvas?.h;
  if (!Number.isFinite(cw) || !Number.isFinite(chh)) return errors;
  for (const r of model.rects || []) {
    if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) || !(r.w > 0) || !(r.h > 0)) continue;
    if (r.x < -1e-6 || r.y < -1e-6 || r.x + r.w > cw + 1e-6 || r.y + r.h > chh + 1e-6) {
      errors.push({ id: r.id, name: r.name || r.id, code: 'out-of-bounds', rect: { x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h) } });
    }
  }
  return errors;
}

/**
 * 模拟一组候选变更（不写任何审计事件）。与正常提交同一管线：
 * 结构校验 → 环检测 → 规范化 → 确定性求解 → 固化不动点 → 固化后越界复查。
 * 即使存在环 / 结构错误，也尽量返回求解结果用于预览；阻断项集中在 errors / cycle。
 *
 * @returns {
 *   ok, errors:[{code,message,detail?}], cycle,
 *   model, report, boundsBefore, boundsAfter, removedConstraintIds, deletedRects,
 *   diff, changeIds, resultHash, baselineStatus, baselineReport, baseHash
 * }
 */
export function simulateChanges(baseModel, baseReport, rawChanges) {
  const changes = [];
  const changeErrors = [];
  rawChanges.forEach((raw, i) => {
    const norm = normalizeChange(raw, { idx: i });
    if (norm.error) changeErrors.push({ code: 'bad-change', message: `第 ${i + 1} 项候选变更非法：${norm.error}` });
    else changes.push(norm.value);
  });
  changes.sort((a, b) => byIdCmp(a.id, b.id));

  const applied = applyChanges(baseModel, changes);
  const draftModel = applied.model;

  const errors = [];
  for (const e of changeErrors) errors.push(e);
  for (const e of applied.errors || []) errors.push(e);

  // 1) 结构校验（悬空引用 / 非法几何 / 未知类型）
  const { errors: structural } = validate(draftModel);
  for (const message of structural) errors.push({ code: 'invalid-model', message });

  // 2) 求解前越界（移动 / 改尺寸直接给出的越界风险）
  const boundsBefore = rawBoundsErrors(draftModel);

  // 3) 环检测（候选变更可能新引入一条 follower→anchor 边而成环）
  let cycle = null;
  try { cycle = findCycle(draftModel.constraints || []); } catch (e) {
    errors.push({ code: 'cycle-error', message: `环检测失败：${e.message}` });
  }
  if (cycle) {
    errors.push({
      code: 'cycle',
      message: `候选变更会形成循环依赖：${cycle.nodeIds.join(' → ')}（闭环约束 ${cycle.cids.join('、')}）`,
      detail: { nodeIds: cycle.nodeIds, cids: cycle.cids },
    });
  }

  // 4) 规范化 + 确定性求解（即使有环也尝试求解，用于预览位置 / 冲突链；求解器对环有防御性拓扑兜底）
  let model = null, report = null;
  try {
    model = normalize(draftModel);
    report = solve(model, null);
    for (const r of model.rects) {
      const p = report.rects[r.id];
      if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
    }
  } catch (e) {
    errors.push({ code: 'solve-error', message: `模拟求解失败：${e.message}` });
  }

  // 5) 固化后越界复查
  let boundsAfter = [];
  if (model) boundsAfter = rawBoundsErrors(model);
  for (const b of boundsAfter) {
    errors.push({ code: 'out-of-bounds', message: `矩形「${b.name}」模拟求解后超出画布边界`, detail: { id: b.id, rect: b.rect } });
  }

  const baselineStatus = {};
  for (const c of baseModel.constraints || []) {
    baselineStatus[c.id] = baseReport?.constraints?.[c.id] || { satisfied: false, disabled: c.enabled === false, measure: 0 };
  }

  const diff = (model && report && baseReport)
    ? compareVersions(
      { model: normalize(baseModel), report: baseReport, hash: baseReport.hash || '' },
      { model, report, hash: report.hash },
    )
    : null;

  const resultHash = report?.hash || null;
  return freeze({
    ok: errors.length === 0,
    errors,
    cycle,
    model,
    report,
    boundsBefore: freeze(boundsBefore),
    boundsAfter: freeze(boundsAfter),
    removedConstraintIds: applied.removedConstraintIds,
    deletedRects: applied.deletedRects,
    changes,
    changeIds: changes.map((c) => c.id),
    resultHash,
    diff,
    baselineStatus,
    baseHash: baseReport?.hash || null,
  });
}

/* ---------------- 分析快照 ---------------- */

/**
 * 构造一个分析快照（深冻结）。
 * @param entry { id, name, seed, branchId, branchName, headEventId, docRev,
 *                baseModel, baseReport, baseHash, changes, simulation, analysis, actor, createdAt }
 */
export function makeImpactSnapshot(entry) {
  return freeze({
    id: entry.id,
    name: String(entry.name || '影响分析'),
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : (Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now()),
    actor: String(entry.actor || ''),
    status: 'open', // open | applied | abandoned
    seed: structuredClone(entry.seed),
    branchId: entry.branchId,
    branchName: entry.branchName || '',
    headEventId: entry.headEventId,
    docRev: Number.isFinite(entry.docRev) ? entry.docRev : 0,
    baseHash: entry.baseHash,
    // 分析时的完整基线（深拷贝）：刷新 / 重启 / 分支继续前进后，分析仍基于同一文档版本可查看、可模拟
    baseModel: structuredClone(entry.baseModel),
    baseReport: structuredClone(entry.baseReport),
    changes: structuredClone(entry.changes || []),
    simulation: entry.simulation ? freezeSim(entry.simulation) : null,
    impact: structuredClone(entry.analysis || null),
    conflict: null,        // 应用时分支已前进 -> { reason, headEventId, headSeq, at }
    appliedAt: null,
    appliedEventId: null,
    resultHash: null,
    report: null,          // 应用后回填完整影响报告
  });
}

/** 模拟结果入库形态：裁剪瞬态字段（baselineStatus 等可由基线重算的大对象不持久化，查看时重建）。 */
function freezeSim(sim) {
  return freeze({
    ok: !!sim.ok,
    errors: structuredClone(sim.errors || []),
    cycle: sim.cycle ? structuredClone(sim.cycle) : null,
    model: structuredClone(sim.model),
    report: structuredClone(sim.report),
    boundsBefore: structuredClone(sim.boundsBefore || []),
    boundsAfter: structuredClone(sim.boundsAfter || []),
    removedConstraintIds: [...(sim.removedConstraintIds || [])],
    deletedRects: [...(sim.deletedRects || [])],
    changeIds: [...(sim.changeIds || [])],
    resultHash: sim.resultHash || null,
  });
}

/** 快照确定性 id：同分支 head + 同种子 + 同候选内容 => 同一快照（重复打开不产生副本）。 */
export function impactSnapshotId({ branchId, headEventId, seed, changes }) {
  const canon = JSON.stringify({
    branchId, headEventId,
    seed: { kind: seed?.kind, id: seed?.id },
    changes: (changes || []).map((c, i) => canonicalChange(normalizeChange(c, { idx: i }).value || c)).sort(),
  });
  return `ia_${hashStr(canon)}`;
}

/** 候选变更集合的内容指纹（不含客户端 id；用于重复提交幂等）。 */
export function changesFingerprint(changes) {
  const canon = JSON.stringify((changes || []).map((c, i) => canonicalChange(normalizeChange(c, { idx: i }).value || c)).sort());
  return hashStr(canon);
}

/* ---------------- 影响报告 ---------------- */

/**
 * 构造影响报告（分析快照 + 模拟结果 + 应用信息）。
 * 键名递归排序，附 FNV 校验和，刷新 / 重启 / 导出逐字节一致。
 */
export function buildImpactReport(snapshot, { generatedAt = Date.now(), event = null } = {}) {
  const sim = snapshot.simulation;
  const impact = snapshot.impact;
  const diff = sim?.report && snapshot.baseReport
    ? compareVersions(
      { model: snapshot.baseModel, report: snapshot.baseReport, hash: snapshot.baseHash },
      { model: sim.model, report: sim.report, hash: sim.report.hash },
    )
    : null;
  const report = {
    kind: 'impact-analysis-report',
    schema: 1,
    generatedAt,
    snapshot: {
      id: snapshot.id,
      name: snapshot.name,
      createdAt: snapshot.createdAt,
      actor: snapshot.actor,
      status: snapshot.status,
      seed: snapshot.seed,
      branch: { id: snapshot.branchId, name: snapshot.branchName, headEventId: snapshot.headEventId },
      docRev: snapshot.docRev,
      baseHash: snapshot.baseHash,
    },
    candidates: (snapshot.changes || []).map((c, i) => ({
      id: normalizeChange(c, { idx: i }).value?.id || `#${i}`,
      kind: c.kind,
      rectId: c.rectId || null,
      constraintId: c.constraintId || null,
      params: c.params || null,
      to: pick(c, ['x', 'y', 'w', 'h']),
      enabled: c.enabled === undefined ? null : c.enabled,
    })),
    impact: impact ? {
      counts: impact.counts,
      rects: impact.rects.map((r) => ({
        id: r.id, name: r.name, relation: r.relation, distance: r.distance,
        from: r.from, to: r.to, moved: r.moved, deleted: r.deleted, outOfBounds: r.outOfBounds,
      })),
      constraints: impact.constraints.map((c) => ({
        id: c.id, kind: c.kind, label: c.label, relation: c.relation,
        enabled: c.enabled, removed: c.removed, before: c.before, after: c.after, conflict: c.conflict,
      })),
      branches: (impact.branches || []).map((b) => ({
        length: b.length, anyMoved: b.anyMoved, anyConflict: b.anyConflict, anyOutOfBounds: b.anyOutOfBounds,
        terminal: b.terminal,
        nodes: b.nodes.map((n) => ({
          rectId: n.rectId, name: n.name, from: n.from, to: n.to,
          moved: n.moved, deleted: n.deleted, conflictCids: n.conflictCids, outOfBounds: n.outOfBounds,
          via: n.via,
        })),
      })),
    } : null,
    simulation: sim ? {
      ok: sim.ok,
      errors: sim.errors,
      cycle: sim.cycle ? { nodeIds: sim.cycle.nodeIds, cids: sim.cycle.cids } : null,
      resultHash: sim.resultHash,
      removedConstraintIds: sim.removedConstraintIds,
      deletedRects: sim.deletedRects,
      boundsAfter: sim.boundsAfter,
      conflicts: (sim.report?.conflicts || []).map((c) => ({
        cid: c.cid, label: c.label, kind: c.kind, priority: c.priority,
        measure: c.measure, reason: c.reason, chain: c.chain, blockerIds: c.blockerIds,
      })),
      hashBefore: snapshot.baseHash,
      hashAfter: sim.report?.hash || null,
      diff,
    } : null,
    application: snapshot.status === 'applied' ? {
      at: snapshot.appliedAt || event?.t || null,
      eventId: snapshot.appliedEventId || event?.id || null,
      eventSeq: event?.seq ?? null,
      actor: event?.actor || snapshot.actor || '',
      resultHash: snapshot.resultHash || sim?.resultHash || null,
    } : null,
    conflict: snapshot.conflict || null,
  };
  report.checksum = hashStr(stableStringify(report));
  return freeze(report);
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o?.[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : null;
}

/** 递归排序键名的稳定 JSON（与服务端 sort_keys / 其他报告逐字节一致）。 */
export function stableStringify(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = v[key];
      return out;
    }
    return v;
  });
}

/* ---------------- 加载清洗 / 跨页合流 ---------------- */

const SNAPSHOT_STATUSES = new Set(['open', 'applied', 'abandoned']);

/**
 * 清洗持久化的分析快照（确定性、幂等、不重算几何）：
 * - 丢弃结构不完整 / 重复 id（保留第一条）的快照；
 * - 候选变更逐项规范化，非法项剔除；
 * - status 非法回退 open；applied 必须带 appliedEventId，否则回退 open（事件可能尚未合流）；
 * - simulation 缺少模型 / 报告时置空（查看时可由当前候选重算）。
 */
export function sanitizeImpactSnapshots(list, warnings = []) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const sRaw of list) {
    if (!sRaw || typeof sRaw !== 'object' || typeof sRaw.id !== 'string') continue;
    if (seen.has(sRaw.id)) { warnings.push({ level: 'warn', text: `影响分析快照 ${sRaw.id} 重复，仅保留第一条` }); continue; }
    let malformed = false;
    for (const k of ['branchId', 'headEventId']) {
      if (typeof sRaw[k] !== 'string') { malformed = true; break; }
    }
    if (malformed) continue;
    const s0 = sRaw;
    if (!s0.baseModel || !Array.isArray(s0.baseModel.rects) || !Array.isArray(s0.baseModel.constraints)) continue;
    seen.add(s0.id);

    let status = SNAPSHOT_STATUSES.has(s0.status) ? s0.status : 'open';
    if (status === 'applied' && typeof s0.appliedEventId !== 'string') status = 'open';

    const changes = [];
    (Array.isArray(s0.changes) ? s0.changes : []).forEach((c, i) => {
      const norm = normalizeChange(c, { idx: i });
      if (!norm.error) changes.push(norm.value);
    });
    changes.sort((a, b) => byIdCmp(a.id, b.id));

    const sim = (s0.simulation && s0.simulation.model && s0.simulation.report) ? {
      ok: s0.simulation.ok !== false,
      errors: Array.isArray(s0.simulation.errors) ? s0.simulation.errors : [],
      cycle: s0.simulation.cycle && typeof s0.simulation.cycle === 'object' ? s0.simulation.cycle : null,
      model: s0.simulation.model,
      report: s0.simulation.report,
      boundsBefore: Array.isArray(s0.simulation.boundsBefore) ? s0.simulation.boundsBefore : [],
      boundsAfter: Array.isArray(s0.simulation.boundsAfter) ? s0.simulation.boundsAfter : [],
      removedConstraintIds: Array.isArray(s0.simulation.removedConstraintIds) ? s0.simulation.removedConstraintIds : [],
      deletedRects: Array.isArray(s0.simulation.deletedRects) ? s0.simulation.deletedRects : [],
      changeIds: Array.isArray(s0.simulation.changeIds) ? s0.simulation.changeIds : changes.map((c) => c.id),
      resultHash: typeof s0.simulation.resultHash === 'string' ? s0.simulation.resultHash : null,
    } : null;

    out.push(freeze({
      id: s0.id,
      name: typeof s0.name === 'string' ? s0.name : '影响分析',
      createdAt: Number.isFinite(s0.createdAt) ? s0.createdAt : 0,
      updatedAt: Number.isFinite(s0.updatedAt) ? s0.updatedAt : (Number.isFinite(s0.createdAt) ? s0.createdAt : 0),
      actor: typeof s0.actor === 'string' ? s0.actor : '',
      status,
      seed: s0.seed && typeof s0.seed === 'object' ? { kind: s0.seed.kind || null, id: s0.seed.id || null } : { kind: null, id: null },
      branchId: s0.branchId,
      branchName: typeof s0.branchName === 'string' ? s0.branchName : '',
      headEventId: s0.headEventId,
      docRev: Number.isFinite(s0.docRev) ? s0.docRev : 0,
      baseHash: typeof s0.baseHash === 'string' ? s0.baseHash : '',
      baseModel: s0.baseModel,
      baseReport: s0.baseReport && typeof s0.baseReport === 'object' ? s0.baseReport : null,
      changes,
      simulation: sim ? freeze(sim) : null,
      impact: s0.impact && typeof s0.impact === 'object' ? s0.impact : null,
      conflict: s0.conflict && typeof s0.conflict === 'object' ? s0.conflict : null,
      appliedAt: Number.isFinite(s0.appliedAt) ? s0.appliedAt : null,
      appliedEventId: typeof s0.appliedEventId === 'string' ? s0.appliedEventId : null,
      resultHash: typeof s0.resultHash === 'string' ? s0.resultHash : null,
      report: s0.report && typeof s0.report === 'object' ? s0.report : null,
    }));
  }
  return out;
}

const SNAPSHOT_RANK = { open: 0, abandoned: 1, applied: 2 };

/**
 * 分析快照跨页面 / 跨分支合流（与服务端 _merge_impact_snapshots 同构）：
 * - 按 id 并集；同 id 走得更远的状态胜出（applied > abandoned > open）；
 * - open 同状态：updatedAt 更新者整体胜出（候选集合以最近一次编辑为准，不做逐候选合并，
 *   因为候选是一组要整体模拟 / 应用的变更）；
 * - applied 结果（appliedEventId / resultHash / report）不被旧副本降级。
 */
export function mergeImpactSnapshots(serverList, clientList) {
  const byId = new Map();
  const order = [];
  for (const s of [...(serverList || []), ...(clientList || [])]) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
    const ex = byId.get(s.id);
    if (!ex) { byId.set(s.id, s); order.push(s.id); continue; }
    const rs = SNAPSHOT_RANK[s.status] ?? 0, re = SNAPSHOT_RANK[ex.status] ?? 0;
    let win;
    if (rs !== re) win = rs > re ? s : ex;
    else win = (s.updatedAt || 0) >= (ex.updatedAt || 0) ? s : ex;
    const merged = { ...ex, ...win };
    const done = ex.status === 'applied' ? ex : (s.status === 'applied' ? s : null);
    if (done) {
      merged.status = 'applied';
      merged.appliedEventId = done.appliedEventId;
      merged.resultHash = done.resultHash;
      merged.report = done.report || merged.report;
      merged.appliedAt = done.appliedAt;
      merged.conflict = null;
    }
    byId.set(s.id, merged);
  }
  return order.map((id) => byId.get(id));
}
