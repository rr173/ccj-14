/*
 * 旧版布局批量迁移：纯函数模块（无 DOM / 存储依赖），运行器在 Store 中。
 *
 * 支持识别并迁移四种历史布局格式（见下）。每份文件独立成功或失败；
 * 成功转换得到一份干净、可求解、无悬空引用 / 无循环依赖 / 无越界数据的当前模型。
 *
 * 格式：
 *   'current'  当前审计/规范模型（{canvas,rects,constraints}，本系统导出物）
 *   'legacy-doc' 2019 前审计旧文档（{entries:[{model,t,label}], idx, actor?}，与 migrateLegacy 同族）
 *   'v2017-flat' 2017 扁平交换格式（{format:'rect-layout/v1'|'rc-v2', canvas:{width,height},
 *                                  boxes:[[x,y,w,h,label,id?]|{...}], links:[{type,...}]}）
 *   'v2015-tables' 2015 表格式（{schema:'RC-TABLES', rects:[{uid,...}], rules:[{op,...}]}）
 *   'unknown'  无法识别（文件级失败）
 *
 * 迁移文件 file（顺序固定，结果顺序即此顺序）：
 *   {
 *     id, name,                  // 源文件名（标签）
 *     sourceHash,                // 原始输入的规范化内容指纹：相同源文件重复提交幂等
 *     raw,                       // 原始输入文本（失败文件保留；成功文件为节省体积只保留前 20000 字符）
 *     size,
 *     status: 'queued'|'running'|'done'|'failed'|'cancelled',
 *     detected: format|null,
 *     confidence,
 *     preview: ConversionResult|null,  // 导入时的 dry-run 转换（预览），与正式迁移同管线、确定
 *     error: {code,message,line,column,suggestion}|null,
 *     result: null | { model, report, hash, mapping, quarantined, warnings, name }, // done 冻结
 *     imported: null | { at, branchId, branchName, eventId, diff, by },
 *     attempts, startedAt, finishedAt,
 *   }
 *
 * 批次 batch：
 *   { id, name, createdAt, updatedAt, actor, runState, files:[...],
 *     autoImport, importedCount }
 *
 * 隔离（quarantine）的条目绝不进入当前模型；无法识别的字段只记录不进入模型。
 */

import { validate, normalize, DEFAULT_CANVAS, uid } from './model.js';
import { solve, findCycle } from './solver.js';
import { compareVersions } from './versions.js';
import { hash32 } from './experiments.js';

export const FILE_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
export const BATCH_STATES = ['queued', 'running', 'paused', 'done', 'cancelled'];

const MAX_RAW_KEPT = 20000;
const MAX_RECTS = 500;
const MAX_CONSTRAINTS = 2000;

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

/* =====================================================================
 * 指纹 / 幂等
 * ===================================================================== */

/** 原始输入的规范化内容指纹：解析为 JSON 后递归排序键名（键顺序差异不产生新指纹）。 */
export function sourceFingerprint(rawText) {
  let canon = String(rawText ?? '');
  try {
    canon = JSON.stringify(JSON.parse(canon), replacer);
  } catch {
    canon = canon.replace(/\s+/g, ' ').trim(); // 非 JSON：折叠空白后哈希
  }
  return hash32(canon);
}

function replacer(_k, v) {
  if (Array.isArray(v) || !(v && typeof v === 'object')) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = v[k];
  return out;
}

/* =====================================================================
 * 格式识别
 * ===================================================================== */

/**
 * 识别一份文本输入的历史格式。返回 { format, confidence, parsed, reason }。
 * - parsed 为已解析 JSON（供后续转换复用）；解析失败 parsed=null 并给出行列。
 * - confidence 0..1：唯一明确匹配为 1，多义（如裸数组）按最可能格式给较低分。
 */
export function detectFormat(rawText) {
  const text = String(rawText ?? '');
  const trimmed = text.trim();
  if (!trimmed) return { format: 'unknown', confidence: 0, parsed: null, reason: '内容为空' };
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    const pos = jsonErrorPosition(text, e);
    return {
      format: 'unknown', confidence: 0, parsed: null,
      reason: '不是合法 JSON（历史格式均为 JSON）',
      parseError: { message: e.message, ...pos },
    };
  }
  if (typeof data !== 'object' || data === null) {
    return { format: 'unknown', confidence: 0, parsed: data, reason: '顶层不是对象或数组' };
  }
  const checks = [
    matchCurrent(data),
    matchLegacyDoc(data),
    matchFlat(data),
    matchTables(data),
  ].filter(Boolean);
  checks.sort((a, b) => b.confidence - a.confidence);
  const best = checks[0];
  if (!best || best.confidence < 0.4) {
    return { format: 'unknown', confidence: best?.confidence || 0, parsed: data, reason: '没有匹配任何已知历史格式的结构特征' };
  }
  return { format: best.format, confidence: best.confidence, parsed: data, reason: best.reason, markers: best.markers };
}

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

/** 当前规范模型（本系统导出物 / 审计事件中的 model）。 */
function matchCurrent(d) {
  if (Array.isArray(d)) return null;
  const r = Array.isArray(d.rects) ? d.rects : null;
  const c = Array.isArray(d.constraints) ? d.constraints : null;
  if (!r || !c) return null;
  const looksRect = r.every((x) => isObj(x) && typeof x.id === 'string'
    && num(x.x) !== null && num(x.y) !== null && num(x.w) !== null && num(x.h) !== null);
  const looksCons = c.every((x) => isObj(x) && typeof x.id === 'string'
    && typeof x.kind === 'string' && typeof x.rect === 'string');
  const cv = isObj(d.canvas) && num(d.canvas.w) > 0 && num(d.canvas.h) > 0;
  if (looksRect && looksCons && cv) return { format: 'current', confidence: 1, reason: '当前规范模型（canvas + rects[id,x,y,w,h] + constraints[id,kind,rect]）', markers: c.length };
  if (looksRect && looksCons) return { format: 'current', confidence: 0.7, reason: 'rects/constraints 结构匹配但画布缺失或非法（迁移时用默认画布）', markers: c.length };
  return null;
}

/** 2019 前审计旧文档 entries/idx。 */
function matchLegacyDoc(d) {
  if (Array.isArray(d)) return null;
  if (!Array.isArray(d.entries) || !d.entries.length) return null;
  const ok = d.entries.every((e) => isObj(e) && isObj(e.model)
    && Array.isArray(e.model.rects) && Array.isArray(e.model.constraints));
  if (!ok) return null;
  return { format: 'legacy-doc', confidence: 0.95, reason: '旧审计文档 entries[]/idx（2019 前格式）', markers: d.entries.length };
}

/** 2017 扁平交换格式 boxes[]/links[]。 */
function matchFlat(d) {
  if (Array.isArray(d)) return null;
  const fmt = String(d.format || '').toLowerCase();
  const hasBoxes = Array.isArray(d.boxes) && d.boxes.length;
  const hasLinks = Array.isArray(d.links);
  if (fmt === 'rect-layout/v1' || fmt === 'rc-v2') {
    if (hasBoxes) return { format: 'v2017-flat', confidence: 1, reason: `格式标记 format=${d.format} + boxes[]/links[]`, markers: d.boxes.length };
  }
  if (hasBoxes && hasLinks) {
    const looks = d.boxes.every((b) => Array.isArray(b) ? b.length >= 4 : isObj(b) && (num(b?.x) !== null || num(b?.left) !== null));
    if (looks) return { format: 'v2017-flat', confidence: 0.8, reason: 'boxes[]/links[] 扁平交换结构（2017 格式）', markers: d.boxes.length };
  }
  return null;
}

/** 2015 表格式 rects[]/rules[]（uid/op 命名）。 */
function matchTables(d) {
  if (Array.isArray(d)) return null;
  if (String(d.schema || '').toUpperCase() === 'RC-TABLES' && Array.isArray(d.rects)) {
    return { format: 'v2015-tables', confidence: 1, reason: 'schema=RC-TABLES 表格式（2015 格式）', markers: d.rects.length };
  }
  const hasRules = Array.isArray(d.rules) && Array.isArray(d.rects);
  if (hasRules && d.rects.length) {
    const opish = d.rules.some((r) => isObj(r) && typeof r.op === 'string');
    const uidish = d.rects.every((r) => isObj(r) && (typeof r.uid === 'string' || typeof r.id === 'string'));
    if (opish && uidish) return { format: 'v2015-tables', confidence: 0.7, reason: 'rects[uid]/rules[op] 表结构（2015 格式）', markers: d.rects.length };
  }
  return null;
}

/** 定位 JSON 解析错误的行列（用于失败文件的“错误位置”）。 */
function jsonErrorPosition(text, e) {
  const m = /position (\d+)/i.exec(e.message || '');
  let line = 0, column = 0, offset = null;
  if (m) {
    offset = Number(m[1]);
    const before = text.slice(0, offset);
    const parts = before.split('\n');
    line = parts.length;
    column = parts[parts.length - 1].length + 1;
  }
  return { line: line || null, column: column || null, offset };
}

/* =====================================================================
 * 转换结果类型
 * ===================================================================== */

function conversionError(code, message, { line = null, column = null, suggestion = '' } = {}) {
  return { code, message, line, column, suggestion };
}

/**
 * 转换一份文件：detect -> 按格式抽取统一中间表示 -> 规范化（稳定重命名 /
 * 悬空 / 循环 / 越界隔离 / 未知字段记录）-> validate + findCycle + solve。
 * 纯函数、确定、不抛异常（异常也收敛为文件级失败）。
 * 返回 { ok, format, confidence, name, model, report, hash, mapping, quarantined, warnings, error }。
 */
export function convertSource(rawText, { sourceName = '' } = {}) {
  const det = detectFormat(rawText);
  if (det.format === 'unknown') {
    const sug = det.parseError
      ? '修正 JSON 语法（报错位置已给出）后重新导入；或确认该文件确实来自受支持的历史版本。'
      : '受支持的历史格式：当前规范模型、旧审计文档(entries/idx)、2017 boxes/links、2015 RC-TABLES。';
    return {
      ok: false, format: null, confidence: 0, name: sourceName,
      model: null, report: null, hash: null, mapping: emptyMapping(), quarantined: [], warnings: [],
      error: conversionError('unrecognized-format', det.reason, {
        line: det.parseError?.line, column: det.parseError?.column, suggestion: sug,
      }),
    };
  }
  let extracted;
  try {
    extracted = extractIntermediate(det.format, det.parsed);
  } catch (e) {
    return {
      ok: false, format: det.format, confidence: det.confidence, name: sourceName,
      model: null, report: null, hash: null, mapping: emptyMapping(), quarantined: [], warnings: [],
      error: conversionError('extract-failed', `抽取布局失败：${e.message}`, { suggestion: e.suggestion || '检查文件结构是否被截断或手工修改过。' }),
    };
  }
  const built = buildModel(extracted, { format: det.format, sourceName });
  if (built.fatal) {
    return {
      ok: false, format: det.format, confidence: det.confidence, name: extracted.name || sourceName,
      model: null, report: null, hash: null, mapping: built.mapping, quarantined: built.quarantined, warnings: built.warnings,
      error: built.fatal,
    };
  }
  const model = normalize(built.model);
  const { errors } = validate(model);
  if (errors.length) {
    return {
      ok: false, format: det.format, confidence: det.confidence, name: extracted.name || sourceName,
      model: null, report: null, hash: null, mapping: built.mapping, quarantined: built.quarantined, warnings: built.warnings,
      error: conversionError('invalid-model', `转换后模型仍不合法：${errors[0]}`, { suggestion: '该数据在隔离悬空/越界后仍结构非法，请检查源文件。' }),
    };
  }
  // 固化不动点（与 Store.commit / 实验管线一致）：求解 -> 回写位置 -> 再求解
  const rep1 = solve(model, null);
  for (const r of model.rects) {
    const p = rep1.rects[r.id];
    if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
  }
  const norm = normalize(model);
  const report = solve(norm, null);
  return {
    ok: true,
    format: det.format,
    confidence: det.confidence,
    name: extracted.name || sourceName,
    model: norm,
    report,
    hash: report.hash,
    mapping: built.mapping,
    quarantined: built.quarantined,
    warnings: built.warnings,
    unknownFields: built.unknownFields,
    error: null,
  };
}

function emptyMapping() {
  return { rects: [], constraints: [], branches: [], versions: [] };
}

/* =====================================================================
 * 中间表示抽取（各历史格式 -> 统一 IR）
 * IR = { name, canvas:{w,h}|null, rects:[RawRect], constraints:[RawCons],
 *        branches:[{id,name,current}], versions:[{id,name,hashRef}], unknown:[{path,field}] }
 * ===================================================================== */

function extractIntermediate(format, data) {
  const ir = { name: '', canvas: null, rects: [], constraints: [], branches: [], versions: [], unknown: [] };
  if (format === 'current') fromCurrent(ir, data);
  else if (format === 'legacy-doc') fromLegacyDoc(ir, data);
  else if (format === 'v2017-flat') fromFlat2017(ir, data);
  else if (format === 'v2015-tables') fromTables2015(ir, data);
  else throw Object.assign(new Error(`不支持的格式 ${format}`), { suggestion: '' });
  return ir;
}

function noteUnknown(ir, path, field, value) {
  let preview = value;
  try { preview = JSON.stringify(value); } catch { preview = String(value); }
  if (typeof preview === 'string' && preview.length > 80) preview = preview.slice(0, 80) + '…';
  ir.unknown.push({ path, field, sample: preview });
}

/** 当前模型：直接映射；记录不在白名单内的未知字段。 */
function fromCurrent(ir, d) {
  ir.name = typeof d.name === 'string' ? d.name : '';
  ir.canvas = isObj(d.canvas) ? { w: num(d.canvas.w) ?? DEFAULT_CANVAS.w, h: num(d.canvas.h) ?? DEFAULT_CANVAS.h } : null;
  const rectKnown = new Set(['id', 'name', 'x', 'y', 'w', 'h']);
  for (const [i, r] of (Array.isArray(d.rects) ? d.rects : []).entries()) {
    if (!isObj(r)) { noteUnknown(ir, `rects[${i}]`, '(非对象元素)', r); continue; }
    for (const k of Object.keys(r)) if (!rectKnown.has(k)) noteUnknown(ir, `rects[${i}]`, k, r[k]);
    ir.rects.push({ __path: `rects[${i}]`, id: r.id, name: r.name, x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h), raw: r });
  }
  const consKnown = new Set(['id', 'kind', 'rect', 'other', 'axis', 'edge', 'otherEdge', 'side', 'gap', 'margin', 'w', 'h', 'priority', 'enabled']);
  for (const [i, c] of (Array.isArray(d.constraints) ? d.constraints : []).entries()) {
    if (!isObj(c)) { noteUnknown(ir, `constraints[${i}]`, '(非对象元素)', c); continue; }
    for (const k of Object.keys(c)) if (!consKnown.has(k)) noteUnknown(ir, `constraints[${i}]`, k, c[k]);
    ir.constraints.push({ __path: `constraints[${i}]`, ...c });
  }
  collectRefs(ir, d);
}

/** 旧审计文档：取 idx 指向（或最后一条）为当前布局；其余 entries 记为“历史版本”引用。 */
function fromLegacyDoc(ir, d) {
  const entries = d.entries;
  const idx = Number.isInteger(d.idx) ? Math.min(Math.max(d.idx, 0), entries.length - 1) : entries.length - 1;
  const cur = entries[idx]?.model;
  if (!cur) throw Object.assign(new Error('entries[idx] 没有 model'), { suggestion: 'idx 越界或条目缺少 model；修正 idx 后重试。' });
  ir.name = typeof d.name === 'string' ? d.name : '';
  fromCurrent(ir, cur);
  ir.branches.push({ id: 'main', name: '主分支', current: true });
  entries.forEach((e, i) => {
    const h = isObj(e) ? hash32(JSON.stringify(e.model || {})) : '';
    ir.versions.push({ id: `entry_${i}`, name: e?.label || `历史 #${i + 1}`, hashRef: h, current: i === idx });
  });
  for (const k of Object.keys(d)) if (!['entries', 'idx', 'actor', 'name'].includes(k)) noteUnknown(ir, '$', k, d[k]);
}

/** 2017 扁平格式：boxes 为 [x,y,w,h,label,id?] 数组或对象；links 描述关系。 */
function fromFlat2017(ir, d) {
  ir.name = typeof d.name === 'string' ? d.name : '';
  const cv = d.canvas || d.viewport || d.size || {};
  ir.canvas = isObj(cv) ? { w: num(cv.w ?? cv.width) ?? DEFAULT_CANVAS.w, h: num(cv.h ?? cv.height) ?? DEFAULT_CANVAS.h } : null;
  const boxId = new Map(); // 序号 -> 旧 id（用于 links 解析）
  d.boxes.forEach((b, i) => {
    const path = `boxes[${i}]`;
    let o;
    if (Array.isArray(b)) o = { x: num(b[0]), y: num(b[1]), w: num(b[2]), h: num(b[3]), name: b[4], id: b[5] };
    else o = { x: num(b.x ?? b.left), y: num(b.y ?? b.top), w: num(b.w ?? b.width), h: num(b.h ?? b.height), name: b.label ?? b.name, id: b.id ?? b.uid };
    const known = ['x', 'y', 'left', 'top', 'w', 'h', 'width', 'height', 'label', 'name', 'id', 'uid'];
    if (isObj(b)) for (const k of Object.keys(b)) if (!known.includes(k)) noteUnknown(ir, path, k, b[k]);
    // 无显式 id 的盒子：按序号确定性生成 box<序号>（links 用序号引用时解析到同一 id）
    if (typeof o.id !== 'string' || !o.id) o.id = `box${i}`;
    boxId.set(i, o.id);
    ir.rects.push({ __path: path, id: o.id, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, raw: o, __seq: i });
  });
  // links：{type:'snap'|'align'|'gap'|'contain'|'lock', from/a, to/b, dir/side/edge, dist/gap, prio/priority}
  (d.links || []).forEach((lk, i) => {
    if (!isObj(lk)) { noteUnknown(ir, `links[${i}]`, '(非对象元素)', lk); return; }
    const path = `links[${i}]`;
    const known = ['type', 'from', 'to', 'a', 'b', 'dir', 'side', 'edge', 'fromEdge', 'toEdge', 'dist', 'gap', 'offset', 'prio', 'priority', 'enabled'];
    for (const k of Object.keys(lk)) if (!known.includes(k)) noteUnknown(ir, path, k, lk[k]);
    const type = String(lk.type || '').toLowerCase();
    const a = refOf(lk.from ?? lk.a, boxId);
    const b = refOf(lk.to ?? lk.b, boxId);
    const gap = num(lk.dist ?? lk.gap ?? lk.offset) ?? 0;
    const prio = clampPrio(num(lk.prio ?? lk.priority));
    const c = { __path: path, id: typeof lk.id === 'string' ? lk.id : `link${i}`, rect: a, other: b, gap, priority: prio, enabled: lk.enabled !== false, raw: lk };
    if (type === 'snap' || type === 'align') {
      const edge = edgeOf(lk.edge ?? lk.fromEdge, lk.dir);
      const otherEdge = edgeOf(lk.toEdge, lk.dir);
      const axis = axisOf(lk.dir, edge);
      Object.assign(c, { kind: 'snap', axis, edge: axis === 'x' ? normalizeEdge(edge, 'l') : normalizeEdge(edge, 't'),
        otherEdge: axis === 'x' ? normalizeEdge(otherEdge, 'r') : normalizeEdge(otherEdge, 't') });
    } else if (type === 'gap' || type === 'mingap' || type === 'space') {
      Object.assign(c, { kind: 'minGap', side: sideOf(lk.side ?? lk.dir) });
    } else if (type === 'contain' || type === 'inside') {
      Object.assign(c, { kind: 'contain', margin: Math.max(0, gap) });
      c.other = undefined;
    } else if (type === 'lock' || type === 'fixed') {
      const target = ir.rects.find((r) => legacyIdOf(r) === c.rect);
      Object.assign(c, { kind: 'lock', w: target?.w ?? null, h: target?.h ?? null });
      c.other = undefined;
    } else {
      noteUnknown(ir, path, 'type', type);
      c.__unknownType = type;
    }
    ir.constraints.push(c);
  });
  if (Array.isArray(d.branches)) d.branches.forEach((br, i) => {
    if (isObj(br)) ir.branches.push({ id: String(br.id ?? i), name: String(br.name ?? br.id ?? `分支${i}`), current: !!br.current || br.id === d.currentBranch });
  });
  if (Array.isArray(d.snapshots)) d.snapshots.forEach((s, i) => {
    if (isObj(s)) ir.versions.push({ id: String(s.id ?? `snap${i}`), name: String(s.name ?? s.label ?? `快照${i}`), hashRef: typeof s.hash === 'string' ? s.hash : '', current: !!s.current });
  });
  const topKnown = ['format', 'name', 'canvas', 'viewport', 'size', 'boxes', 'links', 'branches', 'currentBranch', 'snapshots'];
  for (const k of Object.keys(d)) if (!topKnown.includes(k)) noteUnknown(ir, '$', k, d[k]);
}

/** 2015 表格式：rects[uid,left/top/width/height,caption]，rules[op,target/anchor,...]。 */
function fromTables2015(ir, d) {
  ir.name = typeof d.title === 'string' ? d.title : '';
  if (isObj(d.canvas) || isObj(d.page)) {
    const cv = d.canvas || d.page;
    ir.canvas = { w: num(cv.width ?? cv.w) ?? DEFAULT_CANVAS.w, h: num(cv.height ?? cv.h) ?? DEFAULT_CANVAS.h };
  }
  d.rects.forEach((r, i) => {
    const path = `rects[${i}]`;
    if (!isObj(r)) { noteUnknown(ir, path, '(非对象元素)', r); return; }
    const known = ['uid', 'id', 'caption', 'name', 'left', 'top', 'x', 'y', 'width', 'height', 'w', 'h', 'locked'];
    for (const k of Object.keys(r)) if (!known.includes(k)) noteUnknown(ir, path, k, r[k]);
    ir.rects.push({
      __path: path,
      id: typeof r.uid === 'string' ? r.uid : r.id,
      name: r.caption ?? r.name,
      x: num(r.left ?? r.x), y: num(r.top ?? r.y),
      w: num(r.width ?? r.w), h: num(r.height ?? r.h),
      raw: r, __seq: i,
    });
  });
  const ops = {
    align: 'snap', attach: 'snap', glue: 'snap',
    keepgap: 'minGap', gap: 'minGap', margin: 'minGap',
    inside: 'contain', bound: 'contain',
    fixsize: 'lock', fixed: 'lock',
  };
  (d.rules || []).forEach((ru, i) => {
    const path = `rules[${i}]`;
    if (!isObj(ru)) { noteUnknown(ir, path, '(非对象元素)', ru); return; }
    const known = ['op', 'id', 'target', 'follower', 'anchor', 'host', 'orientation', 'edge', 'anchorEdge', 'distance', 'space', 'pad', 'weight', 'on'];
    for (const k of Object.keys(ru)) if (!known.includes(k)) noteUnknown(ir, path, k, ru[k]);
    const kind = ops[String(ru.op || '').toLowerCase()];
    const follower = String(ru.target ?? ru.follower ?? '');
    const anchor = String(ru.anchor ?? ru.host ?? '');
    const c = {
      __path: path,
      id: typeof ru.id === 'string' ? ru.id : `rule${i}`,
      kind, rect: follower, other: anchor,
      gap: num(ru.distance ?? ru.space ?? ru.pad) ?? 0,
      priority: clampPrio(num(ru.weight)),
      enabled: ru.on !== false, raw: ru,
    };
    if (!kind) { c.__unknownType = ru.op; ir.constraints.push(c); return; }
    if (kind === 'snap') {
      const edge = edgeOf(ru.edge, ru.orientation);
      const axis = axisOf(ru.orientation, edge);
      Object.assign(c, { kind, axis, edge: axis === 'x' ? normalizeEdge(edge, 'l') : normalizeEdge(edge, 't'),
        otherEdge: axis === 'x' ? normalizeEdge(edgeOf(ru.anchorEdge, ru.orientation), 'r') : normalizeEdge(edgeOf(ru.anchorEdge, ru.orientation), 't') });
    } else if (kind === 'minGap') {
      Object.assign(c, { kind, side: sideOf(ru.orientation) });
    } else if (kind === 'contain') {
      Object.assign(c, { kind, margin: Math.max(0, c.gap) });
      c.other = undefined;
    } else if (kind === 'lock') {
      const t = ir.rects.find((r) => legacyIdOf(r) === follower);
      Object.assign(c, { kind, w: t?.w ?? null, h: t?.h ?? null });
      c.other = undefined;
    }
    ir.constraints.push(c);
  });
  if (Array.isArray(d.pages)) d.pages.forEach((p, i) => {
    if (isObj(p)) ir.branches.push({ id: String(p.id ?? i), name: String(p.name ?? `页${i}`), current: !!p.current || p.id === d.currentPage });
  });
}

function collectRefs(ir, d) {
  if (Array.isArray(d.branches)) d.branches.forEach((br, i) => {
    if (isObj(br)) ir.branches.push({ id: String(br.id ?? i), name: String(br.name ?? br.id ?? `分支${i}`), current: !!br.current });
  });
  if (Array.isArray(d.snapshots)) d.snapshots.forEach((s, i) => {
    if (isObj(s)) ir.versions.push({ id: String(s.id ?? `snap${i}`), name: String(s.name ?? `快照${i}`), hashRef: typeof s.hash === 'string' ? s.hash : '', current: !!s.current });
  });
}

function refOf(v, boxId) {
  if (typeof v === 'string') return v;
  if (Number.isInteger(v)) return boxId.get(v) ?? `box${v}`;
  return v == null ? '' : String(v);
}
function legacyIdOf(r) { return typeof r?.id === 'string' && r.id ? r.id : `box${r?.__seq ?? ''}`; }
function clampPrio(n) {
  if (n === null || !Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(999, Math.round(n)));
}
function edgeOf(e, dir) {
  const s = String(e || '').toLowerCase();
  if (['l', 'left', 'w', 'west'].includes(s)) return 'l';
  if (['r', 'right', 'e', 'east'].includes(s)) return 'r';
  if (['t', 'top', 'n', 'north'].includes(s)) return 't';
  if (['b', 'bottom', 's', 'south'].includes(s)) return 'b';
  if (['mid', 'center', 'centre', 'm'].includes(s)) return 'mid';
  return null;
}
function normalizeEdge(e, dflt) { return ['l', 'r', 't', 'b', 'mid'].includes(e) ? e : dflt; }
function axisOf(dir, edge) {
  const s = String(dir || '').toLowerCase();
  if (['x', 'h', 'horizontal', 'horz', 'row'].includes(s)) return 'x';
  if (['y', 'v', 'vertical', 'vert', 'col'].includes(s)) return 'y';
  return (edge === 't' || edge === 'b') ? 'y' : 'x';
}
function sideOf(s) {
  const v = String(s || '').toLowerCase();
  if (['l', 'left', 'w'].includes(v)) return 'left';
  if (['r', 'right', 'e'].includes(v)) return 'right';
  if (['a', 'above', 't', 'top', 'n'].includes(v)) return 'above';
  if (['b', 'below', 'bottom', 's'].includes(v)) return 'below';
  return 'right';
}

/* =====================================================================
 * IR -> 当前模型：稳定重命名 + 引用重写 + 隔离
 * ===================================================================== */

function buildModel(ir, { format } = {}) {
  const warnings = [];
  const quarantined = [];
  const mapping = emptyMapping();
  const model = { canvas: { w: ir.canvas?.w || DEFAULT_CANVAS.w, h: ir.canvas?.h || DEFAULT_CANVAS.h }, rects: [], constraints: [] };

  const q = (kind, path, id, name, reason, suggestion, detail = {}) =>
    quarantined.push({ kind, path: path || '', sourceId: String(id ?? ''), name: String(name ?? ''), reason, suggestion, ...detail });

  // ---- 矩形：稳定重命名（确定性、可解释），越界/非法几何隔离 ----
  const idMap = new Map();      // 旧 id -> 新 id
  const usedIds = new Set();
  const renameLog = [];
  const reserve = (id) => { usedIds.add(id); };
  let autoIdx = 0;
  const stableRectId = (rawId, seq) => {
    let base = typeof rawId === 'string' && rawId.trim() ? sanitizeToken(rawId, 'r') : `rect_${seq + 1}`;
    if (!/^[A-Za-z]/.test(base)) base = 'r_' + base;
    let candidate = base;
    if (usedIds.has(candidate)) {
      let n = 2;
      while (usedIds.has(`${base}_mig${n}`)) n++;
      candidate = `${base}_mig${n}`;
    }
    return candidate;
  };

  ir.rects.forEach((r, i) => {
    const seq = Number.isInteger(r.__seq) ? r.__seq : i;
    const rawId = typeof r.id === 'string' ? r.id : '';
    let { x, y, w, h } = r;
    // 几何合法性：非有限数 / 宽高非正 -> 隔离整个矩形
    if (![x, y, w, h].every((v) => Number.isFinite(v)) || !(w > 0) || !(h > 0)) {
      q('rect', r.__path, rawId || `#${seq}`, r.name,
        '矩形几何非法（坐标非数字或宽高非正），不能进入当前布局',
        '修正源数据的 x/y/宽/高（宽高必须为正数）后重新导入。',
        { geometry: { x, y, w, h } });
      return;
    }
    const cw = model.canvas.w, ch = model.canvas.h;
    // 完全在画布外（任意方向）-> 隔离（无法确定性恢复到有意义位置）
    if (x >= cw || y >= ch || x + w <= 0 || y + h <= 0) {
      q('rect', r.__path, rawId || `#${seq}`, r.name,
        `矩形完全在画布外（画布 ${cw}×${ch}，矩形 x=${x},y=${y},w=${w},h=${h}）`,
        '调整源布局画布尺寸，或把矩形移入画布范围后重新导入。',
        { geometry: { x, y, w, h } });
      return;
    }
    // 比画布还大：无法夹入 -> 隔离（保留源数据）
    if (w > cw || h > ch) {
      q('rect', r.__path, rawId || `#${seq}`, r.name,
        `矩形尺寸超过画布（矩形 ${w}×${h}，画布 ${cw}×${ch}），无法确定性夹入`,
        '缩小该矩形或放大源画布后重新导入。',
        { geometry: { x, y, w, h } });
      return;
    }
    // 部分超出：确定性夹回画布内（贴到对应边界），并记录位置调整
    const before = { x, y };
    x = Math.min(Math.max(x, 0), cw - w);
    y = Math.min(Math.max(y, 0), ch - h);
    if (x !== before.x || y !== before.y) {
      warnings.push({
        level: 'warn', path: r.__path, text:
        `矩形「${r.name || rawId || seq}」部分超出画布（${cw}×${ch}）：已确定性夹回（${before.x},${before.y} → ${x},${y}）。`,
      });
    }
    const newId = stableRectId(rawId, seq);
    reserve(newId);
    if (rawId && rawId !== newId) renameLog.push({ kind: 'rect', from: rawId, to: newId, path: r.__path, reason: usedReason(rawId) });
    // id 映射：源 id 只解析到【第一次出现】的矩形；重复矩形得到 _migN 新 id，
    // 但绝不能覆盖原 id 映射（否则旧约束会错误地指向重命名后的副本）。
    if (rawId && !idMap.has(rawId)) idMap.set(rawId, newId);
    idMap.set(`#${seq}`, newId); // 序号引用兜底
    mapping.rects.push({
      sourceId: rawId || `#${seq}`, newId, name: String(r.name || ''), renamed: rawId !== newId,
      adjusted: (x !== before.x || y !== before.y) ? { from: before, to: { x, y } } : null,
    });
    model.rects.push({ id: newId, name: String(r.name ?? ''), x, y, w, h });
    autoIdx++;
  });
  if (model.rects.length > MAX_RECTS) {
    return { fatal: conversionError('too-many-rects', `矩形数量 ${model.rects.length} 超过上限 ${MAX_RECTS}`, { suggestion: '拆分源文件后分批导入。' }), mapping, quarantined, warnings };
  }

  const resolveRect = (ref, path) => {
    if (typeof ref === 'string' && idMap.has(ref)) return { id: idMap.get(ref), dangling: false };
    return { id: null, dangling: true };
  };

  // ---- 约束：引用重写；未知类型 / 悬空引用隔离；稳定约束重命名 ----
  const usedCIds = new Set();
  ir.constraints.forEach((c, i) => {
    const seq = i;
    const path = c.__path || `constraints[${i}]`;
    const label = `${c.kind || c.__unknownType || '?'} ${c.rect || ''}${c.other ? '→' + c.other : ''}`;
    if (c.__unknownType || !c.kind) {
      q('constraint', path, c.id, label, `无法识别的约束类型「${c.__unknownType || '(空)'}」`,
        '该历史版本的关系类型在当前系统没有对应语义，需手工重建为 贴齐/最小间距/包含/锁定。',
        { raw: pickRaw(c.raw) });
      return;
    }
    const follower = resolveRect(c.rect, path);
    if (follower.dangling) {
      q('constraint', path, c.id, label, `跟随矩形引用「${c.rect}」不存在（悬空引用）`,
        '在源文件中补上被引用矩形，或删除该关系后重新导入。', { missingRef: c.rect, field: 'rect' });
      return;
    }
    const base = { id: '', kind: c.kind, rect: follower.id, priority: clampPrio(c.priority), enabled: c.enabled !== false };
    if (c.kind === 'snap') {
      const anchor = resolveRect(c.other, path);
      if (anchor.dangling) {
        q('constraint', path, c.id, label, `锚点矩形引用「${c.other}」不存在（悬空引用）`,
          '在源文件中补上锚点矩形，或删除该贴齐关系后重新导入。', { missingRef: c.other, field: 'other' });
        return;
      }
      const axis = ['x', 'y'].includes(c.axis) ? c.axis : 'x';
      let edge = ['l', 'r', 'mid'].includes(c.edge) ? c.edge : (axis === 'x' ? 'l' : 't');
      let oe = ['l', 'r', 't', 'b', 'mid'].includes(c.otherEdge) ? c.otherEdge : (axis === 'x' ? 'r' : 't');
      if (axis === 'y') { edge = ['t', 'b', 'mid'].includes(edge) ? edge : 't'; oe = ['t', 'b', 'mid'].includes(oe) ? oe : 't'; }
      else { edge = ['l', 'r', 'mid'].includes(edge) ? edge : 'l'; oe = ['l', 'r', 'mid'].includes(oe) ? oe : 'r'; }
      if (base.rect === anchor.id && edge === oe) {
        q('constraint', path, c.id, label, '自贴齐（同矩形同边）无意义', '删除该自引用关系或改为不同边。');
        return;
      }
      Object.assign(base, { other: anchor.id, axis, edge, otherEdge: oe, gap: Math.max(0, num(c.gap) ?? 0) });
    } else if (c.kind === 'minGap') {
      const anchor = resolveRect(c.other, path);
      if (anchor.dangling) {
        q('constraint', path, c.id, label, `障碍矩形引用「${c.other}」不存在（悬空引用）`,
          '在源文件中补上障碍矩形，或删除该间距关系后重新导入。', { missingRef: c.other, field: 'other' });
        return;
      }
      const side = ['left', 'right', 'above', 'below'].includes(c.side) ? c.side : 'right';
      Object.assign(base, { other: anchor.id, side, gap: Math.max(0, num(c.gap) ?? 0) });
    } else if (c.kind === 'contain') {
      Object.assign(base, { margin: Math.max(0, num(c.margin ?? c.gap) ?? 0) });
    } else if (c.kind === 'lock') {
      const w = num(c.w), h = num(c.h);
      if (!(w > 0) || !(h > 0)) {
        q('constraint', path, c.id, label, '锁定尺寸缺失或非正', '补充正确的锁定宽高后重新导入。', { size: { w, h } });
        return;
      }
      Object.assign(base, { w, h });
    } else {
      q('constraint', path, c.id, label, `约束类型「${c.kind}」当前系统未知`, '手工重建为受支持的约束类型。');
      return;
    }
    const rawCId = typeof c.id === 'string' && c.id.trim() ? c.id : '';
    let cid = sanitizeToken(rawCId || `${c.kind}_${seq + 1}`, 'c');
    if (!/^[A-Za-z]/.test(cid)) cid = 'c_' + cid;
    let finalId = cid;
    if (usedCIds.has(finalId)) {
      let n = 2;
      while (usedCIds.has(`${cid}_mig${n}`)) n++;
      finalId = `${cid}_mig${n}`;
    }
    usedCIds.add(finalId);
    if (rawCId && rawCId !== finalId) mapping.constraints.push({ sourceId: rawCId, newId: finalId, renamed: true, reason: usedReason(rawCId) });
    else mapping.constraints.push({ sourceId: rawCId || `#${seq}`, newId: finalId, renamed: false });
    base.id = finalId;
    model.constraints.push(base);
  });
  if (model.constraints.length > MAX_CONSTRAINTS) {
    return { fatal: conversionError('too-many-constraints', `约束数量 ${model.constraints.length} 超过上限 ${MAX_CONSTRAINTS}`, { suggestion: '拆分源文件后分批导入。' }), mapping, quarantined, warnings };
  }

  // ---- 循环依赖：确定性断开（隔离“回边”约束），保证无环数据进入当前布局 ----
  let guard = 0;
  while (guard++ < MAX_CONSTRAINTS + 5) {
    const cyc = findCycle(model.constraints);
    if (!cyc) break;
    // 回边 = 环上 cids 中 id 最大者（确定性、可解释：同图下永远断同一条）
    const edgeCid = [...cyc.cids].filter(Boolean).sort().pop();
    const idx = model.constraints.findIndex((x) => x.id === edgeCid);
    if (idx < 0) break;
    const removed = model.constraints.splice(idx, 1)[0];
    const names = cyc.nodeIds.map((rid) => model.rects.find((r) => r.id === rid)?.name || rid);
    q('constraint', '', removed.id, `${removed.kind} ${removed.rect}→${removed.other || ''}`,
      `该约束是循环依赖链上的回边（环：${names.join(' → ')}），已隔离以断开环`,
      '保留无环布局导入；如需该关系，请在当前布局中调整方向/优先级后手工添加（无环约束不会被隔离）。',
      { cycleNodeIds: cyc.nodeIds, cycleCids: cyc.cids, removedCid: removed.id });
    warnings.push({ level: 'warn', text: `为断开循环依赖隔离了约束「${removed.id}」（回边），其余约束保持不变。` });
  }

  // 矩形重命名记录（映射表统一在末尾按新 id 排序，保证字节稳定）
  for (const rl of renameLog) {
    const m = mapping.rects.find((x) => x.newId === idMap.get(rl.from));
    if (m) { m.reason = rl.reason; }
  }
  mapping.rects.sort((a, b) => (a.newId < b.newId ? -1 : 1));
  mapping.constraints.sort((a, b) => (a.newId < b.newId ? -1 : 1));

  // ---- 分支 / 版本引用（迁移报告用；不直接创建审计分支，导入时再建编辑分支） ----
  ir.branches.forEach((b, i) => mapping.branches.push({
    sourceId: b.id, sourceName: b.name, newId: null, newName: uniqueBranchishName(b.name),
    current: !!b.current || (i === 0 && !ir.branches.some((x) => x.current)),
    note: '源分支引用：迁移仅导入当前布局；导入为编辑分支时使用该名称（重名自动加后缀）。',
  }));
  if (!mapping.branches.length) mapping.branches.push({ sourceId: 'main', sourceName: '主分支', newId: null, newName: uniqueBranchishName(ir.name || '迁移布局'), current: true, note: '源文件无分支信息，按单一布局处理。' });
  ir.versions.forEach((v) => mapping.versions.push({
    sourceId: v.id, sourceName: v.name, hashRef: v.hashRef || null,
    status: v.current ? 'current' : 'recorded', note: v.current ? '该历史版本对应被迁移的当前布局' : '源文件中的历史版本引用（记录在报告中，不展开为布局）。',
  }));

  // 未知字段（去重 + 排序）
  const unk = new Map();
  for (const u of ir.unknown) {
    const key = `${u.path}|${u.field}`;
    if (!unk.has(key)) unk.set(key, { path: u.path, field: u.field, sample: u.sample, occurrences: 1 });
    else unk.get(key).occurrences++;
  }
  const unknownFields = [...unk.values()].sort((a, b) => (a.path + a.field < b.path + b.field ? -1 : 1));
  return { model, mapping, quarantined, warnings: warnings.concat(unknownFields.map((u) => ({ level: 'info', path: u.path, text: `无法识别的字段 ${u.path}.${u.field}${u.occurrences > 1 ? `（×${u.occurrences}）` : ''} 已忽略：${u.sample}` }))), unknownFields };
}

function usedReason(rawId) {
  return /^[A-Za-z0-9_-]+$/.test(rawId) ? '源 id 在当前命名空间冲突，按确定性规则追加 _migN 后缀' : '源 id 含非法字符，已清洗为合法 id';
}
function sanitizeToken(s, prefix) {
  const t = String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  return t || prefix;
}
function uniqueBranchishName(name) {
  return String(name || '迁移布局').slice(0, 40);
}
function pickRaw(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  try { return JSON.parse(JSON.stringify(raw)); } catch { return null; }
}

/* =====================================================================
 * 批次构造 / 状态推进
 * ===================================================================== */

/**
 * 建立批次（不启动运行器）。files 的 preview 已在导入 UI 时 dry-run 生成；
 * 相同 sourceHash 在批次内只保留第一份（重复文件不产生重复布局）。
 */
export function makeBatch({ id = uid('mb'), name, actor = '未署名', files = [], autoImport = false, t = Date.now() } = {}) {
  const seen = new Map();
  const fileList = [];
  const skippedDuplicates = [];
  for (const f of files) {
    if (seen.has(f.sourceHash)) {
      skippedDuplicates.push({ name: f.name, sourceHash: f.sourceHash, duplicateOf: seen.get(f.sourceHash) });
      continue;
    }
    seen.set(f.sourceHash, f.id);
    fileList.push({ ...f, status: f.status || 'queued' });
  }
  const batch = {
    id,
    name: String(name || '').trim() || `迁移批次 ${new Date(t).toLocaleString()}`,
    createdAt: t,
    updatedAt: t,
    actor: String(actor || '未署名'),
    runState: 'queued',
    autoImport: !!autoImport,
    files: fileList,
    skippedDuplicates,
    importedCount: 0,
  };
  reconcileBatchState(batch);
  return batch;
}

/** 从一个文本输入构造文件草稿并做 dry-run 预览（preview 与正式迁移同管线）。 */
export function ingestFile(rawText, { name = '', id = uid('mf'), size = null } = {}) {
  const sourceHash = sourceFingerprint(rawText);
  const preview = convertSource(rawText, { sourceName: name });
  return {
    id,
    name: name || '未命名文件',
    sourceHash,
    raw: String(rawText ?? ''),
    size: size ?? String(rawText ?? '').length,
    status: 'queued',
    detected: preview.format,
    confidence: preview.confidence,
    preview: serializePreview(preview),
    error: preview.ok ? null : preview.error,
    result: null,
    imported: null,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
  };
}

/** 预览只携带展示需要的结果（完整 model 也保留，供“正式迁移”免重算复核——但正式迁移仍以 convertSource 重算为准）。 */
function serializePreview(p) {
  if (!p) return null;
  return {
    ok: p.ok, format: p.format, confidence: p.confidence, name: p.name,
    hash: p.hash,
    counts: p.ok ? { rects: p.model.rects.length, constraints: p.model.constraints.length } : { rects: 0, constraints: 0 },
    mapping: p.mapping, quarantined: p.quarantined,
    warnings: p.warnings, unknownFields: p.unknownFields || [],
    error: p.error,
    model: p.ok ? structuredClone(p.model) : null,
  };
}

/** 正式执行一个文件：重算 convertSource（不依赖内存 preview），写入终态结果。 */
export function executeFile(batch, fileId, { now = Date.now() } = {}) {
  const f = batch.files.find((x) => x.id === fileId);
  if (!f) return { ok: false, error: '文件不在批次中' };
  if (f.status === 'done' || f.status === 'failed' || f.status === 'cancelled') return { ok: true, skipped: true, status: f.status };
  // 标记运行中（不调用 reconcile：批次 runState 保持 running，避免中途被误收敛为 paused）
  f.status = 'running';
  if (!f.startedAt) f.startedAt = now;
  f.attempts += 1;
  let res;
  try {
    res = convertSource(f.raw, { sourceName: f.name });
  } catch (e) {
    res = { ok: false, error: conversionError('convert-threw', `转换异常：${e.message}`, { suggestion: '该文件可能损坏；保留原始输入，可修正后重新提交为新批次。' }) };
  }
  f.detected = res.format;
  f.confidence = res.confidence;
  if (res.ok) {
    f.status = 'done';
    f.error = null;
    f.result = freeze({
      name: res.name,
      model: structuredClone(res.model),
      report: structuredClone(res.report),
      hash: res.hash,
      mapping: structuredClone(res.mapping),
      quarantined: structuredClone(res.quarantined),
      warnings: structuredClone(res.warnings),
    });
    f.finishedAt = now;
    // 成功后只保留截断的原始输入（失败文件保留完整原始输入）
    if (f.raw.length > MAX_RAW_KEPT) f.raw = f.raw.slice(0, MAX_RAW_KEPT);
  } else {
    f.status = 'failed';
    f.error = res.error;
    f.result = null;
    f.finishedAt = now;
    // 失败文件保留完整原始输入、错误位置与修复建议（raw 不截断）
  }
  batch.updatedAt = now;
  // 运行器处理文件之间：批次仍有排队项时保持 running（active），不误收敛为 paused
  reconcileBatchState(batch, { active: batch.runState === 'running' });
  return { ok: true, status: f.status, result: f.result, error: f.error };
}

/**
 * 依据各文件状态推导一致的批次级状态。
 * active=true（运行器存活、文件之间）时：runState=running 且仍有排队文件则保持 running，
 * 绝不把进行中的批次误收敛为 paused；加载清洗（active 缺省）时 running 收敛为 paused。
 */
export function reconcileBatchState(batch, { active = false } = {}) {
  const fs = batch.files || [];
  const has = (s) => fs.some((f) => f.status === s);
  if (has('running')) { batch.runState = 'running'; return batch.runState; }
  const pending = fs.some((f) => f.status === 'queued');
  // 取消是终态：一旦取消且无运行中文件，后续 reconcile 绝不翻回 done（完成项保留、排队项已取消）
  if (batch.runState === 'cancelled') { batch.runState = 'cancelled'; return batch.runState; }
  // 取消在落盘前未收尾：排队项一律收敛为已取消
  if (batch.runState === 'cancelling') {
    for (const f of fs) if (f.status === 'queued') f.status = 'cancelled';
    batch.runState = 'cancelled';
    return batch.runState;
  }
  if (!pending) { batch.runState = 'done'; return batch.runState; } // 逐文件成败独立：有失败也算批次运行结束
  if (active && batch.runState === 'running') return batch.runState; // 运行器仍在：保持 running
  if (batch.runState === 'running' || batch.runState === 'paused') { batch.runState = 'paused'; return batch.runState; }
  batch.runState = 'queued';
  return batch.runState;
}

export function batchCounters(batch) {
  const c = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: batch.files.length, imported: batch.importedCount || 0 };
  for (const f of batch.files) c[f.status] = (c[f.status] || 0) + 1;
  c.succeeded = c.done;
  c.terminal = c.done + c.failed + c.cancelled;
  c.progress = c.total ? c.terminal / c.total : 0;
  return c;
}

/** 取消：排队文件进入 cancelled 终态（done/failed 保留），批次终态 cancelled。 */
export function cancelBatchState(batch) {
  for (const f of batch.files) if (f.status === 'queued' || f.status === 'running') f.status = 'cancelled';
  batch.runState = 'cancelled';
  batch.updatedAt = Date.now();
  return batch;
}

/* =====================================================================
 * 导入为新的编辑分支后的差异摘要
 * ===================================================================== */

/**
 * 迁移结果相对“当前编辑分支 head”的差异摘要（矩形/约束/冲突，compareVersions 式）。
 * targetEntry = { model, report, hash }（导入时的分支起点）；from = 迁移结果。
 */
export function migrationDiff(targetEntry, result) {
  const after = { model: result.model, report: result.report, hash: result.hash };
  return compareVersions(targetEntry, after);
}

/* =====================================================================
 * 迁移报告（导出）
 * ===================================================================== */

/**
 * 构造迁移报告：源摘要 + 映射表 + 隔离项 + 错误 + 最终分支标识 + FNV 校验和。
 * 键名递归排序，保证逐字节确定（同 experiments hash32 算法）。
 */
export function buildMigrationReport(batch, { generatedAt = Date.now(), branchesById = new Map() } = {}) {
  const c = batchCounters(batch);
  const files = batch.files.map((f) => {
    const r = f.result;
    const imp = f.imported || null;
    return {
      name: f.name,
      sourceHash: f.sourceHash,
      size: f.size,
      detectedFormat: f.detected || f.preview?.format || null,
      confidence: f.confidence ?? f.preview?.confidence ?? null,
      status: f.status,
      attempts: f.attempts || 0,
      error: f.error ? {
        code: f.error.code, message: f.error.message,
        line: f.error.line ?? null, column: f.error.column ?? null,
        suggestion: f.error.suggestion || '',
      } : null,
      result: r ? {
        name: r.name,
        hash: r.hash,
        rects: r.model.rects.length,
        constraints: r.model.constraints.length,
        mapping: r.mapping,
        quarantined: (r.quarantined || []).map((q) => ({
          kind: q.kind, path: q.path, sourceId: q.sourceId, name: q.name,
          reason: q.reason, suggestion: q.suggestion,
          ...(q.missingRef ? { missingRef: q.missingRef, field: q.field } : {}),
          ...(q.cycleNodeIds ? { cycleNodeIds: q.cycleNodeIds } : {}),
        })),
        ignoredFields: (r.warnings || []).filter((w) => w.level === 'info').map((w) => ({ path: w.path || '', text: w.text })),
        warnings: (r.warnings || []).filter((w) => w.level === 'warn').map((w) => w.text),
      } : null,
      imported: imp ? {
        at: imp.at, by: imp.by || '',
        branchId: imp.branchId, branchName: imp.branchName, eventId: imp.eventId,
        diff: summarizeDiff(imp.diff),
      } : null,
    };
  });
  const report = {
    kind: 'legacy-layout-migration-report',
    schema: 1,
    generatedAt,
    batch: {
      id: batch.id, name: batch.name, actor: batch.actor,
      createdAt: batch.createdAt, updatedAt: batch.updatedAt,
      runState: batch.runState, autoImport: !!batch.autoImport,
    },
    summary: {
      total: c.total, queued: c.queued, running: c.running,
      succeeded: c.done, failed: c.failed, cancelled: c.cancelled,
      imported: c.imported,
      duplicateSourcesSkipped: (batch.skippedDuplicates || []).length,
    },
    skippedDuplicates: batch.skippedDuplicates || [],
    files,
    // 分支标识：包含该批次每份文件实际导入（含跨批次幂等导入：同一源内容只可能有一个分支，
    // 其分支可能由更早的批次创建）的分支；按文件 sourceHash 匹配，而不仅按批次 id。
    branches: (() => {
      const wantedHashes = new Set(batch.files.filter((f) => f.imported).map((f) => f.sourceHash));
      const out = [];
      for (const b of branchesById.values()) {
        if (b?.source?.kind === 'migration' && (b.source.migrationBatchId === batch.id || wantedHashes.has(b.source.sourceFileHash))) {
          out.push({
            id: b.id, name: b.name, headEventId: b.headEventId,
            sourceFileHash: b.source.sourceFileHash || null,
            createdByBatchId: b.source.migrationBatchId,
            idempotentFromEarlierBatch: b.source.migrationBatchId !== batch.id,
          });
        }
      }
      out.sort((a, b) => (a.id < b.id ? -1 : 1));
      return out;
    })(),
  };
  const canon = stableStringify(report);
  report.checksum = hash32(canon);
  return report;
}

function summarizeDiff(d) {
  if (!d) return null;
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  return {
    identical: !!d.identical,
    hashBefore: d.hashBefore, hashAfter: d.hashAfter,
    rects: {
      added: n(d.rects?.added), removed: n(d.rects?.removed),
      moved: n(d.rects?.moved), resized: n(d.rects?.resized),
    },
    constraints: {
      added: n(d.constraints?.added), removed: n(d.constraints?.removed), changed: n(d.constraints?.changed),
    },
    conflicts: { before: d.conflicts?.before ?? 0, after: d.conflicts?.after ?? 0 },
  };
}

/** 递归排序键名的稳定 JSON（与服务端 sort_keys 语义一致）。 */
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

/* =====================================================================
 * 加载清洗 / 损坏容忍
 * ===================================================================== */

/**
 * 清洗持久化迁移批次：
 * - 结构损坏的批次整条跳过并告警；
 * - running 的文件视为“已开始未落盘”，回到 queued；批次 running 收敛为 paused（完成项不丢、顺序不变）；
 * - cancelling 收敛为 cancelled；
 * - 已完成结果重算指纹校验，损坏只标该文件（其余文件不受影响）；
 * - 失败文件必须保留原始输入（raw 缺失时用占位并告警）。
 */
export function sanitizeMigrations(raw, warnings = []) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b0 of raw) {
    if (!b0 || typeof b0 !== 'object' || typeof b0.id !== 'string' || !Array.isArray(b0.files)) {
      warnings.push({ level: 'error', text: '一个迁移批次记录结构损坏，已跳过（其余批次不受影响）' });
      continue;
    }
    const tag = `迁移批次「${b0.name || b0.id}」`;
    const seenHash = new Set();
    const files = [];
    for (const f0 of b0.files) {
      if (!f0 || typeof f0 !== 'object' || typeof f0.id !== 'string') {
        warnings.push({ level: 'error', text: `${tag} 含损坏的文件记录，已跳过该文件` });
        continue;
      }
      const f = {
        id: f0.id,
        name: typeof f0.name === 'string' ? f0.name : '未命名文件',
        sourceHash: typeof f0.sourceHash === 'string' ? f0.sourceHash : '',
        raw: typeof f0.raw === 'string' ? f0.raw : '',
        size: Number.isFinite(f0.size) ? f0.size : (f0.raw || '').length,
        status: FILE_STATUSES.includes(f0.status) ? f0.status : 'queued',
        detected: typeof f0.detected === 'string' ? f0.detected : (f0.preview?.format || null),
        confidence: Number.isFinite(f0.confidence) ? f0.confidence : (f0.preview?.confidence ?? null),
        preview: f0.preview && typeof f0.preview === 'object' ? f0.preview : null,
        error: f0.error && typeof f0.error === 'object' ? f0.error : null,
        result: null,
        imported: f0.imported && typeof f0.imported === 'object' ? f0.imported : null,
        attempts: Number.isFinite(f0.attempts) ? Math.max(0, Math.floor(f0.attempts)) : 0,
        startedAt: Number.isFinite(f0.startedAt) ? f0.startedAt : null,
        finishedAt: Number.isFinite(f0.finishedAt) ? f0.finishedAt : null,
      };
      if (f.status === 'failed' && !f.raw) {
        warnings.push({ level: 'error', text: `${tag} 的失败文件「${f.name}」原始输入丢失，仅保留错误记录` });
      }
      // 重启一致性：running = 已开始未落盘 -> 回 queued
      if (f.status === 'running') f.status = 'queued';
      if (b0.runState === 'cancelling' && (f.status === 'queued' || f.status === 'running')) f.status = 'cancelled';
      if (f.status === 'done') {
        const checked = checkMigrationResult(f0.result, f, tag, warnings);
        if (checked.corrupt) {
          f.status = 'failed';
          f.error = { code: 'result-corrupt', message: checked.reason, line: null, column: null, suggestion: '持久化结果校验失败；原始输入保留，可重新提交迁移。' };
          f.result = null;
        } else {
          f.result = checked.result;
        }
      }
      // 同批次内相同源内容（异常合流时）只保留第一份
      if (seenHash.has(f.sourceHash)) continue;
      if (f.sourceHash) seenHash.add(f.sourceHash);
      files.push(f);
    }
    files.sort((a, b) => (a.id < b.id ? -1 : 1) || 0);
    // 保持入批顺序：若有 order 字段则按 order（ingest 顺序即数组顺序，清洗后沿用原序）
    const order = new Map((b0.files || []).map((x, i) => [x?.id, i]));
    files.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const batch = {
      id: b0.id,
      name: typeof b0.name === 'string' && b0.name ? b0.name : b0.id,
      createdAt: Number.isFinite(b0.createdAt) ? b0.createdAt : 0,
      updatedAt: Number.isFinite(b0.updatedAt) ? b0.updatedAt : 0,
      actor: typeof b0.actor === 'string' ? b0.actor : '未知操作者',
      runState: b0.runState,
      autoImport: !!b0.autoImport,
      files,
      skippedDuplicates: Array.isArray(b0.skippedDuplicates) ? b0.skippedDuplicates : [],
      importedCount: Number.isFinite(b0.importedCount) ? b0.importedCount : files.filter((f) => f.imported).length,
    };
    // 刷新/重启瞬间仍在运行：running 文件已回排队，批次收敛为已暂停，并打 interrupted 标记
    // （区别于用户主动暂停），Store 加载后据此从已完成文件之后自动续跑。
    if (b0.runState === 'running' && files.some((f) => f.status === 'queued')) batch.interrupted = true;
    reconcileBatchState(batch);
    out.push(batch);
  }
  return out;
}

function checkMigrationResult(r0, f, tag, warnings) {
  const ftag = `${tag} / 文件「${f.name}」`;
  if (!r0 || typeof r0 !== 'object' || !r0.model || !r0.report) {
    warnings.push({ level: 'error', text: `${ftag} 的迁移结果缺失或结构损坏` });
    return { corrupt: true, reason: '迁移结果缺失或结构损坏' };
  }
  const { errors } = validate(r0.model);
  if (errors.length) {
    warnings.push({ level: 'error', text: `${ftag} 的结果校验失败：${errors[0]}` });
    return { corrupt: true, reason: `结果校验失败：${errors[0]}` };
  }
  let model, report;
  try {
    model = normalize(r0.model);
    report = solve(model, null);
  } catch (e) {
    warnings.push({ level: 'error', text: `${ftag} 的结果重算失败：${e.message}` });
    return { corrupt: true, reason: `结果重算失败：${e.message}` };
  }
  const storedHash = typeof r0.hash === 'string' && r0.hash ? r0.hash : r0.report?.hash;
  if (!storedHash || report.hash !== storedHash) {
    warnings.push({ level: 'error', text: `${ftag} 指纹校验失败（记录 ${(storedHash || '缺失').slice(0, 8)} / 重算 ${report.hash.slice(0, 8)}）` });
    return { corrupt: true, reason: `指纹不一致：记录 ${(storedHash || '缺失').slice(0, 8)}，重算 ${report.hash.slice(0, 8)}` };
  }
  if (findCycle(model.constraints)) {
    warnings.push({ level: 'error', text: `${ftag} 的结果含循环依赖，隔离保证被破坏` });
    return { corrupt: true, reason: '迁移结果含循环依赖' };
  }
  return {
    corrupt: false,
    result: freeze({
      name: r0.name || f.name,
      model, report, hash: report.hash,
      mapping: r0.mapping && typeof r0.mapping === 'object' ? r0.mapping : emptyMapping(),
      quarantined: Array.isArray(r0.quarantined) ? r0.quarantined : [],
      warnings: Array.isArray(r0.warnings) ? r0.warnings : [],
    }),
  };
}

/* =====================================================================
 * 跨页面合流（server.py 与此同构）
 * ===================================================================== */

const FILE_RANK = { queued: 0, running: 1, cancelled: 2, failed: 3, done: 4 };

/**
 * 迁移批次合流：批次按 id 并集；同批次文件按 id 合并，“走得更远”的状态胜出
 * （done > failed > cancelled > running > queued）；完成结果不可降级覆盖；
 * 导入记录（imported）按 eventId 并集。定义类字段以先出现者（服务端）为准。
 */
export function mergeMigrations(serverList, clientList) {
  const norm = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []));
  const byId = new Map();
  for (const b of norm(serverList)) if (b && typeof b === 'object' && b.id) byId.set(b.id, b);
  for (const c of norm(clientList)) {
    if (!c || typeof c !== 'object' || !c.id) continue;
    const s = byId.get(c.id);
    if (!s) { byId.set(c.id, c); continue; }
    byId.set(c.id, mergeOneBatch(s, c));
  }
  return [...byId.values()];
}

function mergeOneBatch(s, c) {
  const sf = new Map((s.files || []).map((f) => [f.id, f]));
  const order = (s.files || []).map((f) => f.id);
  for (const cf of c.files || []) {
    if (!sf.has(cf.id)) { sf.set(cf.id, cf); if (!order.includes(cf.id)) order.push(cf.id); continue; }
    sf.set(cf.id, mergeFile(sf.get(cf.id), cf));
  }
  const files = order.map((id) => sf.get(id));
  const sDone = (s.files || []).filter((f) => ['done', 'failed', 'cancelled'].includes(f.status)).length;
  const cDone = (c.files || []).filter((f) => ['done', 'failed', 'cancelled'].includes(f.status)).length;
  const winner = cDone > sDone ? c : s;
  const merged = {
    ...s,
    files,
    updatedAt: Math.max(Number(s.updatedAt) || 0, Number(c.updatedAt) || 0),
    importedCount: Math.max(Number(s.importedCount) || 0, Number(c.importedCount) || 0),
    skippedDuplicates: dedupByKey([...(s.skippedDuplicates || []), ...(c.skippedDuplicates || [])], (x) => x.sourceHash + '|' + x.duplicateOf),
  };
  merged.runState = reconcileBatchState({ ...winner, files }).runState;
  return merged;
}

function mergeFile(a, b) {
  const rank = (f) => FILE_RANK[f.status] ?? 0;
  const win = rank(b) > rank(a) ? b : a;
  const out = {
    ...a,
    name: a.name,
    sourceHash: a.sourceHash,
    raw: a.raw || b.raw || '',
    size: Number.isFinite(a.size) ? a.size : b.size,
    preview: a.preview || b.preview || null,
    status: win.status,
    error: win.error ?? a.error ?? null,
    detected: win.detected ?? a.detected ?? null,
    confidence: win.confidence ?? a.confidence ?? null,
    attempts: Math.max(a.attempts || 0, b.attempts || 0),
    startedAt: a.startedAt || b.startedAt || null,
    finishedAt: a.finishedAt || b.finishedAt || null,
    result: null,
  };
  const goodA = a.result || null;
  const goodB = b.result || null;
  out.result = goodA || goodB || null;
  // 导入记录：导入为编辑分支是幂等操作（同内容 -> 确定性分支 id），取 at 更大者并保留任一非空
  const impA = a.imported || null;
  const impB = b.imported || null;
  out.imported = (impA && impB) ? (impB.at > impA.at ? impB : impA) : (impA || impB);
  return out;
}

function dedupByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}
