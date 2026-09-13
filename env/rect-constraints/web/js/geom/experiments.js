/*
 * 布局方案实验：纯函数模块（无 DOM / 存储依赖），运行器在 Store 中。
 *
 * 实验 experiment（从编辑分支的某一审计事件派生，事件本身绝不被改写）：
 *   {
 *     id, name, createdAt, updatedAt, actor,
 *     source: { branchId, eventId, seq, hash },   // 实验来源（当前编辑分支时刻）
 *     baseModel, baseReport, baseHash,            // 基准完整快照（自包含，基准事件日后损坏仍可比）
 *     variants: [                                 // 顺序固定，结果顺序即此顺序
 *       {
 *         id, name, order,
 *         changes: { rects:[{id,x?,y?,w?,h?}], constraints:[{id,enabled?,priority?}] },
 *         status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
 *         error, attempts,
 *         result: null | { model, report, hash, conflicts, completedAt, durationMs } // 完成后冻结、不可覆盖
 *         corrupt?, corruptReason?                // 完成结果在加载时指纹校验失败
 *       }
 *     ],
 *     configHash,     // 来源事件 + 有序参数变体的规范化指纹：相同配置重复提交幂等
 *     runState: 'queued' | 'running' | 'paused' | 'done' | 'cancelled',
 *     baseCorrupt?    // 基准快照指纹校验失败（变体结果仍可查看 / 另存分支）
 *   }
 *
 * 失败隔离：单个变体结构非法 / 成环 / 求解抛错只标记该变体 failed，不影响其余变体。
 */

import { validate, normalize, uid } from './model.js';
import { solve, findCycle } from './solver.js';
import { compareVersions } from './versions.js';

export const RUN_STATES = ['queued', 'running', 'paused', 'done', 'cancelled'];
const VARIANT_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'cancelled']);
const STATUS_RANK = { queued: 0, running: 1, cancelled: 2, failed: 3, done: 4 };

const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

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

/** FNV-1a 32bit（与 solver.fingerprint 同算法，独立实现避免模块环依赖）。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ---------------- 变体定义 ---------------- */

const RECT_KEYS = ['x', 'y', 'w', 'h'];

/** 规范化一组用户提交的变体草稿；非法定义抛 Error（创建实验时拦住）。 */
export function prepareSpecs(rawSpecs, baseModel) {
  if (!Array.isArray(rawSpecs)) throw new Error('变体定义缺失');
  if (rawSpecs.length === 0) throw new Error('至少定义一个参数变体');
  if (rawSpecs.length > 50) throw new Error('一次实验最多 50 个变体');
  const rectIds = new Set((baseModel.rects || []).map((r) => r.id));
  const consIds = new Set((baseModel.constraints || []).map((c) => c.id));
  const specs = [];
  rawSpecs.forEach((raw, i) => {
    const name = String(raw?.name || '').trim() || `变体 ${i + 1}`;
    const rectsMap = new Map();
    for (const item of Array.isArray(raw?.rects) ? raw.rects : []) {
      if (!item || typeof item.id !== 'string' || !rectIds.has(item.id)) throw new Error(`变体「${name}」引用了不存在的矩形`);
      const cur = rectsMap.get(item.id) || { id: item.id };
      for (const k of RECT_KEYS) {
        if (item[k] !== undefined && item[k] !== null && item[k] !== '') {
          const n = Number(item[k]);
          if (!Number.isFinite(n)) throw new Error(`变体「${name}」的矩形参数 ${k} 不是数字`);
          if ((k === 'w' || k === 'h') && n <= 0) throw new Error(`变体「${name}」的矩形宽高必须为正`);
          cur[k] = round3(n);
        }
      }
      rectsMap.set(item.id, cur);
    }
    const consMap = new Map();
    for (const item of Array.isArray(raw?.constraints) ? raw.constraints : []) {
      if (!item || typeof item.id !== 'string' || !consIds.has(item.id)) throw new Error(`变体「${name}」引用了不存在的约束`);
      const cur = consMap.get(item.id) || { id: item.id };
      if (typeof item.enabled === 'boolean') cur.enabled = item.enabled;
      if (item.priority !== undefined && item.priority !== null && item.priority !== '') {
        const n = Number(item.priority);
        if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`变体「${name}」的优先级必须是 1–999 的整数`);
        cur.priority = n;
      }
      consMap.set(item.id, cur);
    }
    const rects = [...rectsMap.values()].filter((r) => RECT_KEYS.some((k) => r[k] !== undefined))
      .map((r) => { const o = { id: r.id }; for (const k of RECT_KEYS) if (r[k] !== undefined) o[k] = r[k]; return o; })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const constraints = [...consMap.values()]
      .filter((c) => typeof c.enabled === 'boolean' || Number.isInteger(c.priority))
      .map((c) => ({ id: c.id, ...(typeof c.enabled === 'boolean' ? { enabled: c.enabled } : {}), ...(Number.isInteger(c.priority) ? { priority: c.priority } : {}) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    specs.push({ name, rects, constraints });
  });
  return specs;
}

/** 规范化持久化出来的 changes（容忍旧/坏字段：未知 id 与非法字段丢弃）。 */
function sanitizeChanges(changes, baseModel) {
  const rectIds = new Set((baseModel?.rects || []).map((r) => r.id));
  const consIds = new Set((baseModel?.constraints || []).map((c) => c.id));
  const rects = [];
  for (const ch of Array.isArray(changes?.rects) ? changes.rects : []) {
    if (!ch || typeof ch.id !== 'string' || !rectIds.has(ch.id)) continue;
    const o = { id: ch.id };
    for (const k of RECT_KEYS) {
      if (typeof ch[k] === 'number' && Number.isFinite(ch[k])) o[k] = round3(ch[k]);
    }
    if (RECT_KEYS.some((k) => o[k] !== undefined)) rects.push(o);
  }
  rects.sort((a, b) => (a.id < b.id ? -1 : 1));
  const constraints = [];
  for (const ch of Array.isArray(changes?.constraints) ? changes.constraints : []) {
    if (!ch || typeof ch.id !== 'string' || !consIds.has(ch.id)) continue;
    const o = { id: ch.id };
    if (typeof ch.enabled === 'boolean') o.enabled = ch.enabled;
    if (Number.isInteger(ch.priority) && ch.priority >= 1 && ch.priority <= 999) o.priority = ch.priority;
    if (typeof o.enabled === 'boolean' || Number.isInteger(o.priority)) constraints.push(o);
  }
  constraints.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { rects, constraints };
}

/**
 * 实验配置指纹：来源事件 id + 有序的参数变体定义（名称只是标签，不参与）。
 * 同样的配置（哪怕换了实验/变体显示名）永远得到同一 hash —— 重复提交据此幂等。
 */
export function experimentConfigHash(sourceEventId, specs) {
  const canon = JSON.stringify({
    s: sourceEventId,
    v: (specs || []).map((sp) => ({
      r: (sp.rects || []).map((r) => [r.id, RECT_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, round3(r[k])])]),
      c: (sp.constraints || []).map((c) => [c.id, c.enabled === false ? 0 : 1, Number.isInteger(c.priority) ? c.priority : null]),
    })),
  });
  return hash32(canon);
}

/* ---------------- 构造实验 ---------------- */

/**
 * 从分支事件（当前编辑分支 head 或回放中的历史事件）建立实验。
 * 基准完整快照自包含克隆；变体全部 queued；runState='queued'。
 */
export function makeExperiment({ id = uid('x'), name, actor = '未署名', event, specs, t = Date.now() }) {
  if (!event || !event.model || !event.report) throw new Error('来源事件不可用，无法建立实验');
  const baseModel = normalize(structuredClone(event.model));
  const baseReport = structuredClone(event.report);
  const prepared = specs && specs.length ? specs : [];
  const variants = prepared.map((spec, i) => ({
    id: uid('xv'),
    name: spec.name || `变体 ${i + 1}`,
    order: i,
    changes: sanitizeChanges(spec, baseModel),
    status: 'queued',
    error: null,
    result: null,
    attempts: 0,
  }));
  return {
    id,
    name: String(name || '未命名实验'),
    createdAt: t,
    updatedAt: t,
    actor: String(actor || '未署名'),
    source: { branchId: event.branch, eventId: event.id, seq: event.seq ?? null, hash: event.hash },
    baseModel,
    baseReport,
    baseHash: baseReport.hash,
    variants,
    configHash: experimentConfigHash(event.id, prepared),
    runState: 'queued',
  };
}

/* ---------------- 变体求解（失败隔离） ---------------- */

/** 把参数变体应用到基准模型的克隆上（不改基准，不改变体定义）。 */
export function applyVariant(baseModel, changes) {
  const m = structuredClone(baseModel);
  const rectById = new Map(m.rects.map((r) => [r.id, r]));
  for (const ch of changes?.rects || []) {
    const r = rectById.get(ch.id);
    if (!r) continue;
    for (const k of RECT_KEYS) if (typeof ch[k] === 'number' && Number.isFinite(ch[k])) r[k] = ch[k];
  }
  const consById = new Map(m.constraints.map((c) => [c.id, c]));
  for (const ch of changes?.constraints || []) {
    const c = consById.get(ch.id);
    if (!c) continue;
    if (typeof ch.enabled === 'boolean') c.enabled = ch.enabled;
    if (Number.isInteger(ch.priority)) c.priority = ch.priority;
  }
  return m;
}

/**
 * 执行单个变体：应用参数 → 结构校验 → 环检测 → 确定性求解（固化不动点后二次求解）。
 * 任何失败只返回 {ok:false,error}，由运行器标记该变体，绝不抛出阻塞其他变体。
 * 注意：启用基准中被停用的约束可能成环 —— 环属于该变体自身的失败。
 */
export function executeVariant(exp, variant) {
  let draft;
  try {
    draft = applyVariant(exp.baseModel, variant.changes);
  } catch (e) {
    return { ok: false, error: `参数应用失败：${e.message}` };
  }
  const { errors } = validate(draft);
  if (errors.length) return { ok: false, error: errors[0] };
  const cycle = findCycle(draft.constraints);
  if (cycle) {
    const nameOf = (rid) => draft.rects.find((r) => r.id === rid)?.name || rid;
    return { ok: false, error: `检测到循环依赖（${cycle.nodeIds.map(nameOf).join(' → ')}），该变体未求解` };
  }
  const norm = normalize(draft);
  const rep1 = solve(norm, null);
  // 与 Store.commit 一致：把不动点位置固化进模型，再求一次确认幂等不动点
  for (const r of norm.rects) {
    const p = rep1.rects[r.id];
    if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
  }
  const model = normalize(norm);
  const report = solve(model, null);
  return { ok: true, model, report };
}

/** 变体完成结果：完整模型 + 求解结果 + 冲突链 + 指纹；深冻结，之后不可覆盖。 */
export function makeVariantResult({ model, report }, { startedAt = Date.now(), completedAt = Date.now() } = {}) {
  return freeze({
    model: structuredClone(model),
    report: structuredClone(report),
    hash: report.hash,
    conflicts: structuredClone(report.conflicts),
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
  });
}

export function variantReplayable(v) {
  return !!v && v.status === 'done' && !v.corrupt && !!v.result && !!v.result.model && !!v.result.report;
}

export function baselineEntry(exp) {
  return { model: exp.baseModel, report: exp.baseReport, hash: exp.baseHash };
}
export function variantEntry(v) {
  return { model: v.result.model, report: v.result.report, hash: v.result.hash };
}

/** 完成变体相对基准的矩形 / 约束 / 冲突差异（基准损坏或变体不可回放返回 null）。 */
export function diffVariant(exp, v) {
  if (exp.baseCorrupt || !variantReplayable(v)) return null;
  return compareVersions(baselineEntry(exp), variantEntry(v));
}

/* ---------------- 状态汇总 ---------------- */

export function variantCounters(variants) {
  const c = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, corrupt: 0 };
  for (const v of variants) {
    if (v.corrupt) c.corrupt++;
    if (c[v.status] !== undefined) c[v.status]++;
  }
  return c;
}

/** 依据各变体状态与持久化的 runState 推导一致的实验级状态（重启后也确定）。 */
export function reconcileRunState(runState, variants) {
  const has = (s) => variants.some((v) => v.status === s);
  if (has('running')) return 'running';
  if (runState === 'cancelling') return 'cancelled';
  if (runState === 'running') return has('queued') ? 'paused' : (has('cancelled') ? 'cancelled' : 'done');
  if (runState === 'cancelled') return 'cancelled';
  if (runState === 'done') return 'done';
  if (runState === 'paused') return has('queued') ? 'paused' : (has('cancelled') ? 'cancelled' : 'done');
  return has('queued') ? 'queued' : (has('cancelled') ? 'cancelled' : 'done');
}

/* ---------------- 加载清洗 / 损坏容忍 ---------------- */

/**
 * 清洗持久化实验：
 * - 结构损坏的实验整条跳过并告警；变体结果指纹不一致只标该变体 corrupt（实验照常打开）；
 * - 基准快照损坏标 baseCorrupt：不影响查看 / 另存变体，只禁用“与基准比较”；
 * - 刷新/重启时 running 的变体回到 queued，running/cancelling 的实验分别收敛为
 *   paused / cancelled —— 排队项仍排队、完成项不丢、顺序不变。
 */
export function sanitizeExperiments(raw, warnings = []) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x0 of raw) {
    if (!x0 || typeof x0 !== 'object' || typeof x0.id !== 'string' || typeof x0.name !== 'string') {
      warnings.push({ level: 'error', text: '一条布局方案实验记录结构损坏，已跳过（其余实验不受影响）' });
      continue;
    }
    const tag = `实验「${x0.name}」`;
    const bm0 = x0.baseModel;
    if (!bm0 || typeof bm0 !== 'object' || !Array.isArray(bm0.rects) || !Array.isArray(bm0.constraints)) {
      warnings.push({ level: 'error', text: `${tag} 的基准快照缺失或结构损坏，该实验未加载` });
      continue;
    }
    let baseModel, baseReport, baseCorrupt = false;
    try {
      baseModel = normalize(bm0);
      const rep = solve(baseModel, null);
      const storedBaseHash = typeof x0.baseHash === 'string' && x0.baseHash ? x0.baseHash : x0.baseReport?.hash;
      baseReport = x0.baseReport && typeof x0.baseReport === 'object' ? x0.baseReport : rep;
      if (!storedBaseHash || rep.hash !== storedBaseHash) {
        baseCorrupt = true;
        warnings.push({ level: 'error', text: `${tag} 的基准快照指纹不一致，已禁用“与基准比较”（变体结果仍可查看 / 另存分支）` });
      }
    } catch (e) {
      warnings.push({ level: 'error', text: `${tag} 的基准快照重算失败：${e.message}，该实验未加载` });
      continue;
    }

    const rawVariants = Array.isArray(x0.variants) ? x0.variants : [];
    const seen = new Set();
    const variants = [];
    rawVariants.forEach((v0, i) => {
      if (!v0 || typeof v0 !== 'object' || typeof v0.id !== 'string' || seen.has(v0.id)) {
        warnings.push({ level: 'error', text: `${tag} 的第 ${i + 1} 个变体记录损坏或 id 重复，已跳过` });
        return;
      }
      seen.add(v0.id);
      const order = Number.isFinite(v0.order) ? v0.order : i;
      const changes = sanitizeChanges(v0.changes, baseModel);
      const v = {
        id: v0.id,
        name: typeof v0.name === 'string' && v0.name ? v0.name : `变体 ${i + 1}`,
        order,
        changes,
        status: VARIANT_STATUSES.has(v0.status) ? v0.status : 'queued',
        error: typeof v0.error === 'string' ? v0.error : null,
        attempts: Number.isFinite(v0.attempts) ? Math.max(0, Math.floor(v0.attempts)) : 0,
        result: null,
      };
      // 重启一致性：running 一定是在“求解已开始但未落盘”的瞬间被刷新，回到排队
      if (v.status === 'running') v.status = 'queued';
      // 取消在落盘前未收尾：排队项一律收敛为已取消
      if (x0.runState === 'cancelling' && (v.status === 'queued' || v.status === 'running')) v.status = 'cancelled';

      if (v.status === 'done') {
        const checked = checkResult(v0.result, baseModel, v, tag, warnings);
        if (checked.corrupt) {
          v.corrupt = true;
          v.corruptReason = checked.reason;
          v.result = null;
        } else {
          v.result = checked.result;
        }
      }
      variants.push(v);
    });
    variants.sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1));
    if (!variants.length) {
      warnings.push({ level: 'error', text: `${tag} 没有任何有效变体记录，该实验未加载` });
      continue;
    }
    const runState = reconcileRunState(x0.runState, variants);
    out.push({
      id: x0.id,
      name: x0.name,
      createdAt: Number.isFinite(x0.createdAt) ? x0.createdAt : 0,
      updatedAt: Number.isFinite(x0.updatedAt) ? x0.updatedAt : (Number.isFinite(x0.createdAt) ? x0.createdAt : 0),
      actor: typeof x0.actor === 'string' ? x0.actor : '未知操作者',
      source: sanitizeSource(x0.source),
      baseModel,
      baseReport,
      baseHash: typeof x0.baseHash === 'string' ? x0.baseHash : (baseReport?.hash || ''),
      variants,
      configHash: typeof x0.configHash === 'string' ? x0.configHash : '',
      runState,
      ...(baseCorrupt ? { baseCorrupt: true } : {}),
    });
  }
  return out;
}

function sanitizeSource(src) {
  if (!src || typeof src !== 'object' || typeof src.eventId !== 'string') return null;
  return {
    branchId: typeof src.branchId === 'string' ? src.branchId : '',
    eventId: src.eventId,
    seq: Number.isFinite(src.seq) ? src.seq : null,
    hash: typeof src.hash === 'string' ? src.hash : '',
  };
}

function checkResult(r0, baseModel, v, tag, warnings) {
  const vtag = `${tag} / 变体「${v.name}」`;
  if (!r0 || typeof r0 !== 'object' || !r0.model || !r0.report) {
    warnings.push({ level: 'error', text: `${vtag} 的结果缺失或结构损坏，无法回放（其余变体不受影响）` });
    return { corrupt: true, reason: '结果数据缺失或结构损坏' };
  }
  const { errors } = validate(r0.model);
  if (errors.length) {
    warnings.push({ level: 'error', text: `${vtag} 的结果快照校验失败：${errors[0]}，无法回放` });
    return { corrupt: true, reason: `结果校验失败：${errors[0]}` };
  }
  let model, report;
  try {
    model = normalize(r0.model);
    report = solve(model, null);
  } catch (e) {
    warnings.push({ level: 'error', text: `${vtag} 的结果重算失败：${e.message}，无法回放` });
    return { corrupt: true, reason: `结果重算失败：${e.message}` };
  }
  const storedHash = typeof r0.hash === 'string' && r0.hash ? r0.hash : r0.report?.hash;
  if (!storedHash || report.hash !== storedHash) {
    warnings.push({
      level: 'error',
      text: `${vtag} 的指纹校验失败（记录 ${(storedHash || '缺失').slice(0, 8)} / 重算 ${report.hash.slice(0, 8)}），无法回放`,
    });
    return { corrupt: true, reason: `指纹不一致：记录 ${(storedHash || '缺失').slice(0, 8)}，重算 ${report.hash.slice(0, 8)}` };
  }
  if (!Array.isArray(r0.conflicts)) r0.conflicts = structuredClone(report.conflicts);
  return {
    corrupt: false,
    result: freeze({
      model,
      report,
      hash: report.hash,
      conflicts: Array.isArray(r0.conflicts) ? r0.conflicts : structuredClone(report.conflicts),
      completedAt: Number.isFinite(r0.completedAt) ? r0.completedAt : 0,
      durationMs: Number.isFinite(r0.durationMs) ? r0.durationMs : 0,
    }),
  };
}

/* ---------------- 跨页面合流（server.py 与此同构） ---------------- */

/**
 * 实验合流：实验按 id 并集；同实验的变体按 id 合并，
 * “走得更远”的状态（done > failed > cancelled > running > queued）胜出，
 * 完成结果不可被降级覆盖；定义类字段以服务端为准。输出确定。
 */
export function mergeExperiments(serverList, clientList) {
  const norm = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []));
  const byId = new Map();
  for (const x of norm(serverList)) if (x && typeof x === 'object' && x.id) byId.set(x.id, x);
  for (const c of norm(clientList)) {
    if (!c || typeof c !== 'object' || !c.id) continue;
    const s = byId.get(c.id);
    if (!s) { byId.set(c.id, c); continue; }
    byId.set(c.id, mergeOneExperiment(s, c));
  }
  return [...byId.values()];
}

function mergeOneExperiment(s, c) {
  const sv = new Map((s.variants || []).map((v) => [v.id, v]));
  const order = (s.variants || []).map((v) => v.id);
  for (const cv of c.variants || []) {
    if (!sv.has(cv.id)) { sv.set(cv.id, cv); order.push(cv.id); continue; }
    sv.set(cv.id, mergeVariant(sv.get(cv.id), cv));
  }
  const variants = order.map((id) => sv.get(id));
  const sDone = (s.variants || []).filter((v) => v.status === 'done' || v.status === 'failed' || v.status === 'cancelled').length;
  const cDone = (c.variants || []).filter((v) => v.status === 'done' || v.status === 'failed' || v.status === 'cancelled').length;
  const winner = cDone > sDone ? c : s;
  const merged = {
    ...s,
    variants,
    updatedAt: Math.max(Number(s.updatedAt) || 0, Number(c.updatedAt) || 0),
    runState: reconcileRunState(winner.runState, variants),
  };
  if (s.baseCorrupt || c.baseCorrupt) merged.baseCorrupt = true;
  return merged;
}

function mergeVariant(a, b) {
  const rank = (v) => (v.corrupt ? 0 : STATUS_RANK[v.status] ?? 0);
  const win = rank(b) > rank(a) ? b : a;
  const out = {
    ...a,
    name: a.name,
    order: Number.isFinite(a.order) ? a.order : b.order,
    changes: a.changes,
    status: win.status,
    error: win.error ?? a.error ?? null,
    attempts: Math.max(a.attempts || 0, b.attempts || 0),
    result: null,
  };
  // 完成结果不可降级覆盖：优先取任一非损坏结果（同定义同求解器，两端结果逐字节等价）
  const goodA = !a.corrupt && a.result ? a.result : null;
  const goodB = !b.corrupt && b.result ? b.result : null;
  out.result = goodA || goodB || a.result || b.result || null;
  out.corrupt = !out.result && (a.corrupt || b.corrupt);
  if (out.corrupt) out.corruptReason = a.corruptReason || b.corruptReason || '结果损坏';
  return out;
}
