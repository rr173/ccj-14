/*
 * 参数化约束模板（纯函数，无 DOM / 存储依赖）。
 *
 * 模板 template：
 *   {
 *     id, name, createdAt, updatedAt,
 *     draftRev,                         // 草稿乐观锁（发布不改写草稿，仅草稿编辑 +1）
 *     draft: { slots:[...], constraints:[...] } | null,   // 未发布时为草稿
 *     versions: [ {no, createdAt, slots, constraints} ], // 只读、不可改写
 *     publishedNo: 0,
 *   }
 *
 * 槽位 slot：{ id, label } —— 用具名槽位代替具体矩形。
 * 模板约束 tplConstraint（与模型约束同构，但 rect/other 引用槽位 id）：
 *   { key, kind, rect, other?, axis?, edge?, otherEdge?, side?,
 *     gap?, margin?, w?, h?, priority, enabled,
 *     overrides: { gap?:{def}, edge?:{def}, otherEdge?:{def}, side?:{def},
 *                  margin?:{def}, w?:{def}, h?:{def}, priority:{def} } }
 * 每个参数形如 { value, overridable }：value 是模板默认值，overridable 声明该参数
 * 允许在实例中覆盖。
 *
 * 实例 instance（文档级，随文档持久化；与具体分支的“链接”由模型约束上的 tpl 标签派生）：
 *   {
 *     id, templateId, templateName, versionNo,
 *     mapping: { slotId: rectId },             // 每个槽位绑定一个矩形
 *     params: { key: { field: value } },       // 实例参数覆盖
 *     constraintIds: [cid...],                 // 最近一次生效时生成的约束 id（升级后替换）
 *     mapHash,                                 // 幂等键：同模板版本 + 同槽位映射
 *     status: 'linked' | 'detached',           // detach 后记录保留为 detached（墓碑）
 *     pinned: { [versionNo]: true },           // 用户明确“继续固定旧版本”
 *     history: [ {t, action, fromNo, toNo, error?} ],
 *     createdAt, updatedAt,
 *   }
 *
 * 模型约束上的标签：c.tpl = { instanceId, templateId, versionNo, key, pin }
 * 实例在某分支上是否链接、固定与否，全部由【当前模型约束的标签】派生 —— 这样
 * undo/redo（沿事件链移动 head）时，约束与实例链接状态天然同一状态，无需事后修补。
 */

import { validate, normalize as modelNormalize } from './model.js';
import { findCycle, solve, constraintAxis } from './solver.js';

export const TEMPLATE_KIND = 'tpl';

/* ---------------- 基础工具 ---------------- */

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clampPrio = (p) => Math.min(999, Math.max(1, Math.round(num(p, 50))));
const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

/** 合法槽位 id：字母/数字/下划线/短横，1–24 字符，且不以 $ 开头。 */
export function isValidSlotId(id) {
  return typeof id === 'string' && /^[A-Za-z一-鿿0-9_-]{1,24}$/.test(id) && !id.startsWith('$');
}

/* ---------------- 从选区抽取模板 ---------------- */

const PARAM_FIELDS = {
  snap: ['gap', 'edge', 'otherEdge', 'priority'],
  minGap: ['gap', 'side', 'priority'],
  contain: ['margin', 'priority'],
  lock: ['w', 'h', 'priority'],
};

/**
 * 从当前模型里被选中的一组矩形与其间的约束，构造模板草稿。
 * @param model 规范化模型
 * @param rectIds 选中的矩形 id（去重后即槽位）
 * @returns {ok, draft?, errors?}  draft = { slots, constraints }
 */
export function extractDraft(model, rectIds) {
  const ids = [...new Set(rectIds || [])].filter((id) => (model.rects || []).some((r) => r.id === id));
  const errors = [];
  if (ids.length < 1) errors.push('请至少选择一个矩形');
  if (ids.length > 40) errors.push('模板最多包含 40 个槽位');
  // 只纳入“跟随矩形”被选中的约束；贴齐/间距的锚点也必须在选区内
  const picked = [];
  for (const c of model.constraints || []) {
    if (!ids.includes(c.rect)) continue;
    if ((c.kind === 'snap' || c.kind === 'minGap') && !ids.includes(c.other)) {
      errors.push(`约束 ${c.id} 的锚点矩形不在选区内（模板不能引用选区外矩形）`);
      continue;
    }
    picked.push(c);
  }
  if (!picked.length) errors.push('所选矩形之间没有可保存为模板的约束');
  if (errors.length) return { ok: false, errors };

  // 槽位 id：用矩形名清洗，冲突/非法时确定性回退 slotN
  const usedNames = new Set();
  const slotOf = new Map();
  ids.forEach((rid, i) => {
    const r = (model.rects || []).find((x) => x.id === rid);
    let base = String(r?.name || '').trim().toLowerCase()
      .replace(/[^a-z0-9一-鿿_-]/g, '').slice(0, 16);
    if (!base || !isValidSlotId(base) || usedNames.has(base)) {
      base = `slot${i + 1}`;
      let n = 2;
      while (usedNames.has(base)) base = `slot${i + 1}_${n++}`;
    }
    usedNames.add(base);
    slotOf.set(rid, base);
  });

  const constraints = picked.map((c, i) => tplConstraintFrom(c, slotOf, i));
  const slots = ids.map((rid) => ({
    id: slotOf.get(rid),
    label: String((model.rects || []).find((r) => r.id === rid)?.name || slotOf.get(rid)),
  }));

  const draft = normalizeDraft({ slots, constraints });
  const v = validateDraft(draft);
  if (v.length) return { ok: false, errors: v };
  return { ok: true, draft };
}

function tplConstraintFrom(c, slotOf, i) {
  const key = `k${i + 1}`;
  const base = {
    key,
    kind: c.kind,
    rect: slotOf.get(c.rect),
    priority: clampPrio(c.priority),
    enabled: c.enabled !== false,
  };
  const overrides = { priority: { value: clampPrio(c.priority), overridable: true } };
  if (c.kind === 'snap') {
    Object.assign(base, {
      other: slotOf.get(c.other), axis: c.axis, edge: c.edge, otherEdge: c.otherEdge,
      gap: round3(num(c.gap)),
    });
    overrides.gap = { value: round3(num(c.gap)), overridable: true };
    overrides.edge = { value: c.edge, overridable: false };
    overrides.otherEdge = { value: c.otherEdge, overridable: false };
  } else if (c.kind === 'minGap') {
    Object.assign(base, { other: slotOf.get(c.other), side: c.side, gap: round3(num(c.gap)) });
    overrides.gap = { value: round3(num(c.gap)), overridable: true };
    overrides.side = { value: c.side, overridable: false };
  } else if (c.kind === 'contain') {
    Object.assign(base, { margin: round3(num(c.margin)) });
    overrides.margin = { value: round3(num(c.margin)), overridable: true };
  } else if (c.kind === 'lock') {
    Object.assign(base, { w: round3(num(c.w)), h: round3(num(c.h)) });
    overrides.w = { value: round3(num(c.w)), overridable: true };
    overrides.h = { value: round3(num(c.h)), overridable: true };
  }
  return { ...base, overrides };
}

/* ---------------- 草稿编辑 / 校验 / 规范化 ---------------- */

/** 切换某个参数是否允许在实例中覆盖（仅改草稿）。 */
export function setOverridable(draft, key, field, flag) {
  const d = structuredClone(draft);
  const c = d.constraints.find((x) => x.key === key);
  if (!c || !c.overrides?.[field]) return d;
  c.overrides[field] = { ...c.overrides[field], overridable: !!flag };
  return normalizeDraft(d);
}

export function setDraftParamDefault(draft, key, field, value) {
  const d = structuredClone(draft);
  const c = d.constraints.find((x) => x.key === key);
  if (!c || !c.overrides?.[field]) return d;
  c.overrides[field] = { ...c.overrides[field], value: coerceParam(c.kind, field, value) };
  return normalizeDraft(d);
}

function coerceParam(kind, field, value) {
  if (field === 'priority') return clampPrio(value);
  if (['gap', 'margin', 'w', 'h'].includes(field)) return round3(Math.max(0, num(value)));
  return value; // edge / side 枚举
}

/** 规范化草稿（补全 overrides、稳定排序、取整），保证字节稳定。 */
export function normalizeDraft(draft) {
  const slots = (draft?.slots || []).map((s) => ({ id: String(s.id), label: String(s.label || s.id) }));
  const constraints = (draft?.constraints || []).map((c) => {
    const out = {
      key: String(c.key), kind: c.kind, rect: String(c.rect),
      priority: clampPrio(c.priority), enabled: c.enabled !== false,
      overrides: structuredClone(c.overrides || {}),
    };
    if (c.kind === 'snap') {
      out.other = String(c.other); out.axis = c.axis; out.edge = c.edge;
      out.otherEdge = c.otherEdge; out.gap = round3(num(c.gap));
    } else if (c.kind === 'minGap') {
      out.other = String(c.other); out.side = c.side; out.gap = round3(num(c.gap));
    } else if (c.kind === 'contain') {
      out.margin = round3(num(c.margin));
    } else {
      out.w = round3(num(c.w)); out.h = round3(num(c.h));
    }
    // 确保 overrides 含全部参数字段
    for (const f of PARAM_FIELDS[out.kind] || []) {
      if (!out.overrides[f]) {
        const dv = f === 'priority' ? out.priority
          : f === 'gap' ? out.gap : f === 'margin' ? out.margin
          : f === 'w' ? out.w : f === 'h' ? out.h
          : f === 'edge' ? out.edge : f === 'otherEdge' ? out.otherEdge : out.side;
        out.overrides[f] = { value: dv, overridable: f === 'priority' };
      } else {
        out.overrides[f] = {
          value: coerceParam(out.kind, f, out.overrides[f].value),
          overridable: out.overrides[f].overridable === true,
        };
      }
    }
    return out;
  });
  return { slots, constraints };
}

/** 草稿结构/语义校验：槽位唯一、约束引用合法、无自贴齐等。返回错误字符串数组。 */
export function validateDraft(draft) {
  const errors = [];
  const slots = draft?.slots || [];
  const slotIds = new Set();
  for (const s of slots) {
    if (!isValidSlotId(s.id)) { errors.push(`非法槽位 id：${s.id}`); continue; }
    if (slotIds.has(s.id)) errors.push(`槽位 id 重复：${s.id}`);
    slotIds.add(s.id);
  }
  const keys = new Set();
  for (const c of draft?.constraints || []) {
    const tag = `模板约束 ${c.key || '?'}`;
    if (!c.key || keys.has(c.key)) errors.push(`${tag} 的 key 缺失或重复`);
    keys.add(c.key);
    if (!slotIds.has(c.rect)) errors.push(`${tag} 跟随槽位 ${c.rect} 不存在（悬空引用）`);
    if (c.kind === 'snap') {
      if (!slotIds.has(c.other)) errors.push(`${tag} 锚点槽位 ${c.other} 不存在（悬空引用）`);
      if (!['x', 'y'].includes(c.axis)) errors.push(`${tag} 轴非法`);
      const EDGES = new Set(['l', 'r', 't', 'b', 'mid']);
      if (!EDGES.has(c.edge) || !EDGES.has(c.otherEdge)) errors.push(`${tag} 边非法`);
      if (c.rect === c.other && c.edge === c.otherEdge) errors.push(`${tag} 自贴齐无意义`);
      if (!(num(c.gap) >= 0)) errors.push(`${tag} 偏移不能为负`);
    } else if (c.kind === 'minGap') {
      if (!slotIds.has(c.other)) errors.push(`${tag} 锚点槽位 ${c.other} 不存在（悬空引用）`);
      if (!new Set(['left', 'right', 'above', 'below']).has(c.side)) errors.push(`${tag} 方向非法`);
      if (!(num(c.gap) >= 0)) errors.push(`${tag} 间距不能为负`);
    } else if (c.kind === 'contain') {
      if (!(num(c.margin) >= 0)) errors.push(`${tag} 边距不能为负`);
    } else if (c.kind === 'lock') {
      if (!(num(c.w) > 0) || !(num(c.h) > 0)) errors.push(`${tag} 锁定尺寸非法`);
    } else {
      errors.push(`${tag} 类型未知`);
    }
  }
  // 模板自身（把槽位当成节点）不得有环：发布前就拦住，避免每个实例都成环
  const cycle = templateCycle(draft);
  if (cycle) errors.push(`模板约束存在循环依赖：${cycle.join(' → ')}`);
  return [...new Set(errors)];
}

/** 把模板槽位当作节点做环检测（确定性 DFS），返回闭环槽位序列或 null。 */
export function templateCycle(draft) {
  const adj = new Map();
  for (const s of draft?.slots || []) adj.set(s.id, []);
  for (const c of draft?.constraints || []) {
    if (c.enabled === false) continue;
    if (c.kind === 'snap' || c.kind === 'minGap') {
      if (!adj.has(c.rect)) adj.set(c.rect, []);
      if (!adj.has(c.other)) adj.set(c.other, []);
      adj.get(c.rect).push({ to: c.other, key: c.key });
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...adj.keys()].sort().map((n) => [n, WHITE]));
  const dfs = (u, stack) => {
    color.set(u, GRAY);
    const outs = (adj.get(u) || []).slice().sort((a, b) =>
      a.to === b.to ? (a.key < b.key ? -1 : 1) : a.to < b.to ? -1 : 1);
    for (const e of outs) {
      if (color.get(e.to) === GRAY) return [...stack.slice(stack.indexOf(e.to)), e.to];
      if (color.get(e.to) === WHITE) {
        stack.push(e.to);
        const hit = dfs(e.to, stack);
        if (hit) return hit;
        stack.pop();
      }
    }
    color.set(u, BLACK);
    return null;
  };
  for (const n of [...adj.keys()].sort()) {
    if (color.get(n) === WHITE) {
      const hit = dfs(n, [n]);
      if (hit) return hit;
    }
  }
  return null;
}

/* ---------------- 发布版本（不可变） ---------------- */

/**
 * 发布草稿为新版本：版本内容深冻结，绝不改写既有版本与“已应用版本”。
 * @returns {ok, version?, number?}
 */
export function publishVersion(template, { now = Date.now() } = {}) {
  const draft = template?.draft;
  if (!draft) return { ok: false, error: '没有可发布的草稿' };
  const errors = validateDraft(draft);
  if (errors.length) return { ok: false, error: errors[0], errors };
  const no = (template.publishedNo || (template.versions || []).length) + 1;
  const version = {
    no, createdAt: now,
    slots: structuredClone(draft.slots),
    constraints: structuredClone(draft.constraints),
  };
  return { ok: true, version, no };
}

export function templateVersion(template, no) {
  return (template?.versions || []).find((v) => v.no === no) || null;
}

/* ---------------- 实例化：槽位映射 + 参数覆盖 ---------------- */

/** 规范化槽位映射 {slotId: rectId}，按键排序，供幂等指纹使用。 */
export function normalizeMapping(mapping) {
  const out = {};
  for (const k of Object.keys(mapping || {}).sort()) out[k] = String(mapping[k]);
  return out;
}

/**
 * 幂等指纹：同模板 + 同版本 + 同槽位映射（忽略矩形名字/参数覆盖）。
 * 同一模板版本重复应用到同一组槽位映射时不产生重复实例。
 */
export function mappingFingerprint(templateId, versionNo, mapping) {
  const m = normalizeMapping(mapping);
  const canonical = JSON.stringify({ t: templateId, v: versionNo, m: Object.entries(m) });
  return fnv1a(canonical);
}

/**
 * 校验槽位映射：槽位缺失、矩形不存在、重复占用、悬空引用等。
 * @returns errors:[{code,message,slot?}]
 */
export function validateMapping(version, model, mapping) {
  const errors = [];
  const rectById = new Map((model.rects || []).map((r) => [r.id, r]));
  const assigned = new Map(); // rectId -> slotId
  for (const s of version.slots) {
    const rid = mapping?.[s.id];
    if (!rid) {
      errors.push({ code: 'slot-missing', slot: s.id, message: `槽位「${s.label || s.id}」还没有匹配矩形` });
      continue;
    }
    if (!rectById.has(rid)) {
      errors.push({ code: 'slot-dangling', slot: s.id, message: `槽位「${s.label || s.id}」匹配的矩形 ${rid} 已不存在（悬空引用）` });
      continue;
    }
    if (assigned.has(rid)) {
      errors.push({
        code: 'slot-duplicate', slot: s.id,
        message: `矩形 ${rectById.get(rid).name || rid} 被槽位「${assigned.get(rid)}」和「${s.label || s.id}」重复占用`,
      });
      continue;
    }
    assigned.set(rid, s.id);
  }
  return errors;
}

/** 规范化实例参数覆盖：剔除模板未声明 overridable / 已不存在的字段，返回 {params,dropped}。 */
export function normalizeParams(version, params) {
  const out = {};
  const dropped = [];
  for (const c of version.constraints) {
    const pp = params?.[c.key];
    if (!pp) continue;
    const kept = {};
    for (const [field, value] of Object.entries(pp)) {
      const spec = c.overrides?.[field];
      if (!spec || !spec.overridable) { dropped.push({ key: c.key, field }); continue; }
      kept[field] = coerceParam(c.kind, field, value);
    }
    if (Object.keys(kept).length) out[c.key] = kept;
  }
  return { params: out, dropped };
}

/** 取某模板约束在实例中的生效参数（覆盖优先，否则模板默认）。 */
function effectiveFields(c, params) {
  const get = (field) => {
    const spec = c.overrides?.[field];
    const ov = params?.[field];
    if (ov !== undefined && spec?.overridable) return coerceParam(c.kind, field, ov);
    return spec ? spec.value : c[field];
  };
  return {
    priority: clampPrio(get('priority')),
    gap: c.kind === 'snap' || c.kind === 'minGap' ? round3(num(get('gap'))) : undefined,
    margin: c.kind === 'contain' ? round3(num(get('margin'))) : undefined,
    w: c.kind === 'lock' ? round3(num(get('w'))) : undefined,
    h: c.kind === 'lock' ? round3(num(get('h'))) : undefined,
  };
}

/**
 * 由模板版本 + 槽位映射 + 参数覆盖，生成将要加入模型的具体约束对象（带 tpl 标签）。
 * cidOf(key) 为每条模板约束提供稳定的实例内约束 id（同实例升级时沿用，便于原地替换）。
 */
export function instantiateConstraints(version, mapping, params, { instanceId, templateId, pin = false, cidOf }) {
  return version.constraints.map((c) => {
    const eff = effectiveFields(c, params?.[c.key]);
    const id = cidOf(c.key);
    const tag = { instanceId, templateId, versionNo: version.no, key: c.key, pin: !!pin };
    const base = {
      id, kind: c.kind, rect: mapping[c.rect], priority: eff.priority,
      enabled: c.enabled !== false, tpl: tag,
    };
    if (c.kind === 'snap') {
      return { ...base, other: mapping[c.other], axis: c.axis, edge: c.edge, otherEdge: c.otherEdge, gap: eff.gap };
    }
    if (c.kind === 'minGap') {
      return { ...base, other: mapping[c.other], side: c.side, gap: eff.gap };
    }
    if (c.kind === 'contain') return { ...base, margin: eff.margin };
    return { ...base, w: eff.w, h: eff.h };
  });
}

/* ---------------- 应用 / 升级预览（新增/替换/保留 + 求解差异） ---------------- */

/**
 * 计算把某实例（新版本或首次应用）放入模型后的完整计划与求解结果。
 * 纯函数，不修改入参；任何非法情形都在 errors 中给出，调用方据此阻止创建实例。
 *
 * @returns {
 *   ok, errors:[{code,message,detail?}],
 *   constraints:[...],          // 实例生效后的具体约束（带 tpl 标签）
 *   changes:{added,replaced,removed,kept},  // 相对现有实例约束（首次应用全为 added）
 *   model, report, cycle,       // 求解后的模型（已固化不动点）与报告
 *   params, dropped,            // 规范化后的覆盖与被丢弃的过期覆盖
 * }
 */
export function planInstance({
  template, version, model, mapping, params = {}, instanceId,
  existing = null, pin = false, cidPrefix, makeCid,
}) {
  const errors = [];
  const rectById = new Map((model.rects || []).map((r) => [r.id, r]));

  // 1) 槽位映射
  for (const e of validateMapping(version, model, mapping)) errors.push(e);

  // 2) 参数覆盖清洗（未声明可覆盖 / 版本中已不存在的覆盖项被丢弃并提示）
  const { params: cleanParams, dropped } = normalizeParams(version, params);

  if (errors.length) return { ok: false, errors, dropped };

  // 3) 生成具体约束（稳定 id：升级沿用旧约束 id；新键追加）
  const oldById = new Map((existing?.constraintIds || []).map((cid) => {
    const c = (model.constraints || []).find((x) => x.id === cid && x.tpl?.instanceId === existing?.id);
    return c ? [c.tpl.key, c] : [cid, null];
  }));
  const usedIds = new Set((model.constraints || []).map((c) => c.id));
  const cidOf = (key) => {
    const old = oldById.get(key);
    if (old) return old.id;
    let id = `${cidPrefix}_${key}`;
    let n = 2;
    while (usedIds.has(id)) id = `${cidPrefix}_${key}_${n++}`;
    usedIds.add(id);
    return id;
  };
  const constraints = instantiateConstraints(version, mapping, cleanParams, {
    instanceId, templateId: template.id, pin, cidOf,
  });

  // 4) 在模型副本上做 新增/替换/删除
  const draft = structuredClone(model);
  const newByKey = new Map(constraints.map((c) => [c.tpl.key, c]));
  const oldKeyOfCid = new Map();
  for (const cid of existing?.constraintIds || []) {
    const oc = draft.constraints.find((x) => x.id === cid && x.tpl?.instanceId === existing?.id);
    if (oc) oldKeyOfCid.set(oc.id, oc.tpl.key);
  }
  const added = [], replaced = [], removed = [], kept = [];
  // 替换 / 保留 / 新增
  const nextConstraints = [];
  for (const oc of draft.constraints) {
    if (existing && oc.tpl?.instanceId === existing.id) {
      const key = oc.tpl.key;
      const nc = newByKey.get(key);
      if (nc) {
        const changed = !sameConstraint(oc, nc);
        nextConstraints.push(nc);
        (changed ? replaced : kept).push(changeItem(oc, nc));
        newByKey.delete(key);
      } else {
        removed.push({ id: oc.id, key, kind: oc.kind, label: '' });
      }
    } else {
      nextConstraints.push(oc);
    }
  }
  for (const nc of newByKey.values()) {
    nextConstraints.push(nc);
    added.push({ id: nc.id, key: nc.tpl.key, kind: nc.kind });
  }
  draft.constraints = nextConstraints;

  // 5) 结构校验（重复 id / 悬空引用等）
  const structural = validate(draft).errors.map((message) => ({ code: 'invalid-model', message }));
  errors.push(...structural);

  // 6) 环检测（模板自身无环，但与实例外既有约束组合后可能成环）
  let cycle = null;
  if (!structural.length) {
    cycle = findCycle(draft.constraints);
    if (cycle) {
      errors.push({
        code: 'cycle',
        message: `应用后存在循环依赖：${cycle.nodeIds.map((id) => rectById.get(id)?.name || id).join(' → ')}（闭环约束 ${cycle.cids.join('、')}）`,
        detail: { nodeIds: cycle.nodeIds, cids: cycle.cids },
      });
    }
  }

  // 7) 求解 + 越界（求解前后各查一次，与合并同一管线）
  let solvedModel = null, report = null;
  if (!errors.some((e) => ['cycle', 'invalid-model'].includes(e.code))) {
    const res = solveDraftBounds(draft);
    if (res.errors.length) {
      errors.push(...res.errors);
    } else {
      solvedModel = res.model; report = res.report;
    }
  }

  const ok = errors.length === 0;
  return {
    ok, errors, constraints,
    changes: {
      added: added.map((x) => ({ ...x })),
      replaced: replaced.map((x) => ({ ...x, label: '' })),
      removed,
      kept: kept.map((x) => ({ ...x, label: '' })),
    },
    model: solvedModel, report, cycle,
    params: cleanParams, dropped,
    versionNo: version.no,
  };
}

function changeItem(oc, nc) {
  const fields = [];
  for (const k of [...new Set([...Object.keys(oc), ...Object.keys(nc)])].sort()) {
    if (['id', 'tpl'].includes(k)) continue;
    if (JSON.stringify(oc[k]) !== JSON.stringify(nc[k])) fields.push({ field: k, from: oc[k], to: nc[k] });
  }
  return { id: nc.id, key: nc.tpl.key, kind: nc.kind, fields, from: oc, to: nc };
}

function sameConstraint(a, b) {
  const strip = (c) => {
    const { id, tpl, ...rest } = c;
    return rest;
  };
  // pin 不影响几何语义（只是“固定旧版本”标记），比对时取同值
  const tb = b.tpl ? { ...b.tpl, pin: a.tpl?.pin ?? false } : b.tpl;
  return JSON.stringify(strip(a)) === JSON.stringify(strip({ ...b, tpl: tb }));
}

/** 规范化 + 求解 + 求解前后越界检查（与 merge.finalizeMergeModel 同语义）。 */
function solveDraftBounds(raw) {
  const errors = [];
  const cw = raw.canvas?.w, ch = raw.canvas?.h;
  const bounds = (m) => {
    const out = [];
    for (const r of m.rects) {
      if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) || !(r.w > 0) || !(r.h > 0)) continue;
      if (r.x < -1e-6 || r.y < -1e-6 || r.x + r.w > cw + 1e-6 || r.y + r.h > ch + 1e-6) {
        out.push({ code: 'out-of-bounds', message: `矩形「${r.name || r.id}」应用后超出画布（${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}，画布 ${cw}×${ch}）`, detail: { id: r.id } });
      }
    }
    return out;
  };
  errors.push(...bounds(raw));
  if (errors.length) return { errors, model: null, report: null };
  // normalize 排序（保持约束对象，含 tpl 标签）
  const model = normalizeKeepTags(raw);
  const report = solve(model, null);
  for (const r of model.rects) {
    const p = report.rects[r.id];
    if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
  }
  const after = bounds(model);
  if (after.length) return { errors: after, model: null, report: null };
  return { errors: [], model, report };
}

/** 规范化求解：复用 model.normalize（它原样保留约束上的 tpl 实例标签）。 */
export function normalizeKeepTags(raw) {
  return modelNormalize(structuredClone(raw));
}

/* ---------------- 版本间升级差异 ---------------- */

/**
 * 两个模板版本的约束模板差异（按键匹配）：新增 / 删除 / 参数默认值变化 / 可覆盖性变化。
 */
export function diffTemplateVersions(fromV, toV) {
  const a = new Map((fromV?.constraints || []).map((c) => [c.key, c]));
  const b = new Map((toV?.constraints || []).map((c) => [c.key, c]));
  const added = [], removed = [], changed = [];
  for (const [key, cB] of b) {
    if (!a.has(key)) { added.push({ key, kind: cB.kind }); continue; }
    const cA = a.get(key);
    const fields = [];
    for (const f of ['priority', 'enabled', 'gap', 'margin', 'w', 'h', 'edge', 'otherEdge', 'side', 'axis']) {
      if (JSON.stringify(cA[f]) !== JSON.stringify(cB[f])) fields.push({ field: f, from: cA[f], to: cB[f] });
    }
    // overridable 声明变化
    const ov = [];
    for (const f of new Set([...Object.keys(cA.overrides || {}), ...Object.keys(cB.overrides || {})])) {
      const oa = cA.overrides?.[f], ob = cB.overrides?.[f];
      if (JSON.stringify(oa?.value) !== JSON.stringify(ob?.value) || !!oa?.overridable !== !!ob?.overridable) {
        ov.push({ field: f, from: oa || null, to: ob || null });
      }
    }
    // 跟随/锚点槽位变化
    for (const f of ['rect', 'other']) {
      if (JSON.stringify(cA[f]) !== JSON.stringify(cB[f])) fields.push({ field: f, from: cA[f], to: cB[f] });
    }
    if (fields.length || ov.length) changed.push({ key, kind: cB.kind, fields, overrides: ov });
  }
  for (const [key, cA] of a) if (!b.has(key)) removed.push({ key, kind: cA.kind });
  const byKey = (x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  added.sort(byKey); removed.sort(byKey); changed.sort(byKey);
  const slotAdded = (toV?.slots || []).filter((s) => !(fromV?.slots || []).some((x) => x.id === s.id));
  const slotRemoved = (fromV?.slots || []).filter((s) => !(toV?.slots || []).some((x) => x.id === s.id));
  return {
    fromNo: fromV?.no ?? null, toNo: toV?.no ?? null,
    added, removed, changed,
    slots: { added: slotAdded, removed: slotRemoved },
    identical: !added.length && !removed.length && !changed.length && !slotAdded.length && !slotRemoved.length,
  };
}

/**
 * 升级时把旧实例的参数覆盖迁移到新版本：
 * 键与字段仍存在且仍 overridable 才保留；否则进入 dropped 并提示。
 * 若新版本新增了槽位，映射缺失，交由 validateMapping 报 slot-missing。
 */
export function migrateParams(oldVersion, newVersion, oldParams, oldMapping) {
  const oldC = new Map((oldVersion?.constraints || []).map((c) => [c.key, c]));
  const params = {};
  const dropped = [];
  const mapping = { ...(oldMapping || {}) };
  for (const c of newVersion.constraints) {
    const prev = oldParams?.[c.key];
    if (!prev) continue;
    if (!oldC.has(c.key)) continue;
    const kept = {};
    for (const [field, value] of Object.entries(prev)) {
      const spec = c.overrides?.[field];
      if (spec?.overridable) kept[field] = coerceParam(c.kind, field, value);
      else dropped.push({ key: c.key, field });
    }
    if (Object.keys(kept).length) params[c.key] = kept;
  }
  return { params, dropped, mapping };
}

/* ---------------- 实例链接状态派生（undo/redo 一致性的关键） ---------------- */

/**
 * 由【当前模型约束上的 tpl 标签】派生每个实例在当前分支上的链接状态。
 * 返回 Map<instanceId, {status:'linked'|'partial'|'absent', pinned, constraintIds, versionNo, templateId}>。
 *  - linked：实例最近一次生效的全部约束都在、标签一致；
 *  - partial：只有部分约束在（例如用户在模型里手动删了一条）；
 *  - absent：当前模型没有任何该实例的约束（未应用到本分支 / 被 detach / undo 回到应用之前）。
 */
export function deriveInstanceLinks(instances, model) {
  const out = new Map();
  for (const ins of instances) {
    const mine = (model.constraints || []).filter((c) => c.tpl?.instanceId === ins.id);
    const ids = mine.map((c) => c.id);
    let status = 'absent';
    if (mine.length) {
      const expected = new Set(ins.constraintIds || ids);
      const allPresent = mine.every((c) => expected.has(c.id))
        && [...expected].every((id) => ids.includes(id));
      status = allPresent ? 'linked' : 'partial';
    }
    const pinned = mine.some((c) => c.tpl?.pin);
    const versionNos = new Set(mine.map((c) => c.tpl?.versionNo));
    out.set(ins.id, {
      status, pinned,
      constraintIds: ids,
      versionNo: versionNos.size === 1 ? [...versionNos][0] : (versionNos.size ? 'mixed' : ins.versionNo),
      templateId: ins.templateId,
    });
  }
  return out;
}

/**
 * 由【当前 head 模型】派生实例【记录】应有的 status（'linked' | 'detached'）。
 *
 * 记录 status 是文档级状态，但几何的 tpl 标签随审计事件链移动；undo/redo / 切换分支 /
 * 刷新装载后必须以当前 head 上的标签为准重算，否则会出现“画布链接已恢复、记录仍是
 * detached 墓碑”的撕裂（撤销脱离后实例不进升级预览、不能再次脱离等）。
 *
 *  - 模型里还有带本实例标签的约束 -> linked（含 partial：仍挂在模板上，可继续升级/脱离）；
 *  - 标签全无、但实例约束 id 仍作为【普通约束】留在模型里 -> detached（脱离的语义：
 *    链接移除、几何约束保留；redo 脱离时由此重新得到 detached）；
 *  - 标签与普通约束都不在当前 head（未应用到本分支 / undo 回到应用之前）-> 保持记录
 *    原状态：无法仅凭当前模型区分“从未应用”与“已脱离且约束也被删”，保持墓碑不复活。
 */
export function deriveInstanceRecordStatus(ins, model) {
  const constraints = model?.constraints || [];
  const tagged = constraints.some((c) => c.tpl?.instanceId === ins.id);
  if (tagged) return 'linked';
  const known = new Set(ins.constraintIds || []);
  const plainKept = known.size && constraints.some((c) => known.has(c.id) && !c.tpl?.instanceId);
  if (plainKept) return 'detached';
  return ins.status === 'detached' ? 'detached' : 'linked';
}

/**
 * 批量对齐全部实例记录的 status 到给定 head 模型（纯函数，返回 {instances, changed}）。
 * status 发生翻转时把 updatedAt 推进到 now（不小于原值），使多页签 / 服务端合流时
 * “已撤销脱离（linked）”能压过旧 detached 墓碑，而不会被旧副本按墓碑规则复活。
 */
export function reconcileInstanceStatuses(instances, model, { now = Date.now() } = {}) {
  let changed = false;
  const next = (instances || []).map((ins0) => {
    const status = deriveInstanceRecordStatus(ins0, model);
    if (status === ins0.status) return ins0;
    changed = true;
    return { ...ins0, status, updatedAt: Math.max(ins0.updatedAt || 0, now) + 1 };
  });
  return { instances: next, changed };
}

/* ---------------- 清洗 / 合流（持久化 & 多页签） ---------------- */

/** 载入时清洗模板列表（结构不完整丢弃；版本只读、按 no 去重保留第一条）。 */
export function sanitizeTemplates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t0 of list) {
    if (!t0 || typeof t0 !== 'object' || typeof t0.id !== 'string' || typeof t0.name !== 'string') continue;
    if (seen.has(t0.id)) continue;
    let draft = null;
    if (t0.draft && typeof t0.draft === 'object') {
      draft = normalizeDraft(t0.draft);
      if (validateDraft(draft).length) draft = normalizeDraft(t0.draft); // 保留但后续发布再拦
    }
    const versionNos = new Set();
    const versions = [];
    for (const v of Array.isArray(t0.versions) ? t0.versions : []) {
      if (!v || typeof v !== 'object' || !Number.isInteger(v.no)) continue;
      if (versionNos.has(v.no)) continue; // 版本不可改写：同 no 保留第一条
      const vv = normalizeDraft({ slots: v.slots, constraints: v.constraints });
      if (validateDraft(vv).length) continue;
      versionNos.add(v.no);
      versions.push({ no: v.no, createdAt: Number.isFinite(v.createdAt) ? v.createdAt : 0, ...vv });
    }
    versions.sort((a, b) => a.no - b.no);
    seen.add(t0.id);
    out.push({
      id: t0.id,
      name: t0.name,
      createdAt: Number.isFinite(t0.createdAt) ? t0.createdAt : 0,
      updatedAt: Number.isFinite(t0.updatedAt) ? t0.updatedAt : 0,
      draftRev: Number.isInteger(t0.draftRev) && t0.draftRev >= 0 ? t0.draftRev : 0,
      draft,
      versions,
      publishedNo: Number.isInteger(t0.publishedNo) ? t0.publishedNo : versions.length,
    });
  }
  return out;
}

/** 载入时清洗实例列表。 */
export function sanitizeInstances(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const i0 of list) {
    if (!i0 || typeof i0 !== 'object' || typeof i0.id !== 'string' || typeof i0.templateId !== 'string') continue;
    if (seen.has(i0.id)) continue;
    seen.add(i0.id);
    out.push({
      id: i0.id,
      templateId: i0.templateId,
      templateName: String(i0.templateName || ''),
      versionNo: Number.isInteger(i0.versionNo) ? i0.versionNo : 0,
      mapping: normalizeMapping(i0.mapping),
      params: i0.params && typeof i0.params === 'object' ? i0.params : {},
      constraintIds: Array.isArray(i0.constraintIds) ? [...i0.constraintIds] : [],
      mapHash: typeof i0.mapHash === 'string' ? i0.mapHash : '',
      status: i0.status === 'detached' ? 'detached' : 'linked',
      pinned: i0.pinned && typeof i0.pinned === 'object' ? i0.pinned : {},
      history: Array.isArray(i0.history) ? i0.history : [],
      lastError: i0.lastError || null,
      createdAt: Number.isFinite(i0.createdAt) ? i0.createdAt : 0,
      updatedAt: Number.isFinite(i0.updatedAt) ? i0.updatedAt : 0,
    });
  }
  return out;
}

/**
 * 模板按 id 并集合流；同 id 的【草稿】以 draftRev 更大者整体胜出（乐观并发语义），
 * 已发布版本按 no 并集且绝不改写（同 no 保留先到的一份）。
 */
export function mergeTemplates(serverList, clientList) {
  const byId = new Map();
  const order = [];
  const put = (t, fromClient) => {
    if (!byId.has(t.id)) { byId.set(t.id, structuredClone(t)); order.push(t.id); return; }
    const ex = byId.get(t.id);
    // 改名随更新的草稿一起走（仅客户端侧草稿更新会改名）；服务端旧名不复活新名
    if (fromClient && (t.draftRev || 0) >= (ex.draftRev || 0) && typeof t.name === 'string') ex.name = t.name;
    // 版本：no 并集，已存在的 no 绝不改写
    const nos = new Map(ex.versions.map((v) => [v.no, v]));
    for (const v of t.versions) if (!nos.has(v.no)) nos.set(v.no, v);
    ex.versions = [...nos.values()].sort((a, b) => a.no - b.no);
    ex.publishedNo = Math.max(ex.publishedNo || 0, ...ex.versions.map((v) => v.no), 0);
    // 草稿：draftRev 更大者整体胜出
    if ((t.draftRev || 0) > (ex.draftRev || 0)) { ex.draft = t.draft; ex.draftRev = t.draftRev; }
    ex.updatedAt = Math.max(ex.updatedAt || 0, t.updatedAt || 0);
    ex.createdAt = ex.createdAt || t.createdAt;
  };
  for (const t of serverList || []) if (t && typeof t.id === 'string') put(t, false);
  for (const t of clientList || []) if (t && typeof t.id === 'string') put(t, true);
  return order.map((id) => byId.get(id));
}

/** 实例按 id 并集；同 id 以 updatedAt 更新者整体胜出，history 按时间并集，detached 墓碑不被旧副本复活。 */
export function mergeInstances(serverList, clientList) {
  const byId = new Map();
  const order = [];
  for (const ins of [...(serverList || []), ...(clientList || [])]) {
    if (!ins || typeof ins.id !== 'string') continue;
    if (!byId.has(ins.id)) { byId.set(ins.id, structuredClone(ins)); order.push(ins.id); continue; }
    const ex = byId.get(ins.id);
    const win = (ins.updatedAt || 0) >= (ex.updatedAt || 0) ? ins : ex;
    const merged = { ...ex, ...win };
    // detached 墓碑：一旦任一副本为 detached，不被更旧的 linked 复活（以 updatedAt 已覆盖，这里再兜底）
    if (ex.status === 'detached' || ins.status === 'detached') {
      const det = ex.status === 'detached' ? ex : ins;
      if ((det.updatedAt || 0) >= (merged.updatedAt || 0)) merged.status = 'detached';
    }
    const hist = new Map();
    for (const h of [...(ex.history || []), ...(ins.history || [])]) {
      const k = `${h.t}|${h.action}|${h.fromNo || ''}|${h.toNo || ''}`;
      hist.set(k, h);
    }
    merged.history = [...hist.values()].sort((a, b) => (a.t - b.t) || (a.action < b.action ? -1 : 1));
    byId.set(ins.id, merged);
  }
  return order.map((id) => byId.get(id));
}

/* ---------------- 小工具 ---------------- */

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 供 UI / 报告使用：模板约束的简短中文描述（槽位名）。 */
export function tplConstraintLabel(c, slotName = (id) => id) {
  const edgeWord = (axis, e) => e === 'mid' ? '中' : { x: { l: '左', r: '右' }, y: { t: '顶', b: '底' } }[axis][e];
  switch (c.kind) {
    case 'snap':
      return `贴齐 ${slotName(c.rect)}.${edgeWord(c.axis, c.edge)} ↔ ${slotName(c.other)}.${edgeWord(c.axis, c.otherEdge)}${c.overrides?.gap?.value ? ` (偏移 ${c.overrides.gap.value})` : ''}`;
    case 'minGap':
      return `最小间距 ${slotName(c.rect)} ${({ left: '在…左侧', right: '在…右侧', above: '在…上方', below: '在…下方' })[c.side]} ${slotName(c.other)} ≥ ${c.overrides?.gap?.value ?? 0}`;
    case 'contain':
      return `画布包含 ${slotName(c.rect)}（边距 ${c.overrides?.margin?.value ?? 0}）`;
    case 'lock':
      return `锁定尺寸 ${slotName(c.rect)} (${c.overrides?.w?.value}×${c.overrides?.h?.value})`;
    default:
      return c.key;
  }
}

export { constraintAxis, PARAM_FIELDS };
