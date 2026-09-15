/*
 * 文档模型：纯数据 + 结构校验。
 * 坐标全部使用固定的逻辑坐标系（默认 1000×700），
 * 视图缩放只发生在 SVG viewBox，与模型无关 —— 窗口缩放不改变任何数据。
 */

export const SCHEMA_VERSION = 1;
export const DEFAULT_CANVAS = { w: 1000, h: 700 };

export function uid(prefix = 'id') {
  // 时间序 + 随机后缀；同毫秒内自增兜底
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${t}${r}`;
}

export function rectId() { return uid('r'); }
export function constraintId() { return uid('c'); }

export function newRect(x = 80, y = 80, w = 140, h = 90, name = '') {
  return { id: rectId(), name, x, y, w, h };
}

export function newSnap(rect, other, axis = 'x', edge = 'l', otherEdge = 'r', gap = 0, priority = 50) {
  return { id: constraintId(), kind: 'snap', rect, other, axis, edge, otherEdge, gap: num(gap), priority, enabled: true };
}
export function newMinGap(rect, other, side = 'right', gap = 20, priority = 40) {
  return { id: constraintId(), kind: 'minGap', rect, other, side, gap: num(gap), priority, enabled: true };
}
export function newContain(rect, margin = 0, priority = 30) {
  return { id: constraintId(), kind: 'contain', rect, margin: num(margin), priority, enabled: true };
}
export function newLock(rect, w, h, priority = 60) {
  return { id: constraintId(), kind: 'lock', rect, w: num(w), h: num(h), priority, enabled: true };
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

/** 规范化模板实例标签（非法标签直接丢弃，避免脏数据进入求解 / 指纹）。 */
function normalizeTplTag(t) {
  if (!t || typeof t !== 'object') return undefined;
  if (typeof t.instanceId !== 'string' || typeof t.templateId !== 'string') return undefined;
  const out = {
    instanceId: t.instanceId,
    templateId: t.templateId,
    versionNo: Number.isInteger(t.versionNo) ? t.versionNo : 0,
    key: typeof t.key === 'string' ? t.key : '',
    pin: t.pin === true,
  };
  return out;
}

const EDGES = new Set(['l', 'r', 't', 'b', 'mid']);
const SIDES = new Set(['left', 'right', 'above', 'below']);

/** 结构校验；返回 {errors:[...]}。语义级环检测由 solver.findCycle 负责。 */
export function validate(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return { errors: ['模型为空'] };
  const { canvas, rects, constraints } = model;
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) errors.push('画布尺寸非法');
  const ids = new Set();
  for (const r of rects || []) {
    if (!r.id || ids.has(r.id)) errors.push(`矩形 id 重复或缺失: ${r.id}`);
    ids.add(r.id);
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(r[k])) errors.push(`矩形 ${r.id || '?'} 的 ${k} 非数字`);
    }
    if (r.w <= 0 || r.h <= 0) errors.push(`矩形 ${r.id || '?'} 宽高必须为正`);
  }
  for (const c of constraints || []) {
    const tag = `约束 ${c.id || '?'}(${c.kind || '?'})`;
    if (!c.id) errors.push(`${tag} 缺少 id`);
    if (!ids.has(c.rect)) { errors.push(`${tag} 引用了不存在的矩形 ${c.rect}`); continue; }
    if (!Number.isInteger(c.priority)) errors.push(`${tag} 优先级必须是整数`);
    if (c.kind === 'snap') {
      if (!ids.has(c.other)) errors.push(`${tag} 引用了不存在的矩形 ${c.other}`);
      if (!['x', 'y'].includes(c.axis)) errors.push(`${tag} 轴非法`);
      if (!EDGES.has(c.edge) || !EDGES.has(c.otherEdge)) errors.push(`${tag} 边非法`);
      else if (c.axis === 'x' && ['t', 'b'].includes(c.edge)) errors.push(`${tag} x 轴不能用 t/b 边`);
      else if (c.axis === 'y' && ['l', 'r'].includes(c.edge)) errors.push(`${tag} y 轴不能用 l/r 边`);
      if (c.rect === c.other && c.edge === c.otherEdge) errors.push(`${tag} 自贴齐无意义`);
    } else if (c.kind === 'minGap') {
      if (!ids.has(c.other)) errors.push(`${tag} 引用了不存在的矩形 ${c.other}`);
      if (!SIDES.has(c.side)) errors.push(`${tag} 方向非法`);
      if (!(num(c.gap) >= 0)) errors.push(`${tag} 间距不能为负`);
    } else if (c.kind === 'contain') {
      if (!(num(c.margin) >= 0)) errors.push(`${tag} 边距不能为负`);
    } else if (c.kind === 'lock') {
      if (!(num(c.w) > 0) || !(num(c.h) > 0)) errors.push(`${tag} 锁定尺寸非法`);
    } else {
      errors.push(`${tag} 类型未知`);
    }
  }
  return { errors };
}

/** 规范化（排序/补字段/取整），保证持久化字节稳定。 */
export function normalize(model) {
  const rects = (model.rects || []).map((r) => ({
    id: r.id, name: String(r.name || ''),
    x: round3(num(r.x)), y: round3(num(r.y)), w: round3(num(r.w)), h: round3(num(r.h)),
  })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const constraints = (model.constraints || []).map((c) => {
    const base = { id: c.id, kind: c.kind, rect: c.rect, priority: Math.round(num(c.priority)), enabled: c.enabled !== false };
    // 模板实例标签（实例链接/固定/版本号）作为约束的可选一等字段随规范化保留
    if (c.tpl && typeof c.tpl === 'object') base.tpl = normalizeTplTag(c.tpl);
    if (c.kind === 'snap') return { ...base, other: c.other, axis: c.axis, edge: c.edge, otherEdge: c.otherEdge, gap: round3(num(c.gap)) };
    if (c.kind === 'minGap') return { ...base, other: c.other, side: c.side, gap: round3(num(c.gap)) };
    if (c.kind === 'contain') return { ...base, margin: round3(num(c.margin)) };
    return { ...base, w: round3(num(c.w)), h: round3(num(c.h)) }; // lock
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    version: SCHEMA_VERSION,
    canvas: { w: round3(num(model.canvas?.w ?? DEFAULT_CANVAS.w)), h: round3(num(model.canvas?.h ?? DEFAULT_CANVAS.h)) },
    rects, constraints,
  };
}

/** 初始演示模型：贴齐 / 最小间距 / 包含 / 锁定 各一，全部满足，无环。 */
export function seedModel() {
  const a = newRect(120, 120, 160, 100, '卡片A');
  const b = newRect(420, 120, 120, 100, '标签B');
  const c = newRect(120, 420, 200, 80, '按钮组C');
  const d = newRect(700, 400, 120, 120, '锁定D');
  return normalize({
    canvas: { ...DEFAULT_CANVAS },
    rects: [a, b, c, d],
    constraints: [
      newSnap(b.id, a.id, 'x', 'l', 'r', 40, 50),      // B 左边距 A 右边 40
      newSnap(b.id, a.id, 'y', 't', 't', 0, 50),       // B 与 A 顶对齐
      newMinGap(c.id, a.id, 'below', 30, 40),           // C 在 A 下方 ≥30
      newContain(a.id, 20, 30),
      newContain(b.id, 20, 30),
      newContain(c.id, 20, 30),
      newLock(d.id, d.w, d.h, 60),
      newContain(d.id, 20, 30),
    ],
  });
}
